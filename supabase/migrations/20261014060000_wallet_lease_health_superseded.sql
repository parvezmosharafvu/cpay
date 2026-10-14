-- Forward-only. wallet_lease_health() counted every lease row left open for
-- over 10 minutes as a wedged isolate. A row is also left open when an
-- isolate is killed mid-lease; the advisory lock is released with its
-- connection and later leases proceed normally, but the row stayed "open"
-- and health alerted every 15 minutes for a day (production row 2608,
-- 2026-10-14). A lease is wedged only if it is still the latest one: any
-- later lease proves the lock moved on. Everything else is unchanged.
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
    -- a lease held for over 10 minutes with no release, and no later lease
    -- taken since, is a wedged isolate
    (select count(*)::int from breez_wallet.lease_log l
      where l.released_at is null and l.acquired_at < now() - interval '10 minutes'
        and l.acquired_at > now() - interval '1 day'
        and not exists (select 1 from breez_wallet.lease_log n where n.acquired_at > l.acquired_at)),
    max(acquired_at) filter (where outcome like 'open-failed%'),
    (select left(l.outcome, 160) from breez_wallet.lease_log l
      where l.outcome like 'open-failed%' order by l.acquired_at desc limit 1),
    (select max(acquired_at) from breez_wallet.lease_log)
  from breez_wallet.lease_log
  where acquired_at > now() - make_interval(mins => greatest(1, least(p_window_minutes, 1440)));
$$;
revoke all on function public.wallet_lease_health(int) from public, anon, authenticated;
grant execute on function public.wallet_lease_health(int) to service_role;
