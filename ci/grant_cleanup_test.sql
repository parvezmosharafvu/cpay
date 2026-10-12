-- 20261013030000: anon has no write/TRUNCATE on any public table;
-- authenticated has no TRUNCATE/REFERENCES/TRIGGER; RLS-gated client paths
-- (anon reads of app_settings/site_domains, authenticated support message
-- insert) still hold their privilege.
do $$
declare n int;
begin
  select count(*) into n from information_schema.role_table_grants
   where table_schema = 'public' and grantee = 'anon' and privilege_type <> 'SELECT';
  if n > 0 then raise exception 'anon still has % non-SELECT table grants', n; end if;
  select count(*) into n from information_schema.role_table_grants
   where table_schema = 'public' and grantee = 'authenticated' and privilege_type in ('TRUNCATE','REFERENCES','TRIGGER');
  if n > 0 then raise exception 'authenticated still has % TRUNCATE/REFERENCES/TRIGGER grants', n; end if;
  if not has_table_privilege('anon', 'public.app_settings', 'select') then raise exception 'anon lost app_settings select'; end if;
  if not has_table_privilege('authenticated', 'public.support_messages', 'insert') then raise exception 'authenticated lost support_messages insert'; end if;
  if not has_table_privilege('authenticated', 'public.payment_links', 'update') then raise exception 'authenticated lost payment_links update'; end if;
  if (select count(*) from pg_constraint where conname in ('profiles_preferred_usdt_network_chk','profiles_withdraw_threshold_chk','usdt_wallets_address_chk','usdt_wallets_network_chk')) <> 4 then
    raise exception 'production constraints not codified';
  end if;
end $$;
select 'grant cleanup test passed' as result;
