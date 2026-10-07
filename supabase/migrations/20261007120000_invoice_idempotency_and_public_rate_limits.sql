-- ============================================================
-- P2 items 2 and 7: one invoice per payer request, and per-IP / per-link
-- brakes on public invoice creation
-- ============================================================
-- 1. payments.client_request_id: an optional UUID the payment page sends
--    with each "Continue to payment" attempt. A unique index on
--    (payment_link_id, client_request_id) means a double tap, a retry
--    after a timeout, or the proxy-then-direct fallback can never create
--    two invoices for the same attempt, even when the requests race: the
--    second insert fails with 23505 and create-invoice answers with the
--    first row's invoice. NULL (old pages, other callers) keeps today's
--    behaviour.
--
-- 2. public_rate_limits + claim_public_rate_limit(bucket, key_hash, limit,
--    window): fixed-window counters for unauthenticated endpoints, keyed
--    by a SHA-256 of the client key (no raw IPs stored). service_role only.
--    Rows untouched for a day are pruned opportunistically.
--
-- Additive only. Rollback (documented, not automatic):
--   drop function if exists public.claim_public_rate_limit(text, text, integer, integer);
--   drop table if exists public.public_rate_limits;
--   drop index if exists public.payments_link_client_request_uidx;
--   alter table public.payments drop column if exists client_request_id;
-- ============================================================

alter table public.payments add column if not exists client_request_id uuid;

create unique index if not exists payments_link_client_request_uidx
  on public.payments (payment_link_id, client_request_id)
  where client_request_id is not null;

create table if not exists public.public_rate_limits (
  bucket text not null check (bucket ~ '^[a-z_]{1,40}$'),
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null default now(),
  request_count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (bucket, key_hash)
);
alter table public.public_rate_limits enable row level security;
revoke all on public.public_rate_limits from public, anon, authenticated;

create or replace function public.claim_public_rate_limit(
  p_bucket text, p_key_hash text, p_limit integer, p_window_seconds integer
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  if p_bucket is null or p_key_hash is null or p_limit is null or p_limit < 1
     or p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'Invalid rate-limit parameters';
  end if;
  insert into public.public_rate_limits as r (bucket, key_hash, window_started_at, request_count, updated_at)
  values (p_bucket, lower(p_key_hash), now(), 1, now())
  on conflict (bucket, key_hash) do update
    set window_started_at = case when now() - r.window_started_at >= make_interval(secs => p_window_seconds) then now() else r.window_started_at end,
        request_count = case when now() - r.window_started_at >= make_interval(secs => p_window_seconds) then 1 else r.request_count + 1 end,
        updated_at = now()
  returning request_count into v_count;
  if random() < 0.01 then
    delete from public.public_rate_limits where updated_at < now() - interval '1 day';
  end if;
  return v_count <= p_limit;
end; $$;

revoke all on function public.claim_public_rate_limit(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_public_rate_limit(text, text, integer, integer) to service_role;
