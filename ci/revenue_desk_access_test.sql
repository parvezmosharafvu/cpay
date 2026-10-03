-- revenue_desk() returns platform-wide revenue. Only admins and the
-- service role may read it (20261003040000). Runs inside BEGIN/ROLLBACK.
\set ON_ERROR_STOP on
begin;

create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

insert into auth.users(id, email) values
  ('33333333-3333-3333-3333-333333333331', 'desk-admin@test.invalid'),
  ('33333333-3333-3333-3333-333333333332', 'desk-creator@test.invalid'),
  ('33333333-3333-3333-3333-333333333333', 'desk-reseller@test.invalid');

update public.profiles set role = 'admin', account_status = 'active'
 where id = '33333333-3333-3333-3333-333333333331';
update public.profiles set role = 'creator', account_status = 'active'
 where id = '33333333-3333-3333-3333-333333333332';
update public.profiles set role = 'moderator', account_status = 'active'
 where id = '33333333-3333-3333-3333-333333333333';

-- Grants: anon and PUBLIC have no EXECUTE at all.
do $$
begin
  if has_function_privilege('anon', 'public.revenue_desk()', 'execute') then
    raise exception 'anon can still EXECUTE revenue_desk()';
  end if;
  if exists (
    select 1
      from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     where p.oid = 'public.revenue_desk()'::regprocedure
       and a.grantee = 0 and a.privilege_type = 'EXECUTE'
  ) then
    raise exception 'PUBLIC can still EXECUTE revenue_desk()';
  end if;
  if not has_function_privilege('service_role', 'public.revenue_desk()', 'execute') then
    raise exception 'service_role lost EXECUTE on revenue_desk()';
  end if;
end $$;

-- 1. anon (the public anon key) is refused by the grant itself.
set local role anon;
do $$
declare v_denied boolean := false;
begin
  begin
    perform public.revenue_desk();
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then raise exception 'anon called revenue_desk()'; end if;
end $$;
reset role;

-- 2. Signed in, not admin: freelancer, reseller, and a JWT with no sub.
do $$
declare
  v_sub text;
  v_denied boolean;
begin
  foreach v_sub in array array[
    '33333333-3333-3333-3333-333333333332',
    '33333333-3333-3333-3333-333333333333',
    ''
  ] loop
    perform set_config('request.jwt.claim.sub', v_sub, true);
    perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_sub)::text, true);
    v_denied := false;
    execute 'set local role authenticated';
    begin
      perform public.revenue_desk();
    exception when insufficient_privilege then
      v_denied := true;
    end;
    execute 'reset role';
    if not v_denied then
      raise exception 'non-admin caller (sub=%) read revenue_desk()', coalesce(nullif(v_sub, ''), 'none');
    end if;
  end loop;
end $$;

-- 3. Admin gets the report.
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333331', true);
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"33333333-3333-3333-3333-333333333331"}', true);
set local role authenticated;
do $$
declare v jsonb;
begin
  v := public.revenue_desk();
  if v is null or not (v ? 'invoices' and v ? 'payouts' and v ? 'generated_at') then
    raise exception 'admin did not get the revenue_desk() report: %', v;
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
  v := public.revenue_desk();
  if v is null or not (v ? 'invoices' and v ? 'payouts') then
    raise exception 'service_role did not get the revenue_desk() report';
  end if;
end $$;
reset role;

rollback;
select 'revenue_desk() access checks passed' as result;
