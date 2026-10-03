\set ON_ERROR_STOP on
begin;

create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated;
grant execute on function auth.uid() to authenticated;
grant select on public.profiles to authenticated;

insert into auth.users(id, email)
values
  ('22222222-2222-2222-2222-222222222222', 'profile-test@test.invalid'),
  ('33333333-3333-3333-3333-333333333333', 'profile-team-test@test.invalid');

update public.profiles
set account_status = 'active',
    role = 'moderator',
    cost_locked = false
where id = '22222222-2222-2222-2222-222222222222';

update public.profiles
set account_status = 'active',
    referred_by = '22222222-2222-2222-2222-222222222222'
where id = '33333333-3333-3333-3333-333333333333';

select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
set local role authenticated;

update public.profiles
set display_name = 'Allowed Name'
where id = auth.uid();

select public.update_my_public_profile('Updated Name', 'Allowed bio', 'profile-test-store');
select public.set_my_cost_percent(2.5);
select public.set_my_payout_prefs(5, null, true);
select public.reseller_lock_team_cost(2.5, true);

do $$
declare
  v_profile public.profiles;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if v_profile.display_name <> 'Updated Name'
     or v_profile.bio <> 'Allowed bio'
     or v_profile.public_slug <> 'profile-test-store'
     or v_profile.cost_percent <> 2.5
     or v_profile.withdraw_threshold <> 5
     or not v_profile.auto_withdraw_enabled then
    raise exception 'A supported user profile update was rejected';
  end if;
end $$;

do $$
declare
  v_field text;
  v_value text;
  v_denied boolean;
begin
  foreach v_field in array array[
    'role',
    'platform_fee_percent',
    'affiliate_code',
    'verification_status',
    'cost_locked',
    'team_cost_percent'
  ] loop
    v_value := case v_field
      when 'role' then 'admin'
      when 'platform_fee_percent' then '99'
      when 'affiliate_code' then 'untrusted-code'
      when 'cost_locked' then 'true'
      when 'team_cost_percent' then '99'
      else 'verified'
    end;
    v_denied := false;
    begin
      execute format(
        'update public.profiles set %I = %L where id = auth.uid()',
        v_field, v_value
      );
    exception
      when insufficient_privilege or raise_exception then
        v_denied := true;
    end;
    if not v_denied then
      raise exception 'Authenticated update unexpectedly changed protected profile field %', v_field;
    end if;
  end loop;
end $$;

reset role;

do $$
declare
  v_reseller public.profiles;
  v_creator public.profiles;
begin
  select * into v_reseller
  from public.profiles
  where id = '22222222-2222-2222-2222-222222222222';
  select * into v_creator
  from public.profiles
  where id = '33333333-3333-3333-3333-333333333333';
  if v_reseller.team_cost_percent <> 2.5
     or v_creator.cost_percent <> 2.5
     or v_creator.cost_locked is distinct from true then
    raise exception 'The reseller cost RPC could not update its protected profile fields';
  end if;
end $$;

do $$
declare
  v_denied boolean := false;
begin
  begin
    update public.profiles
    set platform_fee_percent = 99
    where id = auth.uid();
  exception when raise_exception then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'Profile trigger accepted a protected field change';
  end if;
end $$;

rollback;
select 'Profile update whitelist regression checks passed' as result;
