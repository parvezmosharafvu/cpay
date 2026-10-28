-- CPAY — 20261028020000: let the admin Edge Functions' own audit rows in.
-- audit_log_guard (0103) lets service_role write only platform wallet sends,
-- so these direct inserts were always refused and logged "audit_log write
-- failed" (the action itself still happened):
--   owner-config    settings.secret, settings.cloudflare   (Secrets & keys,
--                   Cloudflare Always Use HTTPS; names only, never values)
--   auth-settings   settings.signup_email_confirmation
--   admin-actions   withdrawal.rejected_by_admin, withdrawal.marked_paid_manual
-- Each is allowed only with its own subject_type and an actor. Everything
-- else from service_role is still refused, and the log stays append-only.
-- Rollback: re-run 0103_audit_log_hardening.sql's audit_log_guard().

create or replace function public.audit_log_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if current_user in ('postgres', 'supabase_admin') then
      return new;
    end if;
    if current_user = 'service_role'
       and new.subject_type = 'platform_wallet_send'
       and new.action in ('platform_wallet.send', 'platform_wallet.send.result') then
      return new;
    end if;
    if current_user = 'service_role' and new.actor_id is not null
       and ((new.subject_type = 'settings'
             and new.action in ('settings.secret', 'settings.cloudflare', 'settings.signup_email_confirmation'))
         or (new.subject_type = 'withdrawal'
             and new.action in ('withdrawal.rejected_by_admin', 'withdrawal.marked_paid_manual'))) then
      return new;
    end if;
    raise exception 'audit_log accepts writes only from the audit function';
  end if;

  if current_user in ('postgres', 'supabase_admin')
     and current_setting('cpay.audit_maintenance', true) = 'on' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return null;
  end if;

  raise exception 'audit_log is append-only';
end;
$$;
