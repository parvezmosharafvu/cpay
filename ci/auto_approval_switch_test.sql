-- 20261028030000: Admin → Applications "Approve new sign-ups automatically".
-- Only an active admin with a strong (aal2 / passkey) session can change it,
-- each change leaves an audit row, and a sign-up after the change is active
-- (on) or pending (off). BEGIN/ROLLBACK.
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
-- A strong admin session turns it on; the switch reads it back.
do $$ begin
  perform pg_temp.as_claims('a2000000-0000-0000-0000-0000000000ad', '{"aal":"aal2"}');
  perform admin_set_auto_approval('freelancer', true);
  if not cpay_auto_approval_enabled('freelancer') then raise exception 'not on after set'; end if;
end $$;
reset role;

insert into auth.users(id, email) values ('a2000000-0000-0000-0000-0000000000e1', 'aa-new-on@test.invalid');
do $$ begin
  if (select account_status from profiles where id = 'a2000000-0000-0000-0000-0000000000e1') <> 'active' then
    raise exception 'sign-up with auto approval on is not active';
  end if;
  if not exists (select 1 from audit_log where action = 'settings.auto_approval'
                 and actor_id = 'a2000000-0000-0000-0000-0000000000ad' and new_value = '{"value": true}'::jsonb) then
    raise exception 'no audit row for the change';
  end if;
end $$;

set local role authenticated;
do $$ begin
  perform pg_temp.as_claims('a2000000-0000-0000-0000-0000000000ad', '{"aal":"aal2"}');
  perform admin_set_auto_approval('freelancer', false);
end $$;
reset role;
insert into auth.users(id, email) values ('a2000000-0000-0000-0000-0000000000e2', 'aa-new-off@test.invalid');
do $$ begin
  if (select account_status from profiles where id = 'a2000000-0000-0000-0000-0000000000e2') <> 'pending' then
    raise exception 'sign-up with auto approval off is not pending';
  end if;
end $$;

rollback;
\echo 'auto approval switch: OK'
