-- ============================================================
-- Admin two-step sign-in enforcement (20261014030000)
-- ============================================================
-- Flag off: nothing changes. Flag on (JSON true, or the string "true"):
-- is_admin() needs an aal2 session, so a direct RPC or an admin RLS read
-- with an aal1 token is refused; turning the flag on needs aal2 and every
-- active admin enrolled; the last verified authenticator of an admin cannot
-- be removed through Supabase Auth (the owner's SQL-editor break-glass
-- still can). Inventory: no client-callable SECURITY DEFINER function and
-- no RLS policy checks role = 'admin' without is_admin(). BEGIN/ROLLBACK.
-- ============================================================
\set ON_ERROR_STOP on
begin;

create or replace function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.jwt() returns jsonb language sql stable
as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin nologin; end if;
end $$;
grant usage on schema auth, public to supabase_auth_admin;
grant select, insert, update, delete on auth.mfa_factors to supabase_auth_admin;

insert into auth.users(id, email) values
  ('77777777-7777-7777-7777-777777777771', 'enf-admin@test.invalid'),
  ('77777777-7777-7777-7777-777777777772', 'enf-admin2@test.invalid'),
  ('77777777-7777-7777-7777-777777777773', 'enf-creator@test.invalid');
update public.profiles set role = 'admin', account_status = 'active'
 where id in ('77777777-7777-7777-7777-777777777771', '77777777-7777-7777-7777-777777777772');
update public.profiles set role = 'creator', account_status = 'active' where id = '77777777-7777-7777-7777-777777777773';
-- Only these two admins are active for this test.
update public.profiles set account_status = 'suspended'
 where role = 'admin' and id not in ('77777777-7777-7777-7777-777777777771', '77777777-7777-7777-7777-777777777772');

-- act(sub, aal): a PostgREST-like caller.
create function pg_temp.act(p_sub text, p_aal text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
  perform set_config('request.jwt.claims', case when p_sub is null then '{"role":"anon"}'
    else json_build_object('role', 'authenticated', 'sub', p_sub, 'aal', p_aal)::text end, true);
end $$;
grant execute on function pg_temp.act(text, text) to anon, authenticated, service_role;
create function pg_temp.is_admin_as(p_sub text, p_aal text) returns boolean language plpgsql as $$
declare r boolean;
begin
  perform pg_temp.act(p_sub, p_aal);
  execute 'set local role authenticated';
  r := public.is_admin();
  execute 'reset role';
  return r;
end $$;
create function pg_temp.flag(v jsonb) returns void language sql as
$$ update app_settings set value = v where key = 'admin_mfa_required' $$;

-- Ships off; helpers are not callable by clients.
do $$ begin
  if (select value from app_settings where key = 'admin_mfa_required') is distinct from 'false'::jsonb then
    raise exception 'admin_mfa_required must ship as JSON false';
  end if;
  if has_function_privilege('authenticated', 'public.admin_mfa_enforced()', 'execute')
     or has_function_privilege('anon', 'public.admin_mfa_enforced()', 'execute')
     or has_function_privilege('authenticated', 'public.admin_mfa_status()', 'execute')
     or has_function_privilege('anon', 'public.admin_mfa_status()', 'execute')
     or has_function_privilege('authenticated', 'public.guard_last_admin_factor()', 'execute') then
    raise exception 'an admin-MFA helper is callable by a client role';
  end if;
  if not has_function_privilege('service_role', 'public.admin_mfa_status()', 'execute') then
    raise exception 'service_role cannot read admin_mfa_status()';
  end if;
  raise notice 'ok: ships off; helpers are service-role only';
end $$;

-- Flag off: aal1 admins are admins, as before.
do $$ begin
  if not pg_temp.is_admin_as('77777777-7777-7777-7777-777777777771', 'aal1') then raise exception 'flag off: aal1 admin refused'; end if;
  if pg_temp.is_admin_as('77777777-7777-7777-7777-777777777773', 'aal2') then raise exception 'creator is admin'; end if;
  raise notice 'ok: flag off changes nothing';
end $$;

-- Flag on (both spellings): aal1 refused, aal2 allowed, creators never.
do $$
declare v jsonb;
begin
  foreach v in array array['true'::jsonb, '"true"'::jsonb] loop
    perform pg_temp.flag(v);
    if pg_temp.is_admin_as('77777777-7777-7777-7777-777777777771', 'aal1') then raise exception 'flag %: aal1 admin passed', v; end if;
    if pg_temp.is_admin_as('77777777-7777-7777-7777-777777777771', null) then raise exception 'flag %: admin without aal passed', v; end if;
    if not pg_temp.is_admin_as('77777777-7777-7777-7777-777777777771', 'aal2') then raise exception 'flag %: aal2 admin refused', v; end if;
    if pg_temp.is_admin_as('77777777-7777-7777-7777-777777777773', 'aal2') then raise exception 'flag %: creator is admin', v; end if;
  end loop;
  perform pg_temp.flag('false'::jsonb);
  raise notice 'ok: flag on (true and "true") needs aal2';
end $$;

-- Direct PostgREST-style RPC and an admin RLS read, flag on.
select pg_temp.flag('true'::jsonb);
select pg_temp.act('77777777-7777-7777-7777-777777777771', 'aal1');
set local role authenticated;
do $$ begin
  begin
    perform public.admin_wallet_health();
    raise exception 'aal1 admin ran admin_wallet_health()';
  exception when others then
    if sqlerrm like 'aal1 admin ran%' then raise; end if;
  end;
  -- The RLS read needs Supabase's table grants (the privcheck database).
  if has_table_privilege('authenticated', 'public.profiles', 'select') then
    if (select count(*) from profiles where id = '77777777-7777-7777-7777-777777777773') <> 0 then
      raise exception 'aal1 admin read another user''s profile through RLS';
    end if;
  end if;
end $$;
reset role;
select pg_temp.act('77777777-7777-7777-7777-777777777771', 'aal2');
set local role authenticated;
do $$ begin
  perform public.admin_wallet_health();
  if has_table_privilege('authenticated', 'public.profiles', 'select') then
    if (select count(*) from profiles where id = '77777777-7777-7777-7777-777777777773') <> 1 then
      raise exception 'aal2 admin cannot read profiles through RLS';
    end if;
  end if;
end $$;
reset role;
select pg_temp.flag('false'::jsonb);
do $$ begin raise notice 'ok: direct RPC and RLS follow is_admin()'; end $$;

-- Turning it on: needs aal2, and every active admin enrolled.
insert into auth.mfa_factors(id, user_id, friendly_name, status) values
  ('88888888-8888-8888-8888-888888888881', '77777777-7777-7777-7777-777777777771', 'Phone', 'verified');
create function pg_temp.toggle_as(p_sub text, p_aal text, p_on boolean) returns text language plpgsql as $$
begin
  perform pg_temp.act(p_sub, p_aal);
  execute 'set local role authenticated';
  begin
    perform public.admin_set_feature_toggle('admin_mfa_required', p_on);
    execute 'reset role';
    return 'ok';
  exception when others then
    execute 'reset role';
    return sqlerrm;
  end;
end $$;
do $$
declare r text;
begin
  r := pg_temp.toggle_as('77777777-7777-7777-7777-777777777771', 'aal1', true);
  if r not like 'Enter your authenticator code first%' then raise exception 'enable at aal1: %', r; end if;
  r := pg_temp.toggle_as('77777777-7777-7777-7777-777777777771', 'aal2', true);
  if r not like 'Every active admin needs a verified authenticator%' then raise exception 'enable with an unenrolled admin: %', r; end if;
  insert into auth.mfa_factors(id, user_id, friendly_name, status) values
    ('88888888-8888-8888-8888-888888888882', '77777777-7777-7777-7777-777777777772', 'Phone', 'verified');
  r := pg_temp.toggle_as('77777777-7777-7777-7777-777777777771', 'aal2', true);
  if r <> 'ok' then raise exception 'enable at aal2 with everyone enrolled: %', r; end if;
  if (select value from app_settings where key = 'admin_mfa_required') <> 'true'::jsonb then raise exception 'flag not stored as JSON true'; end if;
  if not exists (select 1 from audit_log where action = 'settings.feature_toggle' and subject_id = 'admin_mfa_required') then
    raise exception 'enabling was not audited';
  end if;
  r := pg_temp.toggle_as('77777777-7777-7777-7777-777777777771', 'aal1', false);
  if r <> 'Not authorized' then raise exception 'aal1 admin turned enforcement off: %', r; end if;
  raise notice 'ok: enabling needs aal2 and every admin enrolled; aal1 cannot turn it off';
end $$;

-- Last-factor guard (flag on): Supabase Auth cannot remove an admin's only
-- verified authenticator; a second one can go; the operator can always.
insert into auth.mfa_factors(id, user_id, friendly_name, status) values
  ('88888888-8888-8888-8888-888888888883', '77777777-7777-7777-7777-777777777771', 'Backup', 'verified');
set local session authorization supabase_auth_admin;
delete from auth.mfa_factors where id = '88888888-8888-8888-8888-888888888883';
reset session authorization;
do $$
declare refused boolean := false;
begin
  begin
    execute 'set local session authorization supabase_auth_admin';
    delete from auth.mfa_factors where id = '88888888-8888-8888-8888-888888888881';
  exception when others then
    refused := sqlerrm like 'The last authenticator of an admin cannot be removed%';
  end;
  execute 'reset session authorization';
  if not refused then raise exception 'Supabase Auth removed an admin''s last authenticator while required'; end if;
  if not exists (select 1 from auth.mfa_factors where id = '88888888-8888-8888-8888-888888888881') then
    raise exception 'last factor gone';
  end if;
  raise notice 'ok: last factor kept while required; a second one could be removed';
end $$;
delete from auth.mfa_factors where id = '88888888-8888-8888-8888-888888888881';  -- owner break-glass
do $$ begin
  if exists (select 1 from auth.mfa_factors where id = '88888888-8888-8888-8888-888888888881') then
    raise exception 'operator break-glass delete was blocked';
  end if;
  if not exists (select 1 from audit_log where action = 'security.mfa.factor_removed_by_operator'
                 and subject_id = '77777777-7777-7777-7777-777777777771') then
    raise exception 'break-glass delete not audited';
  end if;
  raise notice 'ok: break-glass still works and is audited';
end $$;

-- admin_mfa_status(): lockout risk visible to health.
set local role service_role;
do $$
declare s jsonb := public.admin_mfa_status();
begin
  if s->>'enforced' <> 'true' or (s->>'admins_without_factor')::int <> 1 then
    raise exception 'admin_mfa_status: %', s;
  end if;
  raise notice 'ok: admin_mfa_status reports enforced with 1 admin locked out';
end $$;
reset role;

-- Inventory: is_admin() is the only admin gate a client can reach.
do $$
declare bad text;
begin
  select string_agg(p.proname, ', ') into bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef and p.proname <> 'is_admin'
     and has_function_privilege('authenticated', p.oid, 'execute')
     and p.prosrc ~* $q$role\s*=\s*'admin'|role\s+in\s*\([^)]*'admin'$q$
     and p.prosrc !~* 'is_admin\(\)';
  if bad is not null then raise exception 'role = ''admin'' checked without is_admin(): %', bad; end if;
  select string_agg(tablename || '.' || policyname, ', ') into bad
    from pg_policies
   where schemaname = 'public'
     and (coalesce(qual, '') || coalesce(with_check, '')) ~* $q$role\s*=\s*'admin'$q$;
  if bad is not null then raise exception 'RLS policy checks role = ''admin'' directly: %', bad; end if;
  raise notice 'ok: every client-reachable admin check goes through is_admin()';
end $$;

rollback;
