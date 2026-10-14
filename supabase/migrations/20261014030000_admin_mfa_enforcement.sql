-- CPAY — 20261014030000: require two-step sign-in (aal2) for admins, behind a flag
--
-- Admin MFA, part 2 of 2. Ships OFF: app_settings.admin_mfa_required = false,
-- so nothing changes until the owner, with two authenticators enrolled,
-- turns it on from Admin → Settings.
--
-- When on:
--   * is_admin() is true only for an aal2 session. Every admin RPC and every
--     admin RLS policy goes through is_admin() (inventory in
--     ci/admin_mfa_enforcement_test.sql), so a direct PostgREST call with an
--     aal1 token cannot bypass it. admin-actions and auth-settings apply the
--     same rule at their gates.
--   * an admin cannot remove their last verified authenticator through
--     Supabase Auth (the owner's break-glass delete in the SQL editor still
--     works and is audited by 20261014020000).
-- Turning it on is refused unless the caller is aal2 and every active admin
-- has a verified authenticator, so enabling it cannot lock an admin out.
-- A JSON string "true" also counts as on (fail closed for a security flag).
--
-- Forward-only. Rollback: set admin_mfa_required to false (Admin → Settings,
-- or as the owner in the SQL editor).

insert into app_settings(key, value) values ('admin_mfa_required', 'false'::jsonb)
on conflict (key) do nothing;

create or replace function public.admin_mfa_enforced()
returns boolean
language sql stable security definer set search_path to 'public'
as $function$
  select coalesce((select value in ('true'::jsonb, '"true"'::jsonb) from app_settings where key = 'admin_mfa_required'), false);
$function$;
revoke all on function public.admin_mfa_enforced() from public, anon, authenticated;
grant execute on function public.admin_mfa_enforced() to service_role;

create or replace function public.is_admin()
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
select exists(select 1 from profiles where id = auth.uid() and role = 'admin' and account_status = 'active')
   and (not public.admin_mfa_enforced() or coalesce(auth.jwt() ->> 'aal', '') = 'aal2');
$function$;

-- Health (service role only): is enforcement on, and would it lock anyone out?
create or replace function public.admin_mfa_status()
returns jsonb
language sql stable security definer set search_path to 'public'
as $function$
  select jsonb_build_object(
    'enforced', public.admin_mfa_enforced(),
    'active_admins', (select count(*) from profiles where role = 'admin' and account_status = 'active'),
    'admins_without_factor', (select count(*) from profiles p
       where p.role = 'admin' and p.account_status = 'active'
         and not exists (select 1 from auth.mfa_factors f where f.user_id = p.id and f.status::text = 'verified')));
$function$;
revoke all on function public.admin_mfa_status() from public, anon, authenticated;
grant execute on function public.admin_mfa_status() to service_role;

create or replace function public.admin_set_feature_toggle(p_key text, p_enabled boolean)
returns boolean
language plpgsql security definer set search_path to 'public'
as $function$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if p_key not in (
    'emergency_payments_stop','emergency_withdrawals_stop','manual_withdrawals_enabled',
    'auto_withdraw_enabled','public_feed_enabled','hide_small_payments_enabled',
    'admin_mfa_required'
  ) then raise exception 'Unknown toggle'; end if;
  if p_key = 'admin_mfa_required' and p_enabled then
    if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
      raise exception 'Enter your authenticator code first (sign in again with two-step sign-in), then turn this on';
    end if;
    if exists (select 1 from profiles p
               where p.role = 'admin' and p.account_status = 'active'
                 and not exists (select 1 from auth.mfa_factors f where f.user_id = p.id and f.status::text = 'verified')) then
      raise exception 'Every active admin needs a verified authenticator before two-step sign-in can be required';
    end if;
  end if;
  insert into app_settings(key, value) values (p_key, to_jsonb(p_enabled))
  on conflict (key) do update set value = to_jsonb(p_enabled);
  perform record_audit('settings.feature_toggle', 'setting', p_key,
    null, jsonb_build_object('enabled', p_enabled));
  return p_enabled;
end;
$function$;

create or replace function public.guard_last_admin_factor()
returns trigger
language plpgsql security definer set search_path to 'public'
as $function$
begin
  -- session_user: Supabase Auth connects as supabase_auth_admin; the owner's
  -- break-glass delete in the SQL editor does not and is allowed (audited).
  if session_user = 'supabase_auth_admin'
     and old.status::text = 'verified'
     and public.admin_mfa_enforced()
     and exists (select 1 from profiles where id = old.user_id and role = 'admin' and account_status = 'active')
     and not exists (select 1 from auth.mfa_factors f
                     where f.user_id = old.user_id and f.id <> old.id and f.status::text = 'verified') then
    raise exception 'The last authenticator of an admin cannot be removed while two-step sign-in is required';
  end if;
  return old;
end;
$function$;
revoke all on function public.guard_last_admin_factor() from public, anon, authenticated, service_role;

do $do$
begin
  if to_regclass('auth.mfa_factors') is null then
    raise notice 'auth.mfa_factors not present: last-factor guard not installed';
    return;
  end if;
  execute 'drop trigger if exists guard_last_admin_factor on auth.mfa_factors';
  execute 'create trigger guard_last_admin_factor before delete on auth.mfa_factors
           for each row execute function public.guard_last_admin_factor()';
end
$do$;
