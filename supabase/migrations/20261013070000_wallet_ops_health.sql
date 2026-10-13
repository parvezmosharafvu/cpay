-- Read-only ops probe for the health Edge Function (service role only).
-- Reports the age of the cached wallet routes catalog (repeated cron refresh
-- failures show up as an old catalog), the last wallet lease (sync age),
-- invoices left unsettled past expiry (settlement loop not expiring them),
-- withdrawals sending over 30 min, and failed pg_cron runs in the last hour.
-- Additive: no table, policy or existing function changes.
create or replace function public.wallet_ops_health()
returns table (
  routes_oldest_at timestamptz,
  routes_keys int,
  last_lease_at timestamptz,
  overdue_unsettled int,
  oldest_overdue_at timestamptz,
  cron_failed_1h int
)
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare v_cron int := null;
begin
  if to_regclass('cron.job_run_details') is not null then
    execute $q$select count(*)::int from cron.job_run_details
               where status = 'failed' and start_time > now() - interval '1 hour'$q$ into v_cron;
  end if;
  return query
  select
    (select min(c.updated_at) from breez_wallet.response_cache c
      where c.key in ('/admin/wallet/stable-routes', '/withdraw/routes')),
    (select count(*)::int from breez_wallet.response_cache c
      where c.key in ('/admin/wallet/stable-routes', '/withdraw/routes')),
    (select max(l.acquired_at) from breez_wallet.lease_log l),
    (select count(*)::int from public.payments p
      where p.status in ('new', 'pending') and p.expires_at < now() - interval '30 minutes'),
    (select min(p.expires_at) from public.payments p
      where p.status in ('new', 'pending') and p.expires_at < now() - interval '30 minutes'),
    v_cron;
end;
$$;
revoke all on function public.wallet_ops_health() from public, anon, authenticated;
grant execute on function public.wallet_ops_health() to service_role;
