-- Admin → Health subsystem cards. Read-only, active admins only (is_admin()),
-- service_role for server callers. Built on the service-role probes
-- wallet_lease_health() and wallet_ops_health(); exposes only states, ages
-- and counts (no ids, balances, addresses or secrets).
create or replace function public.admin_wallet_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  o record;
  l record;
  v_daily timestamptz;
  v_sending int;
  v_oldest_sending timestamptz;
  card jsonb := '[]'::jsonb;
  age_s int;
begin
  -- current_user is the definer here, so the caller is judged by its JWT.
  if not (public.is_admin()
          or coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role') then
    raise exception 'Not authorized' using errcode = 'insufficient_privilege';
  end if;
  select * into o from public.wallet_ops_health();
  select * into l from public.wallet_lease_health(15);
  select max(computed_at) into v_daily from public.daily_stats;
  select count(*)::int, min(requested_at) into v_sending, v_oldest_sending
    from public.withdrawals where status = 'sending' and requested_at < now() - interval '30 minutes';

  card := card || jsonb_build_object('key', 'database', 'label', 'Database', 'state', 'ok',
    'age_sec', 0, 'detail', 'reachable', 'runbook', 'docs/RUNBOOKS.md');
  age_s := floor(extract(epoch from now() - o.last_lease_at))::int;
  card := card || jsonb_build_object('key', 'wallet_sync', 'label', 'Wallet sync',
    'state', case when o.last_lease_at is null or age_s >= 900 then 'fail' else 'ok' end,
    'age_sec', age_s, 'detail', case when o.last_lease_at is null then 'never opened' else 'last wallet lease' end,
    'runbook', 'docs/RUNBOOKS.md#wallet-sync');
  card := card || jsonb_build_object('key', 'wallet_process', 'label', 'Wallet process',
    'state', case when coalesce(l.open_failed, 0) = 0 and coalesce(l.unreleased_stale, 0) = 0 then 'ok' else 'fail' end,
    'age_sec', floor(extract(epoch from now() - l.last_failure_at))::int,
    'detail', format('%s open failure(s) in 15m, %s wedged lease(s)', coalesce(l.open_failed, 0), coalesce(l.unreleased_stale, 0)),
    'runbook', 'docs/RUNBOOKS.md#wallet-sync');
  age_s := floor(extract(epoch from now() - o.routes_oldest_at))::int;
  card := card || jsonb_build_object('key', 'routes_cache', 'label', 'Network list cache',
    'state', case when coalesce(o.routes_keys, 0) = 0 then 'unknown' when age_s >= 7200 then 'fail' when age_s >= 1200 then 'warn' else 'ok' end,
    'age_sec', age_s, 'detail', format('%s cached list(s)', coalesce(o.routes_keys, 0)),
    'runbook', 'docs/RUNBOOKS.md#wallet-routes-cache');
  card := card || jsonb_build_object('key', 'settlement_loop', 'label', 'Settlement loop',
    'state', case when coalesce(o.overdue_unsettled, 0) = 0 then 'ok' else 'fail' end,
    'age_sec', floor(extract(epoch from now() - o.oldest_overdue_at))::int,
    'detail', format('%s invoice(s) unsettled 30m past expiry', coalesce(o.overdue_unsettled, 0)),
    'runbook', 'docs/RUNBOOKS.md#settlement-loop');
  card := card || jsonb_build_object('key', 'withdrawal_reconciliation', 'label', 'Withdrawal reconciliation',
    'state', case when v_sending = 0 then 'ok' else 'fail' end,
    'age_sec', floor(extract(epoch from now() - v_oldest_sending))::int,
    'detail', format('%s withdrawal(s) sending over 30m', v_sending),
    'runbook', 'docs/RUNBOOKS.md');
  age_s := floor(extract(epoch from now() - v_daily))::int;
  card := card || jsonb_build_object('key', 'daily_report', 'label', 'Daily reconciliation report',
    'state', case when v_daily is null then 'unknown' when age_s >= 36 * 3600 then 'fail' else 'ok' end,
    'age_sec', age_s, 'detail', 'last daily_stats write', 'runbook', 'docs/RUNBOOKS.md');
  card := card || jsonb_build_object('key', 'scheduled_jobs', 'label', 'Scheduled jobs',
    'state', case when o.cron_failed_1h is null then 'unknown' when o.cron_failed_1h = 0 then 'ok' else 'fail' end,
    'age_sec', null, 'detail', format('%s failed run(s) in 1h', coalesce(o.cron_failed_1h::text, 'n/a')),
    'runbook', 'docs/RUNBOOKS.md#scheduled-jobs');
  return jsonb_build_object('checked_at', now(), 'cards', card);
end;
$$;
revoke all on function public.admin_wallet_health() from public, anon;
grant execute on function public.admin_wallet_health() to authenticated, service_role;
