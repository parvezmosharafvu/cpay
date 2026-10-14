-- CPAY — 20261014080000: an admin who has an authenticator needs aal2
--
-- Until now is_admin() asked for aal2 only while
-- app_settings.admin_mfa_required is on. An admin who had already enrolled
-- an authenticator could still act with a password-only (aal1) token, for
-- example a token from a password-reset link, or a direct API call that
-- skipped the code prompt. Now a verified authenticator by itself is enough
-- to require aal2 for that admin, flag or not.
--
-- No lock-out: an admin without an authenticator is unaffected (the flag
-- rule is unchanged), and an admin with one can always reach aal2 by
-- entering a code. Production on 2026-10-14: one admin, no authenticators,
-- so behaviour does not change until the owner enrols.
--
-- The Edge Function admin gates (admin-actions, auth-settings) apply the
-- same rule (_shared/admin-mfa.ts).
--
-- Forward-only. Rollback: re-create is_admin() from 20261014030000.

create or replace function public.is_admin()
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
select exists(select 1 from profiles where id = auth.uid() and role = 'admin' and account_status = 'active')
   and (coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
        or (not public.admin_mfa_enforced()
            and not exists (select 1 from auth.mfa_factors f
                            where f.user_id = auth.uid() and f.status::text = 'verified')));
$function$;
