-- ============================================================
-- 20261017010000: account type, Individual or Business / Organization
-- ============================================================
\set ON_ERROR_STOP on
begin;
create or replace function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant select, update on public.profiles to authenticated;

-- Sign-ups: the form (individual, business), Google (no type), a client
-- sending something else, a business with a too-short or noisy name, and an
-- individual that also sent a business name.
insert into auth.users(id, email, raw_user_meta_data) values
  ('ac000000-0000-4000-8000-000000000001', 'solo@test.invalid', '{"display_name":"Solo","account_type":"individual"}'),
  ('ac000000-0000-4000-8000-000000000002', 'shop@test.invalid', '{"display_name":"Rina","account_type":"business","business_name":"  Rina Crafts Ltd  "}'),
  ('ac000000-0000-4000-8000-000000000003', 'google@test.invalid', '{"full_name":"Google Person"}'),
  ('ac000000-0000-4000-8000-000000000004', 'odd@test.invalid', '{"account_type":"admin","business_name":"Nope"}'),
  ('ac000000-0000-4000-8000-000000000005', 'short@test.invalid', '{"account_type":"business","business_name":"X"}'),
  ('ac000000-0000-4000-8000-000000000006', 'mixed@test.invalid', '{"account_type":"individual","business_name":"Ignored Co"}'),
  ('ac000000-0000-4000-8000-000000000007', 'long@test.invalid', jsonb_build_object('account_type', 'business', 'business_name', repeat('B', 200) || E'\n'));

do $$
declare r record;
begin
  for r in
    select * from (values
      ('ac000000-0000-4000-8000-000000000001'::uuid, 'individual', null::text),
      ('ac000000-0000-4000-8000-000000000002', 'business', 'Rina Crafts Ltd'),
      ('ac000000-0000-4000-8000-000000000003', 'individual', null),
      ('ac000000-0000-4000-8000-000000000004', 'individual', null),
      ('ac000000-0000-4000-8000-000000000005', 'business', null),
      ('ac000000-0000-4000-8000-000000000006', 'individual', null),
      ('ac000000-0000-4000-8000-000000000007', 'business', repeat('B', 120))
    ) as t(id, want_type, want_name)
  loop
    if not exists (select 1 from profiles p where p.id = r.id and p.account_type = r.want_type
                   and p.business_name is not distinct from r.want_name) then
      raise exception 'sign-up % gave %', r.id, (select row(account_type, business_name) from profiles where id = r.id);
    end if;
  end loop;
  -- The type grants nothing: role and approval are the same for both.
  if exists (select 1 from profiles where id::text like 'ac000000-%' and (role <> 'creator' or account_status <> 'pending')) then
    raise exception 'account type changed role or approval';
  end if;
  if (select count(*) from account_applications where user_id::text like 'ac000000-%') <> 7 then
    raise exception 'every sign-up still has an application row';
  end if;
  raise notice 'ok: sign-up records Individual or Business / Organization; anything else is Individual; nothing else changes';
end $$;

-- Existing rows and constraints.
do $$
begin
  if exists (select 1 from profiles where account_type is null) then raise exception 'account_type must never be null'; end if;
  begin
    update profiles set account_type = 'team' where id = 'ac000000-0000-4000-8000-000000000001';
    raise exception 'unknown account_type accepted';
  exception when check_violation then null; end;
  begin
    update profiles set business_name = 'Side Shop' where id = 'ac000000-0000-4000-8000-000000000001';
    raise exception 'business_name accepted on an individual account';
  exception when check_violation then null; end;
  begin
    update profiles set business_name = ' ' where id = 'ac000000-0000-4000-8000-000000000002';
    raise exception 'blank business_name accepted';
  exception when check_violation then null; end;
  raise notice 'ok: only individual or business; a business name only on a business account, 2-120 characters';
end $$;

-- The account holder cannot change either column (guard_profile_updates()).
do $$
declare v_denied boolean;
begin
  perform set_config('request.jwt.claim.sub', 'ac000000-0000-4000-8000-000000000002', true);
  perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"ac000000-0000-4000-8000-000000000002","aal":"aal1"}', true);
  execute 'set local role authenticated';
  v_denied := false;
  begin
    update profiles set account_type = 'individual', business_name = null where id = auth.uid();
  exception when others then v_denied := true; end;
  if not v_denied then raise exception 'a user changed their own account type'; end if;
  v_denied := false;
  begin
    update profiles set business_name = 'Renamed Ltd' where id = auth.uid();
  exception when others then v_denied := true; end;
  if not v_denied then raise exception 'a user changed their own business name'; end if;
  -- The allowlisted fields still work for the same account.
  update profiles set display_name = 'Rina Shop' where id = auth.uid();
  -- A non-admin cannot list applications.
  v_denied := false;
  begin
    perform * from public.admin_list_account_applications(null);
  exception when others then v_denied := true; end;
  if not v_denied then raise exception 'a non-admin listed applications'; end if;
  execute 'reset role';
  raise notice 'ok: users cannot change their account type or business name; applications stay admin-only';
end $$;

-- An admin sees the type and the business name on the application.
select set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);
insert into auth.users(id, email, raw_user_meta_data) values
  ('ac000000-0000-4000-8000-0000000000ad', 'admin.type@test.invalid', '{"display_name":"Type Admin"}');
update profiles set role = 'admin', account_status = 'active' where id = 'ac000000-0000-4000-8000-0000000000ad';

do $$
declare r record; n int := 0;
begin
  perform set_config('request.jwt.claim.sub', 'ac000000-0000-4000-8000-0000000000ad', true);
  perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"ac000000-0000-4000-8000-0000000000ad","aal":"aal2"}', true);
  execute 'set local role authenticated';
  for r in select * from public.admin_list_account_applications(null) where user_id::text like 'ac000000-%' loop
    n := n + 1;
    if r.user_id = 'ac000000-0000-4000-8000-000000000002' and (r.account_type <> 'business' or r.business_name <> 'Rina Crafts Ltd') then
      raise exception 'admin list lost the business: %', r;
    end if;
    if r.user_id = 'ac000000-0000-4000-8000-000000000003' and (r.account_type <> 'individual' or r.business_name is not null) then
      raise exception 'admin list mislabels an individual: %', r;
    end if;
  end loop;
  if n < 7 then raise exception 'admin list returned % applications', n; end if;
  -- The default still filters to pending.
  if exists (select 1 from public.admin_list_account_applications() where status <> 'pending') then
    raise exception 'default filter changed';
  end if;
  execute 'reset role';
  raise notice 'ok: admins see Individual or Business / Organization with the business name';
end $$;

do $$
begin
  if has_function_privilege('anon', 'public.admin_list_account_applications(text)', 'execute') then
    raise exception 'anon can execute admin_list_account_applications';
  end if;
  if not has_function_privilege('authenticated', 'public.admin_list_account_applications(text)', 'execute') then
    raise exception 'authenticated lost execute on admin_list_account_applications';
  end if;
  raise notice 'ok: grants unchanged';
end $$;
rollback;
