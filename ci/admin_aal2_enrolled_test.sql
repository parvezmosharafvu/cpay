-- ============================================================
-- An admin with a verified authenticator needs aal2 (20261014080000)
-- ============================================================
-- Flag off throughout. Admin without a factor: aal1 still admin (no
-- lock-out). Same admin after enrolling: aal1 refused, aal2 admin. An
-- unverified factor changes nothing. A creator never becomes admin. The
-- admin RPC path (admin_set_feature_toggle) follows. BEGIN/ROLLBACK.
-- ============================================================
\set ON_ERROR_STOP on
begin;

create or replace function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.jwt() returns jsonb language sql stable
as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;

insert into auth.users(id, email) values
  ('7a7a7a7a-0000-4000-8000-000000000001', 'aal-admin@test.invalid'),
  ('7a7a7a7a-0000-4000-8000-000000000002', 'aal-creator@test.invalid');
update public.profiles set role = 'admin', account_status = 'active' where id = '7a7a7a7a-0000-4000-8000-000000000001';
update public.profiles set role = 'creator', account_status = 'active' where id = '7a7a7a7a-0000-4000-8000-000000000002';
update app_settings set value = 'false'::jsonb where key = 'admin_mfa_required';

create function pg_temp.is_admin_as(p_sub text, p_aal text) returns boolean language plpgsql as $$
declare r boolean;
begin
  perform set_config('request.jwt.claim.sub', p_sub, true);
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', p_sub, 'aal', p_aal)::text, true);
  execute 'set local role authenticated';
  r := public.is_admin();
  execute 'reset role';
  return r;
end $$;

do $$
declare a text := '7a7a7a7a-0000-4000-8000-000000000001'; c text := '7a7a7a7a-0000-4000-8000-000000000002';
begin
  if not pg_temp.is_admin_as(a, 'aal1') then raise exception 'no factor: aal1 admin refused (lock-out)'; end if;
  if not pg_temp.is_admin_as(a, 'aal2') then raise exception 'no factor: aal2 admin refused'; end if;

  insert into auth.mfa_factors(id, user_id, friendly_name, status) values
    ('7b7b7b7b-0000-4000-8000-000000000001', a::uuid, 'Pending', 'unverified');
  if not pg_temp.is_admin_as(a, 'aal1') then raise exception 'unverified factor must not change anything'; end if;

  insert into auth.mfa_factors(id, user_id, friendly_name, status) values
    ('7b7b7b7b-0000-4000-8000-000000000002', a::uuid, 'Phone', 'verified');
  if pg_temp.is_admin_as(a, 'aal1') then raise exception 'enrolled admin passed at aal1'; end if;
  if pg_temp.is_admin_as(a, null) then raise exception 'enrolled admin passed without aal'; end if;
  if not pg_temp.is_admin_as(a, 'aal2') then raise exception 'enrolled admin refused at aal2'; end if;

  if pg_temp.is_admin_as(c, 'aal2') then raise exception 'creator is admin'; end if;
  raise notice 'ok: a verified authenticator alone makes is_admin() need aal2';
end $$;

-- An admin RPC refuses the enrolled admin's aal1 token.
do $$
declare r text;
begin
  perform set_config('request.jwt.claim.sub', '7a7a7a7a-0000-4000-8000-000000000001', true);
  perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"7a7a7a7a-0000-4000-8000-000000000001","aal":"aal1"}', true);
  execute 'set local role authenticated';
  begin
    perform public.admin_set_feature_toggle('admin_mfa_required', false);
    r := 'ok';
  exception when others then r := sqlerrm;
  end;
  execute 'reset role';
  if r = 'ok' then raise exception 'admin RPC ran for an enrolled admin at aal1'; end if;
  raise notice 'ok: admin RPC refused at aal1 once enrolled (%)', r;
end $$;

rollback;
