-- 20261021020000: a passkey sign-in is the strong factor. Every check that
-- needed aal2 accepts a passkey session (amr "passkey") and still refuses a
-- password-only (aal1) session; Google ("oauth") no longer counts as a
-- fresh sign-in; admin_mfa_required needs every active admin to have a
-- passkey. BEGIN/ROLLBACK.
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
  ('a1000000-0000-0000-0000-0000000000ad', 'pk-admin@test.invalid'),
  ('a1000000-0000-0000-0000-0000000000c1', 'pk-user@test.invalid');
update profiles set account_status = 'active' where id::text like 'a1000000-%';
update profiles set role = 'admin' where id = 'a1000000-0000-0000-0000-0000000000ad';
-- The admin has an old authenticator (as in production today).
insert into auth.mfa_factors(user_id, friendly_name, status) values ('a1000000-0000-0000-0000-0000000000ad', 'Phone', 'verified');

create function pg_temp.as_claims(p_sub text, p_claims text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_sub, true), set_config('request.jwt.claims', p_claims, true);
$$;

set local role authenticated;
-- 1. strong_session(): aal2 or a passkey sign-in; nothing else.
do $$ declare t bigint := extract(epoch from now())::bigint; begin
  perform pg_temp.as_claims('a1000000-0000-0000-0000-0000000000ad', '{"aal":"aal2"}');
  if not strong_session() then raise exception 'aal2 not strong'; end if;
  perform pg_temp.as_claims('a1000000-0000-0000-0000-0000000000ad', format('{"aal":"aal1","amr":[{"method":"passkey","timestamp":%s}]}', t));
  if not strong_session() then raise exception 'passkey not strong'; end if;
  perform pg_temp.as_claims('a1000000-0000-0000-0000-0000000000ad', format('{"aal":"aal1","amr":[{"method":"password","timestamp":%s}]}', t));
  if strong_session() then raise exception 'password is strong'; end if;
  perform pg_temp.as_claims('a1000000-0000-0000-0000-0000000000ad', format('{"aal":"aal1","amr":[{"method":"oauth","timestamp":%s}]}', t));
  if strong_session() then raise exception 'oauth is strong'; end if;
  perform pg_temp.as_claims('a1000000-0000-0000-0000-0000000000ad', '{"aal":"aal1","amr":"passkey"}');
  if strong_session() then raise exception 'malformed amr is strong'; end if;
end $$;

-- 2. is_admin(): a password-only session of an admin with an old factor is
--    not an admin (no weakening); a passkey session is.
do $$ declare t bigint := extract(epoch from now())::bigint; begin
  perform pg_temp.as_claims('a1000000-0000-0000-0000-0000000000ad', format('{"aal":"aal1","amr":[{"method":"password","timestamp":%s}]}', t));
  if is_admin() then raise exception 'password-only admin accepted'; end if;
  perform pg_temp.as_claims('a1000000-0000-0000-0000-0000000000ad', format('{"aal":"aal1","amr":[{"method":"passkey","timestamp":%s}]}', t));
  if not is_admin() then raise exception 'passkey admin refused (lockout)'; end if;
end $$;

-- 3. Admin RPCs that always needed aal2 accept a passkey session and refuse aal1.
do $$ declare t bigint := extract(epoch from now())::bigint; begin
  perform pg_temp.as_claims('a1000000-0000-0000-0000-0000000000ad', format('{"aal":"aal1","amr":[{"method":"passkey","timestamp":%s}]}', t));
  perform admin_auto_withdraw_overview();
  perform admin_locations(null, null, 30, 10);
end $$;
-- Without the old factor and with the flag off, an aal1 admin passes is_admin()
-- but the always-strong RPCs still refuse it.
reset role;
delete from auth.mfa_factors where user_id = 'a1000000-0000-0000-0000-0000000000ad';
insert into app_settings(key, value) values ('admin_mfa_required', 'false'::jsonb) on conflict (key) do update set value = excluded.value;
set local role authenticated;
do $$ declare t bigint := extract(epoch from now())::bigint; begin
  perform pg_temp.as_claims('a1000000-0000-0000-0000-0000000000ad', format('{"aal":"aal1","amr":[{"method":"password","timestamp":%s}]}', t));
  begin
    perform admin_auto_withdraw_overview();
    raise exception 'overview without a passkey';
  exception when raise_exception then if sqlerrm not like 'Sign in again with your passkey%' then raise; end if; end;
  begin
    perform admin_set_platform_setting('legal_published', 'false'::jsonb);
    raise exception 'settings without a passkey';
  exception when raise_exception then if sqlerrm not like 'Sign in again with your passkey%' then raise; end if; end;
  begin
    perform admin_set_auto_withdraw_global(true);
    raise exception 'auto withdraw switch without a passkey';
  exception when raise_exception then if sqlerrm not like 'Sign in again with your passkey%' then raise; end if; end;
end $$;

-- 4. admin_mfa_required: refused while an active admin has no passkey,
--    accepted once every active admin has one.
do $$ declare t bigint := extract(epoch from now())::bigint; begin
  perform pg_temp.as_claims('a1000000-0000-0000-0000-0000000000ad', format('{"aal":"aal1","amr":[{"method":"passkey","timestamp":%s}]}', t));
  begin
    perform admin_set_feature_toggle('admin_mfa_required', true);
    raise exception 'required while an admin has no passkey';
  exception when raise_exception then if sqlerrm not like 'Every active admin needs a passkey%' then raise; end if; end;
end $$;
reset role;
insert into auth.webauthn_credentials(user_id, friendly_name)
  select p.id, 'Phone' from profiles p where p.role = 'admin' and p.account_status = 'active';
set local role authenticated;
do $$ declare t bigint := extract(epoch from now())::bigint; begin
  perform pg_temp.as_claims('a1000000-0000-0000-0000-0000000000ad', format('{"aal":"aal1","amr":[{"method":"passkey","timestamp":%s}]}', t));
  if not admin_set_feature_toggle('admin_mfa_required', true) then raise exception 'not turned on'; end if;
  if (admin_passkey_status() ->> 'admins_without_passkey')::int <> 0 then raise exception 'status wrong'; end if;
  -- Now a password-only admin is refused everywhere.
  perform pg_temp.as_claims('a1000000-0000-0000-0000-0000000000ad', format('{"aal":"aal1","amr":[{"method":"password","timestamp":%s}]}', t));
  if is_admin() then raise exception 'flag on: password-only admin accepted'; end if;
end $$;

-- 5. Payout step-up: Google no longer counts; an account with an old factor
--    needs a passkey session; a fresh password still works without one.
reset role;
insert into auth.mfa_factors(user_id, friendly_name, status) values ('a1000000-0000-0000-0000-0000000000c1', 'Phone', 'verified');
do $$ declare t bigint := extract(epoch from now())::bigint; begin
  perform pg_temp.as_claims('a1000000-0000-0000-0000-0000000000c1', format('{"role":"authenticated","aal":"aal1","amr":[{"method":"password","timestamp":%s}]}', t));
  if payout_step_up_ok(600) then raise exception 'old-factor account: password alone passed'; end if;
  perform pg_temp.as_claims('a1000000-0000-0000-0000-0000000000c1', format('{"role":"authenticated","aal":"aal1","amr":[{"method":"passkey","timestamp":%s}]}', t));
  if not payout_step_up_ok(600) then raise exception 'fresh passkey refused'; end if;
  perform pg_temp.as_claims('a1000000-0000-0000-0000-0000000000c1', format('{"role":"authenticated","aal":"aal1","amr":[{"method":"passkey","timestamp":%s}]}', t - 3600));
  if payout_step_up_ok(600) then raise exception 'stale passkey passed'; end if;
end $$;
reset role;
delete from auth.mfa_factors where user_id = 'a1000000-0000-0000-0000-0000000000c1';
do $$ declare t bigint := extract(epoch from now())::bigint; begin
  perform pg_temp.as_claims('a1000000-0000-0000-0000-0000000000c1', format('{"role":"authenticated","aal":"aal1","amr":[{"method":"oauth","timestamp":%s}]}', t));
  if payout_step_up_ok(600) then raise exception 'Google sign-in still counts'; end if;
  perform pg_temp.as_claims('a1000000-0000-0000-0000-0000000000c1', format('{"role":"authenticated","aal":"aal1","amr":[{"method":"password","timestamp":%s}]}', t));
  if not payout_step_up_ok(600) then raise exception 'fresh password refused'; end if;
end $$;

-- 6. A payout address change: refused without a passkey session (no 24-hour
--    wait), at once with one; another account's passkey session does not count.
reset role;
do $$ declare t bigint := extract(epoch from now())::bigint; begin
  perform pg_temp.as_claims('a1000000-0000-0000-0000-0000000000c1', format('{"role":"authenticated","aal":"aal1","amr":[{"method":"passkey","timestamp":%s}]}', t));
  if payout_ready_at('a1000000-0000-0000-0000-0000000000c1') > now() then raise exception 'passkey change waits'; end if;
  begin
    perform payout_ready_at('a1000000-0000-0000-0000-0000000000ad');
    raise exception 'another account''s passkey session counted';
  exception when raise_exception then if sqlerrm <> 'Confirm with your passkey to change address' then raise; end if; end;
  perform pg_temp.as_claims('a1000000-0000-0000-0000-0000000000c1', format('{"role":"authenticated","aal":"aal1","amr":[{"method":"password","timestamp":%s}]}', t));
  begin
    perform payout_ready_at('a1000000-0000-0000-0000-0000000000c1');
    raise exception 'password change accepted';
  exception when raise_exception then if sqlerrm <> 'Confirm with your passkey to change address' then raise; end if; end;
end $$;

-- 7. Grants.
do $$ begin
  if has_function_privilege('anon', 'public.strong_session()', 'execute') then raise exception 'strong_session open to anon'; end if;
  if has_function_privilege('authenticated', 'public.user_has_passkey(uuid)', 'execute') then raise exception 'user_has_passkey exposed'; end if;
  if has_function_privilege('anon', 'public.admin_passkey_status()', 'execute') then raise exception 'admin_passkey_status open to anon'; end if;
end $$;
\echo 'passkey step-up: ok'
rollback;
