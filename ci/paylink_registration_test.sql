-- M1: registration contact fields, manual approval and profile immutability.
-- Run on the fully migrated CI database. All fixture changes rolled back.
\set ON_ERROR_STOP on
begin;

create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

insert into auth.users(id,email,raw_user_meta_data) values
  ('d1000000-0000-0000-0000-0000000000ad', 'paylink-m1-admin@test.invalid', '{}'::jsonb),
  ('d1000000-0000-0000-0000-0000000000a1', 'paylink-m1-user@test.invalid',
   '{"display_name":"Applicant One","phone":"+8801712345678","telegram_username":"test_user1","account_type":"individual"}'::jsonb),
  ('d1000000-0000-0000-0000-0000000000a2', 'paylink-m1-legacy@test.invalid', '{}'::jsonb);

update public.profiles set role='admin',account_status='active'
where id='d1000000-0000-0000-0000-0000000000ad';

do $$
declare p record;
begin
  select account_status, phone, telegram_username into p from public.profiles
  where id='d1000000-0000-0000-0000-0000000000a1';
  if p.account_status is distinct from 'pending'
    or p.phone is distinct from '+8801712345678'
    or p.telegram_username is distinct from 'test_user1' then
    raise exception 'new profile signup metadata was lost or auto-approved: %',row_to_json(p);
  end if;
  if not exists (
    select 1 from public.account_applications
    where user_id='d1000000-0000-0000-0000-0000000000a1' and status='pending'
  ) then raise exception 'new signup is missing pending application'; end if;
  if (select phone from public.profiles
      where id='d1000000-0000-0000-0000-0000000000a2') is not null then
    raise exception 'legacy profile should allow missing phone'; end if;
end $$;

-- A value supplied to the authentication trigger cannot bypass validation.
do $$
begin
  begin
    insert into auth.users(id,email,raw_user_meta_data) values
      ('d1000000-0000-0000-0000-0000000000b1','paylink-m1-badphone@test.invalid',
       '{"phone":"12345"}'::jsonb);
    raise exception 'invalid phone accepted';
  exception when others then
    if sqlerrm <> 'Invalid international phone number' then raise; end if;
  end;
  begin
    insert into auth.users(id,email,raw_user_meta_data) values
      ('d1000000-0000-0000-0000-0000000000b2','paylink-m1-badtelegram@test.invalid',
       '{"telegram_username":"@invalid"}'::jsonb);
    raise exception 'invalid Telegram username accepted';
  exception when others then
    if sqlerrm <> 'Invalid Telegram username' then raise; end if;
  end;
end $$;

-- Admin-only projection includes contacts, never a public endpoint.
select set_config('request.jwt.claim.sub', 'd1000000-0000-0000-0000-0000000000ad', true);
set local role authenticated;
do $$
declare p record;
begin
  select * into p from public.admin_list_account_applications(null)
  where user_id='d1000000-0000-0000-0000-0000000000a1';
  if p.phone is distinct from '+8801712345678'
     or p.telegram_username is distinct from 'test_user1' then
    raise exception 'admin review details omit contact values';
  end if;
end $$;
reset role;

-- An ordinary creator cannot update role, status or private contact fields.
select set_config('request.jwt.claim.sub', 'd1000000-0000-0000-0000-0000000000a1', true);
set local role authenticated;
do $$
begin
  begin
    update public.profiles set phone='+8801711111111'
    where id='d1000000-0000-0000-0000-0000000000a1';
    raise exception 'creator updated restricted phone';
  exception when others then
    if sqlerrm = 'creator updated restricted phone' then raise; end if;
  end;
  begin
    perform * from public.admin_list_account_applications(null);
    raise exception 'creator read admin application contacts';
  exception when others then
    if sqlerrm <> 'Not authorized' then raise; end if;
  end;
end $$;
reset role;

rollback;
\echo 'paylink_registration_test: all checks passed'
