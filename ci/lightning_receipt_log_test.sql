-- F1 PR 1 (20261003050000): receipt log, record-only.
--   A. Backfill from the real pre-migration history: 20261003010000 live,
--      then 20261003030000 archiving and restoring, then this migration.
--   B. settle_breez_payment() is byte-identical before and after.
--   C. record_lightning_receipt(): recorded / duplicate / updated / conflict,
--      payload allowlist and size enforced, payments never touched.
--   D. Grants: anon and authenticated cannot read, write or execute;
--      service_role can only execute; RLS on, no policies.
-- Runs inside BEGIN/ROLLBACK.
\set ON_ERROR_STOP on
begin;

create temp table t_md5(label text primary key, md5 text);
insert into t_md5
select 'settle_initial', md5(pg_get_functiondef('public.settle_breez_payment(text, text, bigint)'::regprocedure));

-- ---------- A. rebuild the pre-migration state ----------
drop function if exists public.record_lightning_receipt(text, text, text, bigint, bigint, bigint, jsonb, text);
drop function if exists public.note_lightning_receipt_legacy_outcome(text, text);
drop table if exists public.lightning_receipts;
drop table if exists public.payment_invoices;
drop table if exists public.receipt_coverage_gaps;

insert into auth.users(id, email) values ('55555555-0000-0000-0000-000000000001', 'receipt-log@test.invalid');
insert into public.payments(id, user_id, invoice_ref, lightning_invoice, amount_requested, amount_sat, btc_usd_rate, status, expires_at)
values
  ('55555555-1111-0000-0000-000000000001', '55555555-0000-0000-0000-000000000001', repeat('a1', 32), 'lnbcrt1p1', 10.00, 10000, 100000, 'settled', now() + interval '1 hour'),
  ('55555555-1111-0000-0000-000000000002', '55555555-0000-0000-0000-000000000001', 'legacy-btcpay-invoice-1', 'lnbcrt1p2', 5.00, 5000, 100000, 'expired', now()),
  ('55555555-1111-0000-0000-000000000003', '55555555-0000-0000-0000-000000000001', null, null, 7.00, null, null, 'new', now() + interval '1 hour');

-- History: the reconciliation settlement was live and stored amounts.
\i supabase/migrations/20261003010000_lightning_receipt_reconciliation.sql
insert into public.webhook_events(delivery_id, invoice_id, event_type, receipt_amount_sat, settlement_outcome, received_at)
values
  ('breez:rl-archive-amount', repeat('a1', 32), 'breez.payment_received', 9000, 'underpaid', now() - interval '2 days'),
  ('breez:rl-archive-nohash', null, 'breez.payment_received', 500, 'unknown', now() - interval '2 days'),
  ('breez:rl-archive-noamount', repeat('b2', 32), 'breez.payment_received', null, 'unknown', now() - interval '2 days');
-- Then it was rolled back (archive + restore), as production did.
\i supabase/migrations/20261003030000_restore_lightning_receipt_behavior.sql

-- After the restore: deliveries with no amount anywhere, and a non-Breez row.
insert into public.webhook_events(delivery_id, invoice_id, event_type, received_at)
values
  ('breez:rl-webhook-only', repeat('a1', 32), 'breez.payment_received', now() - interval '1 day'),
  ('breez:rl-webhook-unknown', repeat('c3', 32), 'breez.payment_received', now() - interval '1 day'),
  ('btcpay:rl-not-breez', 'inv-1', 'InvoiceSettled', now() - interval '1 day');

insert into t_md5
select 'settle_before', md5(pg_get_functiondef('public.settle_breez_payment(text, text, bigint)'::regprocedure));
insert into t_md5 select 'payments_before', md5(string_agg(p::text, '|' order by p.id)) from public.payments p;
insert into t_md5 select 'webhooks_before', md5(string_agg(e::text, '|' order by e.id)) from public.webhook_events e;

-- ---------- apply the migration under test (twice: idempotent) ----------
\i supabase/migrations/20261003050000_lightning_receipt_log.sql
create temp table t_counts as
select (select count(*) from public.lightning_receipts) as receipts,
       (select count(*) from public.receipt_coverage_gaps) as gaps,
       (select count(*) from public.payment_invoices) as invoices;
\i supabase/migrations/20261003050000_lightning_receipt_log.sql

do $$
declare
  r record;
  v_settle_initial text; v_settle_before text; v_settle_after text;
begin
  -- B. settle_breez_payment untouched
  select md5 into v_settle_initial from t_md5 where label = 'settle_initial';
  select md5 into v_settle_before from t_md5 where label = 'settle_before';
  select md5(pg_get_functiondef('public.settle_breez_payment(text, text, bigint)'::regprocedure)) into v_settle_after;
  if v_settle_after is distinct from v_settle_before or v_settle_after is distinct from v_settle_initial then
    raise exception 'settle_breez_payment changed: % / % / %', v_settle_initial, v_settle_before, v_settle_after;
  end if;
  if (select md5(string_agg(p::text, '|' order by p.id)) from public.payments p)
     is distinct from (select md5 from t_md5 where label = 'payments_before') then
    raise exception 'migration changed payments';
  end if;
  if (select md5(string_agg(e::text, '|' order by e.id)) from public.webhook_events e)
     is distinct from (select md5 from t_md5 where label = 'webhooks_before') then
    raise exception 'migration changed webhook_events';
  end if;

  -- Idempotent
  if (select count(*) from public.lightning_receipts) is distinct from (select receipts from t_counts)
     or (select count(*) from public.receipt_coverage_gaps) is distinct from (select gaps from t_counts)
     or (select count(*) from public.payment_invoices) is distinct from (select invoices from t_counts) then
    raise exception 're-running the migration changed the backfill';
  end if;

  -- Receipts: exactly the two archive rows with a known amount.
  if (select count(*) from public.lightning_receipts where provider_payment_id like 'rl-%') is distinct from 2 then
    raise exception 'expected 2 backfilled receipts, got %',
      (select count(*) from public.lightning_receipts where provider_payment_id like 'rl-%');
  end if;
  select * into r from public.lightning_receipts where provider_payment_id = 'rl-archive-amount';
  if not found
     or r.payment_hash is distinct from repeat('a1', 32)
     or r.amount_sat is distinct from 9000::bigint
     or r.legacy_outcome is distinct from 'underpaid'
     or r.record_source is distinct from 'backfill_archive'
     or r.state is distinct from 'recorded'
     or r.receive_kind is distinct from 'unknown'
     or r.provider_payload is distinct from jsonb_build_object('id', 'rl-archive-amount', 'amount', '9000', 'paymentHash', repeat('a1', 32)) then
    raise exception 'archive receipt with amount not backfilled faithfully: %', row_to_json(r);
  end if;
  select * into r from public.lightning_receipts where provider_payment_id = 'rl-archive-nohash';
  if not found or r.payment_hash is not null or r.amount_sat is distinct from 500::bigint
     or r.legacy_outcome is distinct from 'unknown' then
    raise exception 'hash-less archive receipt not backfilled faithfully: %', row_to_json(r);
  end if;

  -- Amount-less history never becomes a receipt.
  if exists (select 1 from public.lightning_receipts
              where provider_payment_id in ('rl-archive-noamount', 'rl-webhook-only', 'rl-webhook-unknown', 'rl-not-breez')) then
    raise exception 'a delivery without a known amount became a receipt';
  end if;

  -- Coverage gaps: the archive row without amount and the two webhook-only rows.
  if (select count(*) from public.receipt_coverage_gaps where provider_payment_id like 'rl-%') is distinct from 3 then
    raise exception 'expected 3 coverage gaps, got %',
      (select count(*) from public.receipt_coverage_gaps where provider_payment_id like 'rl-%');
  end if;
  select * into r from public.receipt_coverage_gaps where provider_payment_id = 'rl-archive-noamount';
  if not found or r.source is distinct from 'reconciliation_archive' or r.legacy_outcome is distinct from 'unknown'
     or r.payment_hash is distinct from repeat('b2', 32) or r.gap_status is distinct from 'historical_unresolved'
     or r.matched_payment_id is not null then
    raise exception 'archive gap wrong: %', row_to_json(r);
  end if;
  select * into r from public.receipt_coverage_gaps where provider_payment_id = 'rl-webhook-only';
  if not found or r.source is distinct from 'webhook_events'
     or r.matched_payment_id is distinct from '55555555-1111-0000-0000-000000000001'::uuid
     or r.gap_status is distinct from 'historical_unresolved' then
    raise exception 'webhook gap wrong: %', row_to_json(r);
  end if;
  select * into r from public.receipt_coverage_gaps where provider_payment_id = 'rl-webhook-unknown';
  if not found or r.matched_payment_id is not null or r.source is distinct from 'webhook_events' then
    raise exception 'unmatched webhook gap wrong: %', row_to_json(r);
  end if;
  if exists (select 1 from public.receipt_coverage_gaps
              where provider_payment_id in ('rl-archive-amount', 'rl-archive-nohash', 'rl-not-breez', 'btcpay:rl-not-breez')) then
    raise exception 'a gap was created for a delivery that has a receipt, or for a non-Breez row';
  end if;

  -- payment_invoices: only the payment with a Lightning hash and a bolt11.
  if (select count(*) from public.payment_invoices where payment_id::text like '55555555-1111-%') is distinct from 1 then
    raise exception 'expected 1 payment_invoices row for the fixtures';
  end if;
  select * into r from public.payment_invoices where payment_hash = repeat('a1', 32);
  if not found or r.payment_id is distinct from '55555555-1111-0000-0000-000000000001'::uuid
     or r.bolt11 is distinct from 'lnbcrt1p1' or r.amount_sat is distinct from 10000::bigint
     or r.source is distinct from 'backfill_payments' or r.attached is distinct from true then
    raise exception 'payment_invoices row wrong: %', row_to_json(r);
  end if;
end $$;

-- ---------- C. record_lightning_receipt behaviour ----------
insert into t_md5 select 'payments_pre_record', md5(string_agg(p::text, '|' order by p.id)) from public.payments p;

do $$
declare v text; r record; v_failed boolean;
begin
  v := public.record_lightning_receipt('rl-live-1', null, 'spark', 2500, 0, 0,
         '{"id":"rl-live-1","amount":"2500","detailsType":"spark"}'::jsonb, 'event');
  if v is distinct from 'recorded' then raise exception 'first record: %', v; end if;
  v := public.record_lightning_receipt('rl-live-1', null, 'spark', 2500, 0, 0, '{"id":"rl-live-1"}'::jsonb, 'catch_up');
  if v is distinct from 'duplicate' then raise exception 'repeat record: %', v; end if;
  v := public.record_lightning_receipt('rl-live-1', repeat('D4', 32), 'lightning', 2500, 0, 1700000000,
         '{"id":"rl-live-1","paymentHash":"x"}'::jsonb, 'event');
  if v is distinct from 'updated' then raise exception 'late hash: %', v; end if;
  v := public.record_lightning_receipt('rl-live-1', repeat('d4', 32), 'lightning', 2600, 0, 0, '{}'::jsonb, 'event');
  if v is distinct from 'conflict' then raise exception 'changed amount: %', v; end if;
  select * into r from public.lightning_receipts where provider_payment_id = 'rl-live-1';
  if r.amount_sat is distinct from 2500::bigint or r.payment_hash is distinct from repeat('d4', 32)
     or r.seen_count is distinct from 4 or r.conflict_count is distinct from 1
     or r.state is distinct from 'recorded' or r.record_source is distinct from 'event'
     or r.provider_completed_at is distinct from to_timestamp(1700000000) then
    raise exception 'receipt after replays wrong: %', row_to_json(r);
  end if;

  if public.note_lightning_receipt_legacy_outcome('rl-live-1', 'no_hash') is distinct from true then
    raise exception 'legacy outcome not noted';
  end if;
  perform public.note_lightning_receipt_legacy_outcome('rl-live-1', 'duplicate');
  select * into r from public.lightning_receipts where provider_payment_id = 'rl-live-1';
  if r.legacy_outcome is distinct from 'no_hash' or r.last_legacy_outcome is distinct from 'duplicate' then
    raise exception 'legacy outcome columns wrong: %', row_to_json(r);
  end if;
  perform public.record_lightning_receipt('rl-live-2', repeat('e5', 32), 'lightning', 10, 0, 0, '{}'::jsonb, 'event');
  perform public.note_lightning_receipt_legacy_outcome('rl-live-2', 'duplicate');
  perform public.note_lightning_receipt_legacy_outcome('rl-live-2', 'settled');
  perform public.note_lightning_receipt_legacy_outcome('rl-live-2', 'duplicate');
  select * into r from public.lightning_receipts where provider_payment_id = 'rl-live-2';
  if r.legacy_outcome is distinct from 'settled' or r.last_legacy_outcome is distinct from 'duplicate' then
    raise exception 'a duplicate noted first must not hide the real outcome: %', row_to_json(r);
  end if;
  if public.note_lightning_receipt_legacy_outcome('rl-missing', 'settled') is distinct from false then
    raise exception 'noting a missing receipt should return false';
  end if;

  -- Payload allowlist and limits are enforced by the table itself.
  foreach v in array array[
    '{"id":"x","preimage":"00"}',
    '{"id":"x","mnemonic":"abandon abandon"}',
    '{"id":"x","invoice":"lnbc1"}',
    '{"id":"x","details":{"type":"lightning"}}',
    '{"id":"x","amount":["1"]}',
    '[1,2]',
    json_build_object('id', repeat('z', 5000))::text
  ] loop
    v_failed := false;
    begin
      perform public.record_lightning_receipt('rl-bad-payload', null, 'spark', 1, 0, 0, v::jsonb, 'event');
    exception when check_violation then v_failed := true;
    end;
    if not v_failed then raise exception 'payload accepted but must be refused: %', left(v, 80); end if;
  end loop;

  v_failed := false;
  begin perform public.record_lightning_receipt('rl-bad-src', null, 'spark', 1, 0, 0, '{}'::jsonb, 'backfill_archive');
  exception when raise_exception then v_failed := true; end;
  if not v_failed then raise exception 'invalid source accepted'; end if;
  v_failed := false;
  begin perform public.record_lightning_receipt('rl-neg', null, 'spark', -1, 0, 0, '{}'::jsonb, 'event');
  exception when check_violation then v_failed := true; end;
  if not v_failed then raise exception 'negative amount accepted'; end if;
  v_failed := false;
  begin perform public.note_lightning_receipt_legacy_outcome('rl-live-1', 'credited');
  exception when raise_exception then v_failed := true; end;
  if not v_failed then raise exception 'invalid legacy outcome accepted'; end if;
  v_failed := false;
  begin
    update public.lightning_receipts set state = 'settled' where provider_payment_id = 'rl-live-1';
  exception when check_violation then v_failed := true; end;
  if not v_failed then raise exception 'state other than recorded accepted'; end if;

  if (select md5(string_agg(p::text, '|' order by p.id)) from public.payments p)
     is distinct from (select md5 from t_md5 where label = 'payments_pre_record') then
    raise exception 'recording changed payments';
  end if;
end $$;

-- ---------- D. grants, RLS, SECURITY DEFINER shape ----------
do $$
declare
  t text; role_name text; priv text; fn regprocedure;
begin
  foreach t in array array['public.lightning_receipts', 'public.payment_invoices', 'public.receipt_coverage_gaps'] loop
    if not (select relrowsecurity from pg_class where oid = t::regclass) then
      raise exception '% has RLS off', t;
    end if;
    if exists (select 1 from pg_policies where schemaname || '.' || tablename = t) then
      raise exception '% has a policy', t;
    end if;
    foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
      foreach priv in array array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'] loop
        if has_table_privilege(role_name, t, priv) then
          raise exception '% has % on %', role_name, priv, t;
        end if;
      end loop;
    end loop;
    if exists (
      select 1 from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
       where c.oid = t::regclass and a.grantee = 0
    ) then
      raise exception 'PUBLIC has privileges on %', t;
    end if;
  end loop;

  foreach fn in array array[
    'public.record_lightning_receipt(text, text, text, bigint, bigint, bigint, jsonb, text)'::regprocedure,
    'public.note_lightning_receipt_legacy_outcome(text, text)'::regprocedure
  ] loop
    if has_function_privilege('anon', fn, 'execute') or has_function_privilege('authenticated', fn, 'execute') then
      raise exception 'anon/authenticated can execute %', fn;
    end if;
    if exists (
      select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       where p.oid = fn and a.grantee = 0
    ) then
      raise exception 'PUBLIC can execute %', fn;
    end if;
    if not has_function_privilege('service_role', fn, 'execute') then
      raise exception 'service_role cannot execute %', fn;
    end if;
    if not (select prosecdef from pg_proc where oid = fn) then
      raise exception '% is not SECURITY DEFINER', fn;
    end if;
    if not exists (select 1 from pg_proc where oid = fn and 'search_path=public' = any(proconfig)) then
      raise exception '% has no pinned search_path', fn;
    end if;
  end loop;
end $$;

-- Behavioural checks as each role.
set local role anon;
do $$
declare v_denied boolean;
begin
  v_denied := false;
  begin perform 1 from public.lightning_receipts limit 1; exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'anon read lightning_receipts'; end if;
  v_denied := false;
  begin perform public.record_lightning_receipt('rl-anon', null, 'spark', 1, 0, 0, '{}'::jsonb, 'event');
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'anon executed record_lightning_receipt'; end if;
end $$;
reset role;

set local role authenticated;
do $$
declare v_denied boolean;
begin
  v_denied := false;
  begin insert into public.lightning_receipts(provider_payment_id, receive_kind, amount_sat, record_source)
        values ('rl-auth', 'spark', 1, 'event');
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'authenticated wrote lightning_receipts'; end if;
  v_denied := false;
  begin perform 1 from public.receipt_coverage_gaps limit 1; exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'authenticated read receipt_coverage_gaps'; end if;
  v_denied := false;
  begin perform 1 from public.payment_invoices limit 1; exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'authenticated read payment_invoices'; end if;
  v_denied := false;
  begin perform public.note_lightning_receipt_legacy_outcome('rl-live-1', 'settled');
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'authenticated executed note_lightning_receipt_legacy_outcome'; end if;
end $$;
reset role;

set local role service_role;
do $$
declare v_denied boolean; v text;
begin
  v := public.record_lightning_receipt('rl-service', null, 'spark', 1, 0, 0, '{}'::jsonb, 'event');
  if v is distinct from 'recorded' then raise exception 'service_role could not record: %', v; end if;
  v_denied := false;
  begin perform 1 from public.lightning_receipts limit 1; exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'service_role read lightning_receipts directly'; end if;
end $$;
reset role;

rollback;
select 'lightning receipt log checks passed' as result;
