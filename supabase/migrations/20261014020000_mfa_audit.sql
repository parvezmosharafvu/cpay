-- CPAY — 20261014020000: audit trail for two-step sign-in (TOTP)
--
-- Admin MFA, part 1 of 2 (enrolment and challenge; no enforcement here).
--
-- 1. audit_mfa_factor_change(): an AFTER trigger on auth.mfa_factors writes
--    audit_log rows when a factor is enrolled, verified or removed. A removal
--    made outside Supabase Auth (the owner's break-glass delete in the SQL
--    editor, documented in docs/RUNBOOKS.md) is recorded as
--    security.mfa.factor_removed_by_operator.
--    It never copies the factor secret, and it can never block Supabase Auth:
--    any failure is downgraded to a warning.
-- 2. record_mfa_challenge_failure(): the browser reports a wrong code, for
--    the audit log only (Supabase Auth's own logs remain authoritative).
--    The caller's own row only, at most 20 an hour.
--
-- Forward-only. Rollback: drop trigger audit_mfa_factor_change on
-- auth.mfa_factors; drop function record_mfa_challenge_failure().

create or replace function public.audit_mfa_factor_change()
returns trigger
language plpgsql security definer set search_path to 'public'
as $function$
declare
  r record := coalesce(new, old);
  v_action text;
  v_actor uuid;
begin
  if tg_op = 'INSERT' then
    v_action := 'security.mfa.factor_enrolled';
  elsif tg_op = 'UPDATE' then
    if old.status::text is distinct from 'verified' and new.status::text = 'verified' then
      v_action := 'security.mfa.factor_verified';
    else
      return null;  -- last_challenged_at and similar bookkeeping: not audited
    end if;
  else
    -- session_user, not current_user: inside SECURITY DEFINER current_user is
    -- the function owner. Supabase Auth connects as supabase_auth_admin; the
    -- dashboard SQL editor (break-glass) does not.
    v_action := case when session_user = 'supabase_auth_admin'
      then 'security.mfa.factor_removed' else 'security.mfa.factor_removed_by_operator' end;
  end if;
  begin
    select id into v_actor from profiles where id = r.user_id;
    insert into audit_log (actor_id, actor_email, action, subject_type, subject_id, new_value, note)
    values (v_actor, (select email from profiles where id = r.user_id), v_action, 'user', r.user_id::text,
      jsonb_build_object('factor_id', r.id, 'factor_type', r.factor_type::text,
        'friendly_name', r.friendly_name, 'status', r.status::text),
      case when v_action = 'security.mfa.factor_removed_by_operator' then 'removed by ' || session_user end);
  exception when others then
    raise warning 'audit_mfa_factor_change: audit row not written (%)', sqlstate;
  end;
  return null;
end;
$function$;
revoke all on function public.audit_mfa_factor_change() from public, anon, authenticated, service_role;

do $do$
begin
  if to_regclass('auth.mfa_factors') is null then
    raise notice 'auth.mfa_factors not present: MFA audit trigger not installed';
    return;
  end if;
  execute 'drop trigger if exists audit_mfa_factor_change on auth.mfa_factors';
  execute 'create trigger audit_mfa_factor_change after insert or update of status or delete on auth.mfa_factors
           for each row execute function public.audit_mfa_factor_change()';
end
$do$;

create or replace function public.record_mfa_challenge_failure()
returns void
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return; end if;
  if (select count(*) from audit_log
      where actor_id = v_uid and action = 'security.mfa.challenge_failed'
        and occurred_at > now() - interval '1 hour') >= 20 then
    return;
  end if;
  insert into audit_log (actor_id, actor_email, action, subject_type, subject_id)
  select v_uid, p.email, 'security.mfa.challenge_failed', 'user', v_uid::text
  from profiles p where p.id = v_uid;
end;
$function$;
revoke all on function public.record_mfa_challenge_failure() from public, anon;
grant execute on function public.record_mfa_challenge_failure() to authenticated;
