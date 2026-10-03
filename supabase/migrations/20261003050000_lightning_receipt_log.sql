-- ============================================================
-- F1 PR 1: record every Lightning receipt (record-only, shadow)
-- ============================================================
-- Today settle_breez_payment() stores no amount, and a receive without a
-- payment hash never reaches the database at all, so underpaid, unknown,
-- overpaid and hash-less receipts leave no record. This migration adds a
-- durable receipt log next to the existing settlement path. It is
-- RECORD-ONLY:
--
--   * settle_breez_payment() is not touched; settlement, crediting,
--     payment statuses, balances and the wallet's spendable figure behave
--     exactly as before.
--   * no evaluation, allocation, suspense or accounting of any kind.
--   * nothing here is called until the payment service runs with
--     RECEIPT_RECORDING=shadow (default off).
--
-- Objects:
--   lightning_receipts       one row per provider receipt with a known amount
--   payment_invoices         snapshot of invoices known from payments today
--   receipt_coverage_gaps    historical deliveries with no known amount
--                            (operational only; never money)
--   record_lightning_receipt(...)              service_role only
--   note_lightning_receipt_legacy_outcome(...) service_role only
--
-- Tables: RLS on, no policies, no privileges for public, anon,
-- authenticated or service_role. Access is only through the two
-- SECURITY DEFINER functions. Safe to re-run.
-- See docs: cpay-audit F1_RECONCILIATION_DESIGN.md (rev 2), PR 1.
-- ============================================================

-- ---------- lightning_receipts ----------
create table if not exists public.lightning_receipts (
  id                    bigint generated always as identity primary key,
  provider              text not null default 'breez_spark'
                          check (provider = 'breez_spark'),
  provider_payment_id   text not null
                          check (provider_payment_id ~ '^[[:graph:]]{1,200}$'),
  payment_hash          text
                          check (payment_hash is null or payment_hash ~ '^[0-9A-Fa-f]{1,128}$'),
  receive_kind          text not null
                          check (receive_kind in ('lightning', 'spark', 'token', 'deposit', 'other', 'unknown')),
  amount_sat            bigint not null check (amount_sat >= 0),
  fee_sat               bigint check (fee_sat is null or fee_sat >= 0),
  provider_completed_at timestamptz,
  -- Sanitised, allowlisted, flat, bounded copy of the SDK payment object.
  -- The payment service builds it from an explicit allowlist; this check
  -- refuses any other key, any nested value and anything over 4 KB.
  provider_payload      jsonb not null default '{}'::jsonb
                          check (
                            jsonb_typeof(provider_payload) = 'object'
                            and octet_length(provider_payload::text) <= 4096
                            and (provider_payload - array[
                                  'id', 'paymentType', 'status', 'method', 'amount', 'fees',
                                  'timestamp', 'detailsType', 'paymentHash', 'htlcStatus',
                                  'htlcExpiryTime', 'txId', 'vout', 'droppedFields'
                                ]) = '{}'::jsonb
                            and not jsonb_path_exists(provider_payload, 'strict $.* ? (@.type() == "object" || @.type() == "array")')
                          ),
  record_source         text not null
                          check (record_source in ('event', 'catch_up', 'backfill_archive')),
  -- PR 1 only ever writes 'recorded'. Evaluation states arrive with PR 3.
  state                 text not null default 'recorded' check (state = 'recorded'),
  legacy_outcome        text,
  last_legacy_outcome   text,
  legacy_outcome_at     timestamptz,
  first_seen_at         timestamptz not null default now(),
  last_seen_at          timestamptz not null default now(),
  seen_count            integer not null default 1 check (seen_count >= 1),
  conflict_count        integer not null default 0 check (conflict_count >= 0),
  last_conflict_at      timestamptz,
  last_conflict         jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint lightning_receipts_provider_payment_key unique (provider, provider_payment_id)
);

create index if not exists idx_lightning_receipts_payment_hash
  on public.lightning_receipts(payment_hash) where payment_hash is not null;
create index if not exists idx_lightning_receipts_completed_at
  on public.lightning_receipts(provider_completed_at);

comment on table public.lightning_receipts is
  'F1 receipt log (record-only). One row per provider receipt with a known amount. Never pruned. Not used for accounting until a later, separately approved change.';

-- ---------- payment_invoices ----------
-- Only invoices reliably known from current payments rows (a Lightning
-- payment hash on invoice_ref plus a stored bolt11 and amount). It is NOT
-- every invoice the provider ever issued; that needs the invoice-claim
-- model (F1 PR 5). payment_id has no foreign key on purpose: payments
-- rows can be deleted (create-invoice cleanup, user deletion) and this
-- snapshot must neither block nor cascade those deletes.
create table if not exists public.payment_invoices (
  id                  bigint generated always as identity primary key,
  payment_id          uuid not null,
  payment_hash        text not null unique check (payment_hash ~ '^[0-9a-f]{64}$'),
  bolt11              text not null,
  amount_sat          bigint check (amount_sat is null or amount_sat >= 0),
  btc_usd_rate        numeric,
  attached            boolean not null default true,
  source              text not null default 'backfill_payments'
                        check (source in ('backfill_payments')),
  payment_created_at  timestamptz,
  observed_at         timestamptz not null default now()
);

create index if not exists idx_payment_invoices_payment on public.payment_invoices(payment_id);

comment on table public.payment_invoices is
  'Snapshot of Lightning invoices known from payments at migration time. Not complete; F1 PR 5 records invoices going forward.';

-- ---------- receipt_coverage_gaps ----------
-- Historical deliveries the database saw but whose amount it never stored.
-- Operational status only: never suspense, never a liability, never part
-- of any balance.
create table if not exists public.receipt_coverage_gaps (
  id                   bigint generated always as identity primary key,
  source               text not null check (source in ('webhook_events', 'reconciliation_archive')),
  provider_payment_id  text not null unique,
  payment_hash         text,
  event_type           text,
  received_at          timestamptz,
  legacy_outcome       text,
  matched_payment_id   uuid,
  gap_status           text not null default 'historical_unresolved'
                         check (gap_status in ('historical_unresolved', 'covered_by_receipt', 'ops_dismissed')),
  review_note          text,
  created_at           timestamptz not null default now()
);

comment on table public.receipt_coverage_gaps is
  'Historical receipt deliveries with no known amount (operational review only; excluded from all money calculations).';

-- ---------- privileges: functions only ----------
alter table public.lightning_receipts enable row level security;
alter table public.payment_invoices enable row level security;
alter table public.receipt_coverage_gaps enable row level security;

revoke all on table public.lightning_receipts from public, anon, authenticated, service_role;
revoke all on table public.payment_invoices from public, anon, authenticated, service_role;
revoke all on table public.receipt_coverage_gaps from public, anon, authenticated, service_role;
revoke all on sequence public.lightning_receipts_id_seq from public, anon, authenticated, service_role;
revoke all on sequence public.payment_invoices_id_seq from public, anon, authenticated, service_role;
revoke all on sequence public.receipt_coverage_gaps_id_seq from public, anon, authenticated, service_role;

-- ---------- record_lightning_receipt ----------
-- Insert-or-touch by provider payment id. Never credits, never settles,
-- never reads or writes payments. Returns one of:
--   recorded   first time this provider payment id is seen
--   duplicate  seen before with the same facts
--   updated    seen before; the hash or kind filled in later
--   conflict   seen before with a different amount or hash; first facts kept
create or replace function public.record_lightning_receipt(
  p_provider_payment_id text,
  p_payment_hash text,
  p_receive_kind text,
  p_amount_sat bigint,
  p_fee_sat bigint,
  p_provider_timestamp bigint,
  p_payload jsonb,
  p_source text
) returns text
language plpgsql
security definer
set search_path = public
set lock_timeout = '1s'
as $$
declare
  v_row public.lightning_receipts;
  v_completed_at timestamptz;
  v_hash text := nullif(lower(btrim(coalesce(p_payment_hash, ''))), '');
begin
  if p_source not in ('event', 'catch_up') then
    raise exception 'record_lightning_receipt: invalid source';
  end if;
  v_completed_at := case when coalesce(p_provider_timestamp, 0) > 0
                         then to_timestamp(p_provider_timestamp) end;

  insert into public.lightning_receipts(
    provider_payment_id, payment_hash, receive_kind, amount_sat, fee_sat,
    provider_completed_at, provider_payload, record_source
  ) values (
    p_provider_payment_id, v_hash, p_receive_kind, p_amount_sat, p_fee_sat,
    v_completed_at, coalesce(p_payload, '{}'::jsonb), p_source
  )
  on conflict (provider, provider_payment_id) do nothing
  returning * into v_row;
  if found then
    return 'recorded';
  end if;

  select * into v_row
    from public.lightning_receipts
   where provider = 'breez_spark' and provider_payment_id = p_provider_payment_id
   for update;

  if v_row.amount_sat is distinct from p_amount_sat
     or (v_row.payment_hash is not null and v_hash is not null and v_row.payment_hash is distinct from v_hash) then
    update public.lightning_receipts
       set conflict_count = conflict_count + 1,
           last_conflict_at = now(),
           last_conflict = jsonb_build_object('amount_sat', p_amount_sat, 'payment_hash', v_hash, 'source', p_source),
           last_seen_at = now(),
           seen_count = seen_count + 1,
           updated_at = now()
     where id = v_row.id;
    return 'conflict';
  end if;

  if v_row.payment_hash is null and v_hash is not null then
    update public.lightning_receipts
       set payment_hash = v_hash,
           receive_kind = p_receive_kind,
           provider_payload = coalesce(p_payload, provider_payload),
           provider_completed_at = coalesce(provider_completed_at, v_completed_at),
           last_seen_at = now(),
           seen_count = seen_count + 1,
           updated_at = now()
     where id = v_row.id;
    return 'updated';
  end if;

  update public.lightning_receipts
     set last_seen_at = now(),
         seen_count = seen_count + 1,
         updated_at = now()
   where id = v_row.id;
  return 'duplicate';
end;
$$;

comment on function public.record_lightning_receipt(text, text, text, bigint, bigint, bigint, jsonb, text) is
  'F1 PR 1: record a provider receipt (record-only; never credits or settles). service_role only.';

revoke all on function public.record_lightning_receipt(text, text, text, bigint, bigint, bigint, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.record_lightning_receipt(text, text, text, bigint, bigint, bigint, jsonb, text)
  to service_role;

-- ---------- note_lightning_receipt_legacy_outcome ----------
-- Shadow copy of what the unchanged legacy path returned. legacy_outcome
-- keeps the first answer other than 'duplicate' (concurrent deliveries can
-- note in any order); last_legacy_outcome keeps the latest. Returns false
-- when no receipt row exists.
create or replace function public.note_lightning_receipt_legacy_outcome(
  p_provider_payment_id text,
  p_outcome text
) returns boolean
language plpgsql
security definer
set search_path = public
set lock_timeout = '1s'
as $$
begin
  if p_outcome not in ('settled', 'duplicate', 'already_settled', 'underpaid',
                       'not_settleable', 'unknown', 'no_hash') then
    raise exception 'note_lightning_receipt_legacy_outcome: invalid outcome';
  end if;
  update public.lightning_receipts
     set legacy_outcome = case when legacy_outcome is null or legacy_outcome = 'duplicate'
                               then p_outcome else legacy_outcome end,
         last_legacy_outcome = p_outcome,
         legacy_outcome_at = now(),
         updated_at = now()
   where provider = 'breez_spark' and provider_payment_id = p_provider_payment_id;
  return found;
end;
$$;

comment on function public.note_lightning_receipt_legacy_outcome(text, text) is
  'F1 PR 1: store the legacy settle outcome next to the receipt (shadow only). service_role only.';

revoke all on function public.note_lightning_receipt_legacy_outcome(text, text)
  from public, anon, authenticated;
grant execute on function public.note_lightning_receipt_legacy_outcome(text, text)
  to service_role;

-- ---------- backfill (idempotent) ----------
-- 1. Receipts: only archive rows whose amount is known (written by the
--    20261003010000 settlement while it was live).
-- 2. Coverage gaps: archive rows without an amount, and Breez webhook
--    deliveries that have no receipt. These are never money.
-- 3. payment_invoices: payments that carry a Lightning hash, a bolt11 and
--    an amount today.
do $$
begin
  if to_regclass('public.lightning_receipt_reconciliation_archive') is not null then
    insert into public.lightning_receipts(
      provider_payment_id, payment_hash, receive_kind, amount_sat, fee_sat,
      provider_completed_at, provider_payload, record_source,
      legacy_outcome, last_legacy_outcome, legacy_outcome_at,
      first_seen_at, last_seen_at
    )
    select substring(a.delivery_id from 7),
           case when a.invoice_id ~ '^[0-9A-Fa-f]{1,128}$' then lower(a.invoice_id) end,
           'unknown',
           a.receipt_amount_sat,
           null,
           null,
           jsonb_strip_nulls(jsonb_build_object(
             'id', substring(a.delivery_id from 7),
             'amount', a.receipt_amount_sat::text,
             'paymentHash', case when a.invoice_id ~ '^[0-9A-Fa-f]{1,128}$' then lower(a.invoice_id) end
           )),
           'backfill_archive',
           a.settlement_outcome, a.settlement_outcome, a.archived_at,
           a.received_at, a.received_at
      from public.lightning_receipt_reconciliation_archive a
     where a.delivery_id like 'breez:%'
       and substring(a.delivery_id from 7) ~ '^[[:graph:]]{1,200}$'
       and a.receipt_amount_sat is not null
    on conflict (provider, provider_payment_id) do nothing;

    insert into public.receipt_coverage_gaps(
      source, provider_payment_id, payment_hash, event_type, received_at,
      legacy_outcome, matched_payment_id
    )
    select 'reconciliation_archive',
           substring(a.delivery_id from 7),
           a.invoice_id,
           a.event_type,
           a.received_at,
           a.settlement_outcome,
           (select p.id from public.payments p where p.invoice_ref = a.invoice_id)
      from public.lightning_receipt_reconciliation_archive a
     where a.delivery_id like 'breez:%'
       and a.receipt_amount_sat is null
       and not exists (
         select 1 from public.lightning_receipts r
          where r.provider = 'breez_spark'
            and r.provider_payment_id = substring(a.delivery_id from 7)
       )
    on conflict (provider_payment_id) do nothing;
  end if;
end $$;

insert into public.receipt_coverage_gaps(
  source, provider_payment_id, payment_hash, event_type, received_at, matched_payment_id
)
select 'webhook_events',
       substring(e.delivery_id from 7),
       e.invoice_id,
       e.event_type,
       e.received_at,
       (select p.id from public.payments p where p.invoice_ref = e.invoice_id)
  from public.webhook_events e
 where e.delivery_id like 'breez:%'
   and not exists (
     select 1 from public.lightning_receipts r
      where r.provider = 'breez_spark'
        and r.provider_payment_id = substring(e.delivery_id from 7)
   )
on conflict (provider_payment_id) do nothing;

insert into public.payment_invoices(
  payment_id, payment_hash, bolt11, amount_sat, btc_usd_rate, attached, source, payment_created_at
)
select p.id, p.invoice_ref, p.lightning_invoice, p.amount_sat, p.btc_usd_rate, true, 'backfill_payments', p.created_at
  from public.payments p
 where p.invoice_ref ~ '^[0-9a-f]{64}$'
   and p.lightning_invoice is not null
on conflict (payment_hash) do nothing;
