-- 20261013040000: wallet_lease_health() counts recent open failures and
-- EMAXCONNSESSION, is service-role only. BEGIN/ROLLBACK.
\set ON_ERROR_STOP on
begin;
insert into breez_wallet.lease_log (holder, acquired_at, released_at, outcome) values
  ('t1', now() - interval '2 minutes', now(), 'idle'),
  ('t2', now() - interval '3 minutes', now(), 'open-failed: Failed to initialize PostgreSQL database: (EMAXCONNSESSION) max clients reached'),
  ('t3', now() - interval '5 minutes', now(), 'open-failed: Cannot find module x'),
  ('t4', now() - interval '3 hours', now(), 'open-failed: old one'),
  ('t5', now() - interval '20 minutes', null, null);
do $$
declare r record;
begin
  select * into r from public.wallet_lease_health(15);
  if r.open_failed <> 2 or r.emaxconn <> 1 or r.unreleased_stale <> 1 then
    raise exception 'unexpected counts: %', row_to_json(r);
  end if;
  if r.last_failure not like 'open-failed: Failed to initialize%' then
    raise exception 'last_failure wrong: %', r.last_failure;
  end if;
  select * into r from public.wallet_lease_health(600);
  if r.open_failed <> 3 then raise exception 'window not applied: %', r.open_failed; end if;
end $$;
do $$
begin
  if has_function_privilege('anon', 'public.wallet_lease_health(int)', 'execute')
     or has_function_privilege('authenticated', 'public.wallet_lease_health(int)', 'execute') then
    raise exception 'wallet_lease_health must be service-role only';
  end if;
  if not has_function_privilege('service_role', 'public.wallet_lease_health(int)', 'execute') then
    raise exception 'service_role cannot execute wallet_lease_health';
  end if;
end $$;
select 'ok wallet_lease_health' as result;
rollback;
