-- 20261020070000: domains change only through admin_save_domain /
-- admin_remove_domain (active admin at aal2, validated, audited); no direct
-- table writes from a signed-in account; reads stay public. BEGIN/ROLLBACK.
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
  ('d0000000-0000-0000-0000-0000000000ad', 'dom-admin@test.invalid'),
  ('d0000000-0000-0000-0000-0000000000c1', 'dom-user@test.invalid');
update profiles set account_status = 'active' where id::text like 'd0000000-%';
update profiles set role = 'admin' where id = 'd0000000-0000-0000-0000-0000000000ad';
insert into site_domains (hostname, purpose, is_active, is_primary_site) values ('main.example.test', 'both', true, true);
grant select, insert, update, delete on public.site_domains to authenticated;

set local role authenticated;
-- A signed-in admin cannot write the table directly any more.
select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-0000000000ad', true);
select set_config('request.jwt.claims', '{"aal":"aal2"}', true);
do $$ begin
  insert into site_domains (hostname) values ('direct.example.test');
  raise exception 'direct insert allowed';
exception when insufficient_privilege then null; end $$;
do $$ begin
  if (select count(*) from site_domains) < 1 then raise exception 'public read broken'; end if;
end $$;
-- Not an admin.
select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-0000000000c1', true);
do $$ begin
  perform admin_save_domain('pay.example.test');
  raise exception 'non-admin saved a domain';
exception when raise_exception then if sqlerrm <> 'Not authorized' then raise; end if; end $$;
-- Admin without aal2.
select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-0000000000ad', true);
select set_config('request.jwt.claims', '{"aal":"aal1"}', true);
do $$ begin
  perform admin_save_domain('pay.example.test');
  raise exception 'saved without aal2';
exception when raise_exception then if sqlerrm not like 'Enter your authenticator code%' then raise; end if; end $$;
select set_config('request.jwt.claims', '{"aal":"aal2"}', true);
do $$
declare r jsonb;
begin
  r := admin_save_domain('  HTTPS://Pay.Example.Test/some/path ', 'payment', true);
  if r->>'hostname' <> 'pay.example.test' or r->>'purpose' <> 'payment' then raise exception 'not normalised: %', r; end if;
  r := admin_save_domain('pay.example.test', 'both', false);
  if (r->>'is_active')::boolean then raise exception 'not turned off'; end if;
  begin perform admin_save_domain('not a domain'); raise exception 'bad host accepted';
  exception when raise_exception then if sqlerrm not like 'Enter a domain like%' then raise; end if; end;
  begin perform admin_save_domain('x.example.test', 'everything'); raise exception 'bad purpose accepted';
  exception when raise_exception then if sqlerrm not like 'Purpose must be%' then raise; end if; end;
  begin perform admin_save_domain('main.example.test', 'both', false); raise exception 'main domain turned off';
  exception when raise_exception then if sqlerrm not like 'This is the main site domain%' then raise; end if; end;
  begin perform admin_remove_domain('main.example.test'); raise exception 'main domain removed';
  exception when raise_exception then if sqlerrm not like 'This is the main site domain%' then raise; end if; end;
  if not admin_remove_domain('pay.example.test') then raise exception 'not removed'; end if;
end $$;
reset role;
do $$ begin
  if exists (select 1 from site_domains where hostname = 'pay.example.test') then raise exception 'still there'; end if;
  if (select count(*) from audit_log where action = 'settings.domain' and subject_id = 'pay.example.test') <> 3 then
    raise exception 'domain changes not audited'; end if;
end $$;
rollback;
\echo 'owner_domains_test: ok'
