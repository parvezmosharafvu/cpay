-- ============================================================
-- Account approval after 20261005020000
-- ============================================================
-- A pending application, approved by an active admin through
-- admin_review_account_application(), gives exactly an active freelancer:
-- role 'creator', account_status 'active', application 'approved' and
-- reviewed by that admin, no reseller code or team (those columns no
-- longer exist), and no privilege beyond a freelancer's own account.
-- A suspended admin and a freelancer cannot decide applications.
-- Runs inside BEGIN/ROLLBACK on the migrated CI database.
-- ============================================================
\set ON_ERROR_STOP on
begin;

create or replace function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create function pg_temp.act(p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
  perform set_config('request.jwt.claims',
    case when p_sub is null then '{"role":"anon"}'
         else json_build_object('role', 'authenticated', 'sub', p_sub)::text end, true);
end $$;
grant execute on function pg_temp.act(text) to anon, authenticated, service_role;

create function pg_temp.refused(p_sql text, p_like text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm not like p_like then
      raise exception 'expected "%" from: %, got: %', p_like, p_sql, sqlerrm;
    end if;
    return;
  end;
  raise exception 'expected a refusal ("%") from: %', p_like, p_sql;
end $$;
grant execute on function pg_temp.refused(text, text) to anon, authenticated, service_role;

-- Rows a count query can see; a missing table grant (the plain CI
-- database has none) counts as nothing visible.
create function pg_temp.visible(p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute p_sql into n;
  return n;
exception when insufficient_privilege then
  return 0;
end $$;
grant execute on function pg_temp.visible(text) to anon, authenticated, service_role;

-- Fixtures:
--   aa = active admin, as = suspended admin, ff = an active freelancer,
--   p1 = applicant who asked for reseller with a code, p2 = applicant
--   rejected, p3 = applicant approved by nobody (suspended admin tries).
update app_settings set value = 'false' where key in ('auto_approve_freelancer', 'auto_approve_reseller');
insert into auth.users (id, email, raw_user_meta_data) values
  ('ab100000-0000-0000-0000-0000000000aa', 'appr-admin@test.invalid', '{}'),
  ('ab100000-0000-0000-0000-0000000000a5', 'appr-admin-suspended@test.invalid', '{}'),
  ('ab100000-0000-0000-0000-0000000000ff', 'appr-freelancer@test.invalid', '{}'),
  ('ab100000-0000-0000-0000-0000000000f1', 'appr-p1@test.invalid',
   '{"requested_role": "reseller", "affiliate_code": "rcodeAPPR", "display_name": "Applicant One"}'),
  ('ab100000-0000-0000-0000-0000000000f2', 'appr-p2@test.invalid', '{"display_name": "Applicant Two"}'),
  ('ab100000-0000-0000-0000-0000000000f3', 'appr-p3@test.invalid', '{"display_name": "Applicant Three"}');
update profiles set role = 'admin', account_status = 'active' where id = 'ab100000-0000-0000-0000-0000000000aa';
update profiles set role = 'admin', account_status = 'suspended' where id = 'ab100000-0000-0000-0000-0000000000a5';
update profiles set account_status = 'active' where id = 'ab100000-0000-0000-0000-0000000000ff';

-- 1. Sign-up leaves a pending freelancer application, whatever was asked.
do $$
declare r record;
begin
  for r in
    select p.id, p.role, p.account_status, a.requested_role, a.status
      from profiles p join account_applications a on a.user_id = p.id
     where p.id in ('ab100000-0000-0000-0000-0000000000f1', 'ab100000-0000-0000-0000-0000000000f2', 'ab100000-0000-0000-0000-0000000000f3')
  loop
    if r.role <> 'creator' or r.account_status <> 'pending' or r.requested_role <> 'freelancer' or r.status <> 'pending' then
      raise exception 'sign-up did not leave a pending freelancer application: %', row_to_json(r);
    end if;
  end loop;
  if (select count(*) from account_applications where user_id in ('ab100000-0000-0000-0000-0000000000f1', 'ab100000-0000-0000-0000-0000000000f2', 'ab100000-0000-0000-0000-0000000000f3') and status = 'pending') <> 3 then
    raise exception 'expected 3 pending applications';
  end if;
  raise notice 'PASS sign-up (even asking for reseller with a code) is a pending freelancer application';
end $$;

-- Application ids, read as postgres: authenticated has no grant on the table.
do $$
begin
  perform set_config('t.app1', (select id from account_applications where user_id = 'ab100000-0000-0000-0000-0000000000f1')::text, false);
  perform set_config('t.app2', (select id from account_applications where user_id = 'ab100000-0000-0000-0000-0000000000f2')::text, false);
  perform set_config('t.app3', (select id from account_applications where user_id = 'ab100000-0000-0000-0000-0000000000f3')::text, false);
  perform set_config('t.appa5', (select id from account_applications where user_id = 'ab100000-0000-0000-0000-0000000000a5')::text, false);
end $$;

-- 2. A suspended admin and a freelancer cannot decide an application.
do $$ begin perform pg_temp.act('ab100000-0000-0000-0000-0000000000a5'); end $$;
set local role authenticated;
do $$
declare v_app uuid := current_setting('t.app3')::uuid;
begin
  perform pg_temp.refused(format('select admin_review_account_application(%L, ''approved'', null)', v_app), 'Not authorized');
  raise notice 'PASS a suspended admin cannot approve an application';
end $$;
reset role;
do $$ begin perform pg_temp.act('ab100000-0000-0000-0000-0000000000ff'); end $$;
set local role authenticated;
do $$
declare v_app uuid := current_setting('t.app3')::uuid;
begin
  perform pg_temp.refused(format('select admin_review_account_application(%L, ''approved'', null)', v_app), 'Not authorized');
  raise notice 'PASS a freelancer cannot approve an application';
end $$;
reset role;
do $$
begin
  if (select account_status from profiles where id = 'ab100000-0000-0000-0000-0000000000f3') <> 'pending'
     or (select status from account_applications where user_id = 'ab100000-0000-0000-0000-0000000000f3') <> 'pending' then
    raise exception 'a refused decision changed the applicant';
  end if;
end $$;

-- 3. The active admin approves p1 and rejects p2.
do $$ begin perform pg_temp.act('ab100000-0000-0000-0000-0000000000aa'); end $$;
set local role authenticated;
do $$
begin
  perform admin_review_account_application(current_setting('t.app1')::uuid, 'approved', 'ok');
  perform admin_review_account_application(current_setting('t.app2')::uuid, 'rejected', null);
end $$;
reset role;
do $$
declare p profiles; a account_applications;
begin
  select * into p from profiles where id = 'ab100000-0000-0000-0000-0000000000f1';
  select * into a from account_applications where user_id = p.id;
  if p.role <> 'creator' or p.account_status <> 'active' then
    raise exception 'approved applicant is %/%, expected creator/active', p.role, p.account_status;
  end if;
  if a.status <> 'approved' or a.reviewed_by <> 'ab100000-0000-0000-0000-0000000000aa' or a.reviewed_at is null
     or a.requested_role <> 'freelancer' or a.review_note <> 'ok' then
    raise exception 'application row after approval: %', row_to_json(a);
  end if;
  -- No reseller code or team anywhere: the columns are gone.
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles'
              and column_name in ('affiliate_code', 'referred_by', 'cost_locked', 'team_cost_percent')) then
    raise exception 'reseller columns still exist on profiles';
  end if;
  if position('rcodeAPPR' in row_to_json(p)::text) > 0 then
    raise exception 'the requested reseller code was stored on the profile';
  end if;
  -- Nothing else on the profile moved: no fee override, no limits raised.
  if p.withdrawal_fee_percent is not null or p.platform_fee_percent is not null then
    raise exception 'approval set a fee override: %/%', p.withdrawal_fee_percent, p.platform_fee_percent;
  end if;
  if (select role || '/' || account_status from profiles where id = 'ab100000-0000-0000-0000-0000000000f2') <> 'creator/rejected'
     or (select status from account_applications where user_id = 'ab100000-0000-0000-0000-0000000000f2') <> 'rejected' then
    raise exception 'rejection did not produce a rejected freelancer';
  end if;
  raise notice 'PASS approval: creator/active, application approved by that admin, no reseller code, no fee override; rejection: creator/rejected';
end $$;

-- 4. The approved account has a freelancer's own access and nothing more.
insert into payment_links (id, user_id, slug, display_name)
values ('ab100000-0000-0000-0000-0000000001ff', 'ab100000-0000-0000-0000-0000000000ff', 'appr-other-link', 'Other');
do $$ begin perform pg_temp.act('ab100000-0000-0000-0000-0000000000f1'); end $$;
set local role authenticated;
do $$
begin
  if is_admin() then raise exception 'approved freelancer passes is_admin()'; end if;
  if pg_temp.visible('select count(*) from profiles where id <> auth.uid()') <> 0 then
    raise exception 'approved freelancer can read other profiles';
  end if;
  if pg_temp.visible('select count(*) from withdrawals where user_id <> auth.uid()') <> 0 then
    raise exception 'approved freelancer can read other withdrawals';
  end if;
  if pg_temp.visible('select count(*) from account_applications where user_id <> auth.uid()') <> 0 then
    raise exception 'approved freelancer can read other applications';
  end if;
  perform pg_temp.refused($q$select * from admin_list_people()$q$, 'Not authorized');
  perform pg_temp.refused($q$select * from admin_list_business_profiles()$q$, 'Not authorized');
  perform pg_temp.refused($q$select admin_set_role('ab100000-0000-0000-0000-0000000000f1', 'admin')$q$, 'Not authorized');
  perform pg_temp.refused($q$select admin_request_withdrawal_for('ab100000-0000-0000-0000-0000000000ff', 10, 'tron', '')$q$, 'Not authorized');
  perform pg_temp.refused($q$select admin_update_creator_fee('ab100000-0000-0000-0000-0000000000f1', 0)$q$, 'Not authorized');
  perform pg_temp.refused($q$select set_link_cost_percent('ab100000-0000-0000-0000-0000000001ff', 1)$q$, 'Not authorized');
  perform pg_temp.refused(format('select admin_review_account_application(%L, ''approved'', null)', current_setting('t.app3')), 'Not authorized');
  perform pg_temp.refused($q$update profiles set role = 'admin' where id = auth.uid()$q$, '%');
  perform pg_temp.refused($q$update profiles set withdrawal_fee_percent = 0 where id = auth.uid()$q$, '%');
  -- Its own account works: it can price its own account.
  perform set_my_cost_percent(2);
  raise notice 'PASS the approved freelancer is not an admin, sees only its own rows, cannot read applications and is refused every admin and cross-account call';
end $$;
reset role;
do $$
begin
  if (select role from profiles where id = 'ab100000-0000-0000-0000-0000000000f1') <> 'creator' then
    raise exception 'role changed';
  end if;
end $$;

-- 5. A decision never demotes an admin's role. (Before 20261005020000 a
-- reject or suspend decision set an admin's role to 'creator'. Approving
-- here makes the account active, which an active admin can already do
-- with admin_update_account_control(); a suspended admin can do neither.)
do $$ begin perform pg_temp.act('ab100000-0000-0000-0000-0000000000aa'); end $$;
set local role authenticated;
do $$
begin
  perform admin_review_account_application(current_setting('t.appa5')::uuid, 'approved', null);
end $$;
reset role;
do $$
begin
  if (select role || '/' || account_status from profiles where id = 'ab100000-0000-0000-0000-0000000000a5') <> 'admin/active' then
    raise exception 'approving an admin''s own application changed its role';
  end if;
  raise notice 'PASS approving an admin''s application keeps the admin role';
end $$;

rollback;
\echo 'account_approval_test: all checks passed'
