-- Admin → Applications gets an "Approve new sign-ups automatically" switch
-- (admin-desk.js). It reads cpay_auto_approval_enabled('freelancer') and
-- writes admin_set_auto_approval, which until now had no caller and wrote
-- the flag without a passkey/aal2 sign-in or an audit row. Like every other
-- setting change it now needs both.

create or replace function public.admin_set_auto_approval(p_role text, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare old jsonb;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if not public.strong_session() then
    raise exception 'Sign in again with your passkey first, then change settings';
  end if;
  if p_role is distinct from 'freelancer' then raise exception 'Invalid application role'; end if;
  select value into old from app_settings where key = 'auto_approve_freelancer';
  insert into app_settings(key, value)
  values ('auto_approve_freelancer', to_jsonb(coalesce(p_enabled, false)))
  on conflict (key) do update set value = excluded.value, updated_at = now();
  perform record_audit('settings.auto_approval', 'setting', 'auto_approve_freelancer',
                       jsonb_build_object('value', old), jsonb_build_object('value', coalesce(p_enabled, false)));
end;
$$;

revoke all on function public.admin_set_auto_approval(text, boolean) from public, anon;
grant execute on function public.admin_set_auto_approval(text, boolean) to authenticated;
