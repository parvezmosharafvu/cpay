-- 20261013070000: wallet_ops_health() is service-role only and reports
-- routes cache age and overdue unsettled invoices.
do $$
declare r record;
begin
  delete from breez_wallet.response_cache where key in ('/admin/wallet/stable-routes', '/withdraw/routes');
  select * into r from public.wallet_ops_health();
  if r.routes_keys <> 0 or r.routes_oldest_at is not null then raise exception 'expected no routes cache, got %', r; end if;
  insert into breez_wallet.response_cache (key, status, body, updated_at) values
    ('/admin/wallet/stable-routes', 200, '{"routes":[1]}', now() - interval '3 hours'),
    ('/withdraw/routes', 200, '{"routes":[1]}', now());
  select * into r from public.wallet_ops_health();
  if r.routes_keys <> 2 or r.routes_oldest_at > now() - interval '2 hours' then raise exception 'oldest routes age wrong: %', r; end if;
  if r.overdue_unsettled < 0 then raise exception 'bad overdue count'; end if;
  delete from breez_wallet.response_cache where key in ('/admin/wallet/stable-routes', '/withdraw/routes');
  if has_function_privilege('anon', 'public.wallet_ops_health()', 'execute')
     or has_function_privilege('authenticated', 'public.wallet_ops_health()', 'execute') then
    raise exception 'wallet_ops_health must be service-role only';
  end if;
  if not has_function_privilege('service_role', 'public.wallet_ops_health()', 'execute') then
    raise exception 'service_role cannot execute wallet_ops_health';
  end if;
end $$;
select 'ok wallet_ops_health' as result;
