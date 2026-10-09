-- ============================================================
-- P2 item 3: unmatched / underpaid / overpaid receipts go to an admin
-- review queue. Flag only: nothing here credits, settles or edits a
-- payment, and settle_breez_payment() is NOT changed (it stays byte-
-- identical, as the F1 design requires).
-- ============================================================
-- Two independent detectors write one row per provider payment id:
--
-- * system_flag_receipt(id, hash, amount_sat, outcome): called by the
--   payment service right AFTER settle_breez_payment() answered, in its own
--   autocommit statement, best effort (a failure is logged, never retried
--   into settlement). It has the received amount, so it can tell
--   underpaid / overpaid / unmatched / paid-twice / no-hash receipts apart.
--   It runs whether or not RECEIPT_RECORDING is on.
--
-- * system_sweep_receipt_reviews(): every 10 minutes from pg_cron. Uses only
--   what settle_breez_payment() already persists atomically (webhook_events
--   'breez:<id>' rows, inserted before the settle decision): a breez receipt
--   whose payment hash matches no payment ('unmatched'), matches a payment
--   that is still not settled ('unsettled', e.g. underpaid), or is a second
--   receipt for an already settled hash ('already_settled'). This is the
--   backstop if the service call above is lost, and it needs no payment-
--   service deploy.
--
-- Admins see the queue with admin_list_receipt_reviews() and close items
-- with admin_resolve_receipt_review() (audited). Resolving changes only the
-- review row. Any money correction stays a separate, deliberate admin act.
--
-- Rollback (documented, not automatic):
--   select cron.unschedule('receipt-review-sweep');
--   drop function if exists public.admin_resolve_receipt_review(bigint, text, text);
--   drop function if exists public.admin_list_receipt_reviews(text, integer);
--   drop function if exists public.system_sweep_receipt_reviews();
--   drop function if exists public.system_flag_receipt(text, text, bigint, text);
--   drop table if exists public.receipt_reviews;
-- ============================================================

create table if not exists public.receipt_reviews (
  id bigint generated always as identity primary key,
  provider_payment_id text not null unique check (length(provider_payment_id) between 1 and 200),
  payment_hash text check (payment_hash is null or payment_hash ~ '^[0-9a-f]{1,128}$'),
  payment_id uuid references public.payments(id) on delete set null,
  kind text not null check (kind in ('underpaid', 'overpaid', 'unmatched', 'unsettled', 'already_settled', 'not_settleable', 'no_hash')),
  received_sat bigint check (received_sat is null or received_sat >= 0),
  expected_sat bigint check (expected_sat is null or expected_sat >= 0),
  settle_outcome text,
  detected_by text not null check (detected_by in ('service', 'sweep')),
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  resolution_note text check (resolution_note is null or length(resolution_note) <= 2000),
  resolved_by uuid,
  resolved_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  seen_count integer not null default 1
);
create index if not exists receipt_reviews_open_idx on public.receipt_reviews (first_seen_at desc) where status = 'open';
alter table public.receipt_reviews enable row level security;
revoke all on public.receipt_reviews from public, anon, authenticated;

-- Classify one settle outcome. Reads payments, writes receipt_reviews only.
create or replace function public.system_flag_receipt(
  p_provider_payment_id text, p_payment_hash text, p_amount_sat bigint, p_outcome text
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_pay payments;
  v_kind text;
  v_hash text := nullif(lower(trim(coalesce(p_payment_hash, ''))), '');
begin
  if coalesce(trim(p_provider_payment_id), '') = '' or length(p_provider_payment_id) > 200 then
    raise exception 'provider payment id is required';
  end if;
  if v_hash is not null and v_hash !~ '^[0-9a-f]{1,128}$' then v_hash := null; end if;
  if v_hash is not null then
    select * into v_pay from payments where invoice_ref = v_hash limit 1;
  end if;

  v_kind := case p_outcome
    when 'underpaid' then 'underpaid'
    when 'unknown' then 'unmatched'
    when 'not_settleable' then 'not_settleable'
    when 'no_hash' then 'no_hash'
    when 'already_settled' then 'already_settled'
    when 'settled' then case when v_pay.amount_sat is not null and p_amount_sat > v_pay.amount_sat then 'overpaid' end
    else null
  end;
  if v_kind is null then return null; end if;

  insert into receipt_reviews as r (provider_payment_id, payment_hash, payment_id, kind, received_sat, expected_sat,
                                    settle_outcome, detected_by)
  values (trim(p_provider_payment_id), v_hash, v_pay.id, v_kind, p_amount_sat, v_pay.amount_sat, left(p_outcome, 40), 'service')
  on conflict (provider_payment_id) do update
    set last_seen_at = now(),
        seen_count = r.seen_count + 1,
        -- The service knows the amount; it refines a sweep row's guess.
        kind = case when r.detected_by = 'sweep' then excluded.kind else r.kind end,
        received_sat = coalesce(r.received_sat, excluded.received_sat),
        expected_sat = coalesce(r.expected_sat, excluded.expected_sat),
        payment_id = coalesce(r.payment_id, excluded.payment_id),
        settle_outcome = coalesce(r.settle_outcome, excluded.settle_outcome),
        detected_by = case when r.detected_by = 'sweep' then 'service' else r.detected_by end;
  return v_kind;
end; $$;

-- Backstop from persisted state only (see header).
create or replace function public.system_sweep_receipt_reviews()
returns integer
language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  with breez as (
    select w.id, substr(w.delivery_id, 7) as provider_payment_id, lower(w.invoice_id) as hash, w.received_at,
           row_number() over (partition by lower(w.invoice_id) order by w.id) as nth
      from webhook_events w
     where w.delivery_id like 'breez:%'
       and w.event_type = 'breez.payment_received'
       and w.received_at > now() - interval '30 days'
  ), candidates as (
    select b.provider_payment_id, b.hash, p.id as payment_id, p.amount_sat,
           case
             when p.id is null then 'unmatched'
             when p.status <> 'settled' then 'unsettled'
             when b.nth > 1 then 'already_settled'
           end as kind
      from breez b
      left join payments p on p.invoice_ref = b.hash
     where b.received_at < now() - interval '2 minutes'
  ), ins as (
    insert into receipt_reviews (provider_payment_id, payment_hash, payment_id, kind, expected_sat, detected_by)
    select c.provider_payment_id, case when c.hash ~ '^[0-9a-f]{1,128}$' then c.hash end, c.payment_id, c.kind, c.amount_sat, 'sweep'
      from candidates c
     where c.kind is not null
    on conflict (provider_payment_id) do nothing
    returning 1
  )
  select count(*)::integer into v_count from ins;
  return v_count;
end; $$;

create or replace function public.admin_list_receipt_reviews(p_status text default 'open', p_limit integer default 100)
returns table (
  id bigint, kind text, status text, provider_payment_id text, payment_hash text, payment_id uuid,
  received_sat bigint, expected_sat bigint, settle_outcome text, detected_by text,
  payment_status text, amount_requested numeric, merchant_name text,
  first_seen_at timestamptz, last_seen_at timestamptz, seen_count integer,
  resolution_note text, resolved_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if p_status is not null and p_status not in ('open', 'resolved', 'dismissed', 'all') then
    raise exception 'Unknown status filter';
  end if;
  return query
  select r.id, r.kind, r.status, r.provider_payment_id, r.payment_hash, r.payment_id,
         r.received_sat, r.expected_sat, r.settle_outcome, r.detected_by,
         p.status, p.amount_requested, pr.display_name,
         r.first_seen_at, r.last_seen_at, r.seen_count, r.resolution_note, r.resolved_at
    from receipt_reviews r
    left join payments p on p.id = r.payment_id
    left join profiles pr on pr.id = p.user_id
   where coalesce(p_status, 'open') = 'all' or r.status = coalesce(p_status, 'open')
   order by r.first_seen_at desc
   limit least(greatest(coalesce(p_limit, 100), 1), 500);
end; $$;

create or replace function public.admin_resolve_receipt_review(p_id bigint, p_status text, p_note text default null)
returns public.receipt_reviews
language plpgsql security definer set search_path = public as $$
declare v_old receipt_reviews; v_row receipt_reviews; v_note text := left(trim(coalesce(p_note, '')), 2000);
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if p_status is null or p_status not in ('open', 'resolved', 'dismissed') then raise exception 'Status must be open, resolved or dismissed'; end if;
  if p_status <> 'open' and char_length(v_note) < 4 then raise exception 'A note is required to close a receipt review'; end if;
  select * into v_old from receipt_reviews where id = p_id for update;
  if not found then raise exception 'Unknown receipt review'; end if;
  update receipt_reviews
     set status = p_status,
         resolution_note = nullif(v_note, ''),
         resolved_by = case when p_status = 'open' then null else auth.uid() end,
         resolved_at = case when p_status = 'open' then null else now() end
   where id = p_id
  returning * into v_row;
  perform record_audit(
    'receipt_review.' || p_status, 'receipt_review', v_row.id::text,
    jsonb_build_object('status', v_old.status, 'note', v_old.resolution_note),
    jsonb_build_object('status', v_row.status, 'note', v_row.resolution_note, 'kind', v_row.kind,
                       'provider_payment_id', v_row.provider_payment_id),
    'Receipt review updated (no ledger change)'
  );
  return v_row;
end; $$;

revoke all on function public.system_flag_receipt(text, text, bigint, text) from public, anon, authenticated;
revoke all on function public.system_sweep_receipt_reviews() from public, anon, authenticated;
grant execute on function public.system_flag_receipt(text, text, bigint, text) to service_role;
grant execute on function public.system_sweep_receipt_reviews() to service_role;
revoke all on function public.admin_list_receipt_reviews(text, integer) from public, anon;
revoke all on function public.admin_resolve_receipt_review(bigint, text, text) from public, anon;
grant execute on function public.admin_list_receipt_reviews(text, integer) to authenticated, service_role;
grant execute on function public.admin_resolve_receipt_review(bigint, text, text) to authenticated, service_role;

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron not installed — skipping receipt-review-sweep schedule.';
    return;
  end if;
  perform cron.unschedule('receipt-review-sweep')
   where exists (select 1 from cron.job where jobname = 'receipt-review-sweep');
  perform cron.schedule('receipt-review-sweep', '*/10 * * * *', $job$select public.system_sweep_receipt_reviews()$job$);
end $$;
