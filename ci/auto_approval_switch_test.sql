-- M1: manual approval is mandatory; legacy admin switch cannot enable auto signup.
-- Only an active admin with a strong (aal2 / passkey) session can change it,
-- disabling remains strong-session protected and audited; every signup is pending. BEGIN/ROLLBACK.
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
  ('a2000000-0000-0000-0000-0000000000ad', 'aa-admin@test.invalid'),
  ('a2000000-0000-0000-0000-0000000000c1', 'aa-user@test.invalid');
update profiles set account_status = 'active' where id::text like 'a2000000-%';
update profiles set role = 'admin' where id = 'a2000000-0000-0000-0000-0000000000ad';

create function pg_temp.as_claims(p_sub text, p_claims text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_sub, true), set_config('request.jwt.claims', p_claims, true);
$$;

set local role authenticated;
-- A password-only admin session and a non-admin are refused.
do $$ begin
  perform pg_temp.as_claims('a2000000-0000-0000-0000-0000000000ad', '{"aal":"aal1"}');
  perform admin_set_auto_approval('freelancer', true);
  raise exception 'aal1 admin changed auto approval';
exception when raise_exception then if sqlerrm not like 'Sign in again with your passkey%' then raise; end if; end $$;
do $$ begin
  perform pg_temp.as_claims('a2000000-0000-0000-0000-0000000000c1', '{"aal":"aal2"}');
  perform admin_set_auto_approval('freelancer', true);
  raise exception 'non-admin changed auto approval';
exception when raise_exception then if sqlerrm <> 'Not authorized' then raise; end if; end $$;
-- A strong admin session may NOT enable automatic approval anymore.
do $$ begin
  perform pg_temp.as_claims('a2000000-0000-0000-0000-0000000000ad', '{"aal":"aal2"}');
  perform admin_set_auto_approval('freelancer', true);
  raise exception 'strong admin enabled auto approval';
exception when raise_exception then
  if sqlerrm <> 'Manual account approval is required' then raise; end if;
end $$;
-- Disabling is still permitted, audited, and requires a strong session.
do $$ begin
  perform admin_set_auto_approval('freelancer', false);
end $$;
reset role;

-- Old settings cannot bypass mandatory manual approval, even if a
-- historical operator value remains true in app_settings.
update app_settings set value='true'::jsonb where key='auto_approve_freelancer';
do $$ begin
  if cpay_auto_approval_enabled('freelancer') or cpay_auto_approval_enabled('reseller') then
    raise exception 'automatic approval still enabled';
  end if;
end $$;
insert into auth.users(id, email) values ('a2000000-0000-0000-0000-0000000000e1', 'aa-new-manual@test.invalid');
do $$ begin
  if (select account_status from profiles where id='a2000000-0000-0000-0000-0000000000e1') <> 'pending' or
     (select status from account_applications where user_id='a2000000-0000-0000-0000-0000000000e1') <> 'pending' then
    raise exception 'new signup activated without review';
  end if;
  if not exists (
    select 1 from audit_log where action='settings.auto_approval'
      and actor_id='a2000000-0000-0000-0000-0000000000ad'
      and new_value='{"value": false}'::jsonb
  ) then
    raise exception 'manual approval setting change not audited';
  end if;
end $$;

rollback;
\echo 'auto approval switch: OK'
