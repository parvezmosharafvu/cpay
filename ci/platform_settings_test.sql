-- 20261020010000: platform settings. Defaults keep current behaviour; only
-- an active admin at aal2 can write, through the audited RPC; values are
-- typed; legal publish needs every field; the public reader exposes only
-- legal fields and the wallet link. BEGIN/ROLLBACK.
\set ON_ERROR_STOP on
begin;
create or replace function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.jwt() returns jsonb language sql stable
as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.jwt() to anon, authenticated, service_role;
insert into auth.users(id, email) values
  ('e6000000-0000-0000-0000-0000000000a1', 'ps-admin@test.invalid'),
  ('e6000000-0000-0000-0000-0000000000f1', 'ps-free@test.invalid');
update profiles set account_status = 'active' where id::text like 'e6000000-%';
update profiles set role = 'admin' where id = 'e6000000-0000-0000-0000-0000000000a1';

-- 1. Defaults = today's behaviour; nothing stored.
do $$ begin
  if (select count(*) from platform_settings) <> 0 then raise exception 'rows stored on deploy'; end if;
  if platform_setting('custodial_receive_enabled') <> 'true' or platform_setting('custodial_new_links_enabled') <> 'true'
     or platform_setting('custodial_withdraw_enabled') <> 'true' or platform_setting('fee_billing_enabled') <> 'false'
     or platform_setting('legal_published') <> 'false' or platform_setting('wallet_link_enabled') <> 'false'
     or platform_setting('admin_send_daily_cap_usd') <> 'null' or platform_setting('direct_pilot_user_ids') <> '[]'
  then raise exception 'a default changes current behaviour'; end if;
  if (get_public_site_settings()->>'legal_published')::boolean then raise exception 'legal published by default'; end if;
end $$;

-- 2. Freelancer: no write, no read.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e6000000-0000-0000-0000-0000000000f1', true);
select set_config('request.jwt.claims', '{"aal":"aal2"}', true);
do $$ begin
  perform admin_set_platform_setting('fee_grace_days', '3');
  raise exception 'freelancer wrote a setting';
exception when raise_exception then if sqlerrm <> 'Not authorized' then raise; end if; end $$;
do $$ begin
  perform admin_platform_settings();
  raise exception 'freelancer read settings';
exception when raise_exception then if sqlerrm <> 'Not authorized' then raise; end if; end $$;
do $$ begin
  insert into platform_settings(key, value) values ('fee_grace_days', '3');
  raise exception 'direct insert allowed';
exception when insufficient_privilege then null; end $$;
reset role;

-- 3. Admin at aal1 refused; at aal2 allowed, typed, audited.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e6000000-0000-0000-0000-0000000000a1', true);
select set_config('request.jwt.claims', '{"aal":"aal1"}', true);
do $$ begin
  perform admin_set_platform_setting('fee_grace_days', '3');
  raise exception 'aal1 admin wrote a setting';
exception when raise_exception then if sqlerrm not like 'Enter your authenticator code first%' then raise; end if; end $$;
select set_config('request.jwt.claims', '{"aal":"aal2"}', true);
do $$ begin
  insert into platform_settings(key, value) values ('fee_grace_days', '3');
  raise exception 'admin direct insert allowed';
exception when insufficient_privilege then null; end $$;
select admin_set_platform_setting('fee_grace_days', '3');
select admin_set_platform_setting('fee_subscription_price_usd', '9.99');
select admin_set_platform_setting('direct_provider_hosts', '["wallet.example.com"]');
select admin_set_platform_setting('admin_send_daily_cap_usd', '50');
do $$
declare bad record;
begin
  for bad in select * from (values ('fee_grace_days','"3"'), ('fee_grace_days','91'), ('fee_grace_days','2.5'),
      ('fee_subscription_price_usd','-1'), ('custodial_receive_enabled','"false"'), ('direct_provider_hosts','["http://x"]'),
      ('direct_pilot_user_ids','["not-a-uuid"]'), ('legal_support_email','"nope"'), ('wallet_url','"http://x.example.com"'),
      ('legal_entity_name','"<script>"'), ('no_such_key','true')) t(k, v) loop
    begin
      perform admin_set_platform_setting(bad.k, bad.v::jsonb);
      raise exception 'accepted % = %', bad.k, bad.v;
    exception when raise_exception then
      if sqlerrm like 'accepted %' then raise; end if;
    end;
  end loop;
end $$;
-- Legal publish needs every field; wallet link needs a URL.
do $$ begin
  perform admin_set_platform_setting('legal_published', 'true');
  raise exception 'published with empty fields';
exception when raise_exception then if sqlerrm not like 'Fill in every legal field%' then raise; end if; end $$;
do $$ begin
  perform admin_set_platform_setting('wallet_link_enabled', 'true');
  raise exception 'wallet link without url';
exception when raise_exception then if sqlerrm not like 'Set the CPAY Wallet address%' then raise; end if; end $$;
select admin_set_platform_setting('legal_entity_name', '"Example Ltd"'), admin_set_platform_setting('legal_address', '"1 Example Road"'),
       admin_set_platform_setting('legal_effective_date', '"2026-11-01"'), admin_set_platform_setting('legal_jurisdiction', '"Exampleland"'),
       admin_set_platform_setting('legal_courts', '"Example City"'), admin_set_platform_setting('legal_privacy_email', '"privacy@example.com"'),
       admin_set_platform_setting('legal_support_email', '"support@example.com"');
select admin_set_platform_setting('legal_published', 'true');
do $$ begin
  if (select count(*) from admin_platform_settings()) < 20 then raise exception 'admin view incomplete'; end if;
end $$;
reset role;
do $$ begin
  if (select count(*) from audit_log where action = 'settings.platform') < 12 then raise exception 'changes not audited'; end if;
end $$;

-- 4. Public reader: legal fields only, nothing operational.
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '', true);
do $$ declare j jsonb := get_public_site_settings(); begin
  if not (j->>'legal_published')::boolean then raise exception 'published flag not visible'; end if;
  if j ? 'direct_provider_hosts' or j ? 'admin_send_daily_cap_usd' or j ? 'admin_send_allowed_destinations' or j ? 'direct_pilot_user_ids'
  then raise exception 'operational settings leaked'; end if;
  if j->>'legal_support_email' <> 'support@example.com' then raise exception 'legal field missing'; end if;
end $$;
do $$ begin
  perform platform_setting('fee_grace_days');
  raise exception 'anon read platform_setting()';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform 1 from platform_settings;
  raise exception 'anon read the table';
exception when insufficient_privilege then null; end $$;
reset role;
do $$ begin raise notice 'ok: platform settings'; end $$;
rollback;
