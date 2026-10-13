-- admin_wallet_health() (20261013080000): only active admins and the
-- service role may read the Health cards. Runs inside BEGIN/ROLLBACK.
\set ON_ERROR_STOP on
begin;

create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

insert into auth.users(id, email) values
  ('44444444-4444-4444-4444-444444444441', 'hc-admin@test.invalid'),
  ('44444444-4444-4444-4444-444444444442', 'hc-creator@test.invalid'),
  ('44444444-4444-4444-4444-444444444443', 'hc-pending@test.invalid');

update public.profiles set role = 'admin', account_status = 'active'
 where id = '44444444-4444-4444-4444-444444444441';
update public.profiles set role = 'creator', account_status = 'active'
 where id = '44444444-4444-4444-4444-444444444442';
update public.profiles set role = 'creator', account_status = 'pending'
 where id = '44444444-4444-4444-4444-444444444443';

-- Grants: anon and PUBLIC have no EXECUTE at all.
do $$
begin
  if has_function_privilege('anon', 'public.admin_wallet_health()', 'execute') then
    raise exception 'anon can still EXECUTE admin_wallet_health()';
  end if;
  if exists (
    select 1
      from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     where p.oid = 'public.admin_wallet_health()'::regprocedure
       and a.grantee = 0 and a.privilege_type = 'EXECUTE'
  ) then
    raise exception 'PUBLIC can still EXECUTE admin_wallet_health()';
  end if;
  if not has_function_privilege('service_role', 'public.admin_wallet_health()', 'execute') then
    raise exception 'service_role lost EXECUTE on admin_wallet_health()';
  end if;
end $$;

-- 1. anon (the public anon key) is refused by the grant itself.
set local role anon;
do $$
declare v_denied boolean := false;
begin
  begin
    perform public.admin_wallet_health();
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then raise exception 'anon called admin_wallet_health()'; end if;
end $$;
reset role;

-- 2. Signed in, not admin: an active freelancer, a pending one, and a JWT with no sub.
do $$
declare
  v_sub text;
  v_denied boolean;
begin
  foreach v_sub in array array[
    '44444444-4444-4444-4444-444444444442',
    '44444444-4444-4444-4444-444444444443',
    ''
  ] loop
    perform set_config('request.jwt.claim.sub', v_sub, true);
    perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_sub)::text, true);
    v_denied := false;
    execute 'set local role authenticated';
    begin
      perform public.admin_wallet_health();
    exception when insufficient_privilege then
      v_denied := true;
    end;
    execute 'reset role';
    if not v_denied then
      raise exception 'non-admin caller (sub=%) read admin_wallet_health()', coalesce(nullif(v_sub, ''), 'none');
    end if;
  end loop;
end $$;

-- 3. Admin gets the report.
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444441', true);
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"44444444-4444-4444-4444-444444444441"}', true);
set local role authenticated;
do $$
declare v jsonb;
begin
  v := public.admin_wallet_health();
  if v is null or jsonb_array_length(v->'cards') <> 8 or not (v->'cards'->0 ? 'state' and v->'cards'->0 ? 'runbook') then
    raise exception 'admin did not get the admin_wallet_health() report: %', v;
  end if;
end $$;
reset role;

-- 4. Service role (server-side callers) gets the report.
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
do $$
declare v jsonb;
begin
  v := public.admin_wallet_health();
  if v is null or jsonb_array_length(v->'cards') <> 8 then
    raise exception 'service_role did not get the admin_wallet_health() report';
  end if;
end $$;
reset role;

rollback;
select 'admin_wallet_health() access checks passed' as result;
