-- ============================================================
-- Two-step sign-in audit trail (20261014020000)
-- ============================================================
-- Enrol, verify and remove on auth.mfa_factors write audit_log rows; a
-- removal outside Supabase Auth is marked as the operator's; the factor
-- secret never reaches audit_log; a failing audit insert never blocks
-- Supabase Auth; record_mfa_challenge_failure() is the caller's own row,
-- capped at 20 an hour, authenticated only. BEGIN/ROLLBACK.
-- ============================================================
\set ON_ERROR_STOP on
begin;

create or replace function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin nologin;
  end if;
end $$;
grant usage on schema auth, public to supabase_auth_admin;
grant select, insert, update, delete on auth.mfa_factors to supabase_auth_admin;

insert into auth.users(id, email) values
  ('55555555-5555-5555-5555-555555555551', 'mfa-admin@test.invalid'),
  ('55555555-5555-5555-5555-555555555552', 'mfa-noprofile@test.invalid');
update public.profiles set role = 'admin', account_status = 'active'
 where id = '55555555-5555-5555-5555-555555555551';
delete from public.profiles where id = '55555555-5555-5555-5555-555555555552';

create function pg_temp.audits(p_action text) returns int language sql as
$$ select count(*)::int from audit_log where action = p_action and subject_id like '55555555-%' $$;

-- Grants.
do $$ begin
  if has_function_privilege('anon', 'public.audit_mfa_factor_change()', 'execute')
     or has_function_privilege('authenticated', 'public.audit_mfa_factor_change()', 'execute')
     or has_function_privilege('service_role', 'public.audit_mfa_factor_change()', 'execute') then
    raise exception 'a client role can EXECUTE the MFA audit trigger function';
  end if;
  if has_function_privilege('anon', 'public.record_mfa_challenge_failure()', 'execute') then
    raise exception 'anon can EXECUTE record_mfa_challenge_failure()';
  end if;
  if not has_function_privilege('authenticated', 'public.record_mfa_challenge_failure()', 'execute') then
    raise exception 'authenticated cannot EXECUTE record_mfa_challenge_failure()';
  end if;
  raise notice 'ok: grants';
end $$;

-- Enrol, bookkeeping, verify, remove: as Supabase Auth (its login role).
set local session authorization supabase_auth_admin;
insert into auth.mfa_factors(id, user_id, friendly_name, factor_type, status, secret)
values ('66666666-6666-6666-6666-666666666661', '55555555-5555-5555-5555-555555555551', 'Phone', 'totp', 'unverified', 'JBSWY3DPEHPK3PXPSECRETVALUE');
update auth.mfa_factors set last_challenged_at = now() where id = '66666666-6666-6666-6666-666666666661';
update auth.mfa_factors set status = 'verified' where id = '66666666-6666-6666-6666-666666666661';
insert into auth.mfa_factors(id, user_id, friendly_name, factor_type, status, secret)
values ('66666666-6666-6666-6666-666666666662', '55555555-5555-5555-5555-555555555551', 'Backup', 'totp', 'verified', 'ANOTHERSECRETVALUE234567');
delete from auth.mfa_factors where id = '66666666-6666-6666-6666-666666666662';
reset session authorization;

do $$ begin
  if pg_temp.audits('security.mfa.factor_enrolled') <> 2 then raise exception 'enrol: % rows, want 2', pg_temp.audits('security.mfa.factor_enrolled'); end if;
  if pg_temp.audits('security.mfa.factor_verified') <> 1 then raise exception 'verify: % rows, want 1 (bookkeeping updates must not be audited)', pg_temp.audits('security.mfa.factor_verified'); end if;
  if pg_temp.audits('security.mfa.factor_removed') <> 1 then raise exception 'Supabase Auth removal: % rows, want 1', pg_temp.audits('security.mfa.factor_removed'); end if;
  if pg_temp.audits('security.mfa.factor_removed_by_operator') <> 0 then raise exception 'Supabase Auth removal recorded as operator'; end if;
  if exists (select 1 from audit_log where subject_id like '55555555-%'
             and (new_value ? 'secret' or audit_log::text ilike '%SECRETVALUE%' or audit_log::text ilike '%ANOTHERSECRET%')) then
    raise exception 'the factor secret reached audit_log';
  end if;
  if not exists (select 1 from audit_log where action = 'security.mfa.factor_verified'
                 and actor_id = '55555555-5555-5555-5555-555555555551' and actor_email = 'mfa-admin@test.invalid'
                 and new_value->>'friendly_name' = 'Phone' and new_value->>'status' = 'verified') then
    raise exception 'verify row lacks actor or factor details';
  end if;
  raise notice 'ok: enrol / verify / remove audited, bookkeeping not, no secret';
end $$;

-- Break-glass: the owner deletes a factor in the SQL editor (not Supabase Auth).
delete from auth.mfa_factors where id = '66666666-6666-6666-6666-666666666661';
do $$ begin
  if not exists (select 1 from audit_log where action = 'security.mfa.factor_removed_by_operator'
                 and subject_id = '55555555-5555-5555-5555-555555555551' and note like 'removed by %') then
    raise exception 'operator removal not recorded as such';
  end if;
  raise notice 'ok: break-glass removal recorded as the operator''s';
end $$;

-- A user with no profile row, and an audit table that refuses the insert:
-- Supabase Auth must still succeed.
insert into auth.mfa_factors(user_id, friendly_name, status) values ('55555555-5555-5555-5555-555555555552', 'Phone', 'unverified');
alter table audit_log add constraint mfa_test_refuse check (action not like 'security.mfa.%') not valid;
insert into auth.mfa_factors(user_id, friendly_name, status) values ('55555555-5555-5555-5555-555555555551', 'Third', 'unverified');
alter table audit_log drop constraint mfa_test_refuse;
do $$ begin
  if (select count(*) from auth.mfa_factors where friendly_name = 'Third') <> 1 then
    raise exception 'a failing audit insert blocked Supabase Auth';
  end if;
  raise notice 'ok: audit failures never block Supabase Auth';
end $$;

-- record_mfa_challenge_failure(): own row, capped, nothing without a user.
set local role authenticated;
select set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555551', true);
select public.record_mfa_challenge_failure() from generate_series(1, 25);
select set_config('request.jwt.claim.sub', '', true);
select public.record_mfa_challenge_failure();
reset role;
do $$ begin
  if (select count(*) from audit_log where action = 'security.mfa.challenge_failed'
        and actor_id = '55555555-5555-5555-5555-555555555551') <> 20 then
    raise exception 'challenge failures: % rows, want 20 (cap)',
      (select count(*) from audit_log where action = 'security.mfa.challenge_failed' and actor_id = '55555555-5555-5555-5555-555555555551');
  end if;
  if exists (select 1 from audit_log where action = 'security.mfa.challenge_failed' and actor_id is null) then
    raise exception 'a challenge failure was recorded without a user';
  end if;
  raise notice 'ok: challenge failures are the caller''s own, capped at 20 an hour';
end $$;

rollback;
