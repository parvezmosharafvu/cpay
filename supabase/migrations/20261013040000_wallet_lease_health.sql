-- Read-only health probe for the Supabase-hosted wallet (breez-wallet).
-- The health Edge Function calls it with the service role and alerts when
-- the wallet failed to open recently (EMAXCONNSESSION, missing module, ...).
-- Additive: no table, policy or existing function changes.
create or replace function public.wallet_lease_health(p_window_minutes int default 15)
returns table (
  open_failed int,
  emaxconn int,
  unreleased_stale int,
  last_failure_at timestamptz,
  last_failure text,
  last_lease_at timestamptz
)
language sql
stable
security definer
set search_path = breez_wallet, pg_catalog
as $$
  select
    count(*) filter (where outcome like 'open-failed%')::int,
    count(*) filter (where outcome like '%EMAXCONNSESSION%')::int,
    -- a lease held for over 10 minutes with no release is a wedged isolate
    (select count(*)::int from breez_wallet.lease_log
      where released_at is null and acquired_at < now() - interval '10 minutes'
        and acquired_at > now() - interval '1 day'),
    max(acquired_at) filter (where outcome like 'open-failed%'),
    (select left(l.outcome, 160) from breez_wallet.lease_log l
      where l.outcome like 'open-failed%' order by l.acquired_at desc limit 1),
    (select max(acquired_at) from breez_wallet.lease_log)
  from breez_wallet.lease_log
  where acquired_at > now() - make_interval(mins => greatest(1, least(p_window_minutes, 1440)));
$$;
revoke all on function public.wallet_lease_health(int) from public, anon, authenticated;
grant execute on function public.wallet_lease_health(int) to service_role;
