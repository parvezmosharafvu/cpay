-- Limit browser updates to public profile fields and keep all other columns
-- protected by default, including columns added by later migrations.
revoke update on table public.profiles from public, anon, authenticated;
grant update (display_name, bio, public_slug) on table public.profiles to authenticated;

create or replace function public.guard_profile_updates()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  user_editable_fields text[] := array[
    'display_name',
    'bio',
    'public_slug',
    'cost_locked',
    'team_cost_percent',
    'cost_percent',
    'withdraw_threshold',
    'preferred_usdt_network',
    'auto_withdraw_enabled'
  ];
begin
  if auth.uid() is null or is_admin() then
    return new;
  end if;

  if (to_jsonb(new) - user_editable_fields)
     is distinct from
     (to_jsonb(old) - user_editable_fields) then
    raise exception 'You may only change user-editable profile fields';
  end if;

  return new;
end;
$$;
