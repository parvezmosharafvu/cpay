-- ============================================================
-- P2 item 3 (20261007130000): receipt review queue, flag only
-- ============================================================
-- settle_breez_payment() answers exactly as before and no payment or
-- balance changes because of a flag; underpaid, overpaid, unmatched,
-- paid-twice and no-hash receipts each land in receipt_reviews once
-- (service call and/or sweep); admins list and close them (audited),
-- nobody else can. BEGIN/ROLLBACK.
\set ON_ERROR_STOP on
begin;
create or replace function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
create temp table t_ids(k text primary key, v text);
grant all on t_ids to public;
do $$
declare
  v_user uuid := '7e000000-0000-0000-0000-0000000000f1';
  v_admin uuid := '7e000000-0000-0000-0000-0000000000a1';
  v_link uuid := '7e000000-0000-0000-0000-0000000001f1';
  h1 text := repeat('1', 64); h2 text := repeat('2', 64); h3 text := repeat('3', 64); hx text := repeat('9', 64);
  v_out text; v_bal_before numeric; v_bal_after numeric; r record; n int;
begin
  insert into auth.users(id, email) values (v_user, 'rr-freelancer@test.invalid'), (v_admin, 'rr-admin@test.invalid');
  update profiles set account_status = 'active' where id in (v_user, v_admin);
  update profiles set role = 'admin' where id = v_admin;
  insert into payment_links(id, user_id, slug) values (v_link, v_user, 'rr-link');
  insert into payments(user_id, payment_link_id, amount_requested, status, expires_at, invoice_ref, amount_sat) values
    (v_user, v_link, 10, 'new', now() + interval '1 hour', h1, 1000),
    (v_user, v_link, 20, 'new', now() + interval '1 hour', h2, 2000),
    (v_user, v_link, 30, 'new', now() + interval '1 hour', h3, 3000);
  select available into v_bal_before from get_balance_for(v_user);

  -- underpaid: settlement refuses exactly as before; the flag changes nothing else
  v_out := settle_breez_payment('rr-b1', h1, 900);
  if v_out <> 'underpaid' then raise exception 'settle underpaid answered %', v_out; end if;
  if system_flag_receipt('rr-b1', h1, 900, v_out) is distinct from 'underpaid' then raise exception 'underpaid not flagged'; end if;
  select * into r from payments where invoice_ref = h1;
  if r.status <> 'new' or r.amount_settled is not null then raise exception 'underpaid payment changed: %', r.status; end if;

  -- overpaid: settled for amount_requested only (unchanged), flagged for review
  v_out := settle_breez_payment('rr-b2', h2, 2500);
  if v_out <> 'settled' then raise exception 'settle overpaid answered %', v_out; end if;
  if system_flag_receipt('rr-b2', h2, 2500, v_out) is distinct from 'overpaid' then raise exception 'overpaid not flagged'; end if;
  select * into r from payments where invoice_ref = h2;
  if r.amount_settled <> 20 then raise exception 'overpaid payment credited %', r.amount_settled; end if;

  -- exact payment: no review row
  v_out := settle_breez_payment('rr-b3', h3, 3000);
  if v_out <> 'settled' or system_flag_receipt('rr-b3', h3, 3000, v_out) is not null then raise exception 'exact payment flagged'; end if;

  -- unmatched (no payment for the hash), seen by the sweep first
  v_out := settle_breez_payment('rr-b4', hx, 777);
  if v_out <> 'unknown' then raise exception 'unknown answered %', v_out; end if;
  -- paid twice: a second receipt for an already settled hash
  v_out := settle_breez_payment('rr-b5', h2, 2000);
  if v_out <> 'already_settled' then raise exception 'second receipt answered %', v_out; end if;

  update webhook_events set received_at = now() - interval '5 minutes' where delivery_id like 'breez:rr-%';
  perform system_sweep_receipt_reviews();
  -- new rows: rr-b4 unmatched, rr-b5 already_settled (rr-b1 already flagged; rr-b2/rr-b3 settled, first receipt)
  select count(*) into n from receipt_reviews where provider_payment_id like 'rr-%' and detected_by = 'sweep';
  if n <> 2 then raise exception 'sweep flagged % rr- rows, expected 2', n; end if;
  if (select kind || '/' || detected_by from receipt_reviews where provider_payment_id = 'rr-b4') <> 'unmatched/sweep' then raise exception 'sweep unmatched wrong'; end if;
  if (select kind from receipt_reviews where provider_payment_id = 'rr-b5') <> 'already_settled' then raise exception 'sweep paid-twice wrong'; end if;
  if system_sweep_receipt_reviews() <> 0 then raise exception 'sweep is not idempotent'; end if;
  -- the service call refines the sweep row with the amount
  perform system_flag_receipt('rr-b4', hx, 777, 'unknown');
  select * into r from receipt_reviews where provider_payment_id = 'rr-b4';
  if r.detected_by <> 'service' or r.received_sat <> 777 or r.seen_count <> 2 then raise exception 'service did not refine sweep row'; end if;

  -- receipts with no payment hash are flagged once, counted on re-sight
  perform system_flag_receipt('rr-b6', null, 100, 'no_hash');
  perform system_flag_receipt('rr-b6', null, 100, 'no_hash');
  if (select seen_count from receipt_reviews where provider_payment_id = 'rr-b6') <> 2 then raise exception 'no_hash not deduplicated'; end if;
  -- duplicate / ignored outcomes never flag
  if system_flag_receipt('rr-b7', h1, 1, 'duplicate') is not null then raise exception 'duplicate flagged'; end if;

  select available into v_bal_after from get_balance_for(v_user);
  -- Only the two settled payments (20 + 30, less the platform fee) were
  -- credited, each for amount_requested; flags added nothing.
  if (select count(*) from payments where user_id = '7e000000-0000-0000-0000-0000000000f1' and status = 'settled') <> 2
     or (select sum(amount_settled) from payments where user_id = '7e000000-0000-0000-0000-0000000000f1' and status = 'settled') <> 50 then
    raise exception 'settled set changed';
  end if;
  if v_bal_after - v_bal_before <> (select sum(amount_settled - coalesce(platform_fee_amount, 0)) from payments
                                     where user_id = '7e000000-0000-0000-0000-0000000000f1' and status = 'settled') then
    raise exception 'balance moved by % beyond the two settlements', v_bal_after - v_bal_before;
  end if;
  select count(*) into n from receipt_reviews where provider_payment_id like 'rr-%';
  if n <> 5 then raise exception 'expected 5 review rows, got %', n; end if;
  insert into t_ids values ('review', (select id::text from receipt_reviews where provider_payment_id = 'rr-b1'));
end $$;

-- A freelancer: no table access, no admin RPCs, no system RPCs.
select set_config('request.jwt.claim.sub', '7e000000-0000-0000-0000-0000000000f1', true);
set local role authenticated;
do $$
begin
  begin perform * from public.receipt_reviews; raise exception 'freelancer read receipt_reviews'; exception when insufficient_privilege then null; end;
  begin perform * from public.admin_list_receipt_reviews('all', 10); raise exception 'freelancer listed reviews'; exception when raise_exception then if sqlerrm <> 'Not authorized' then raise; end if; end;
  begin perform public.admin_resolve_receipt_review((select v::bigint from t_ids where k = 'review'), 'resolved', 'nope nope'); raise exception 'freelancer resolved a review'; exception when raise_exception then if sqlerrm <> 'Not authorized' then raise; end if; end;
  begin perform public.system_flag_receipt('x', null, 1, 'no_hash'); raise exception 'freelancer flagged'; exception when insufficient_privilege then null; end;
  begin perform public.system_sweep_receipt_reviews(); raise exception 'freelancer swept'; exception when insufficient_privilege then null; end;
end $$;
reset role;

-- An active admin: lists open items, must leave a note to close, audited.
select set_config('request.jwt.claim.sub', '7e000000-0000-0000-0000-0000000000a1', true);
set local role authenticated;
do $$
declare n int; v_id bigint := (select v::bigint from t_ids where k = 'review');
begin
  select count(*) into n from public.admin_list_receipt_reviews('open', 100) where provider_payment_id like 'rr-%';
  if n <> 5 then raise exception 'admin sees % open reviews, expected 5', n; end if;
  begin perform public.admin_resolve_receipt_review(v_id, 'resolved', ''); raise exception 'closed without a note'; exception when raise_exception then if sqlerrm not like 'A note is required%' then raise; end if; end;
  perform public.admin_resolve_receipt_review(v_id, 'resolved', 'Payer topped up separately; refunded off-platform');
  select count(*) into n from public.admin_list_receipt_reviews('open', 100) where provider_payment_id like 'rr-%';
  if n <> 4 then raise exception 'resolve did not close the item'; end if;
end $$;
reset role;
do $$
begin
  if not exists (select 1 from audit_log where action = 'receipt_review.resolved' and actor_id = '7e000000-0000-0000-0000-0000000000a1') then
    raise exception 'resolve was not audited';
  end if;
  if (select status from payments where invoice_ref = repeat('1', 64)) <> 'new' then raise exception 'resolving touched the payment'; end if;
  if has_function_privilege('anon', 'public.admin_list_receipt_reviews(text,integer)', 'execute') then raise exception 'anon can list reviews'; end if;
end $$;
select 'receipt review test passed' as result;
rollback;
