-- Auto withdraw "Lock off" (Admin → Settings → Auto withdraw).
--
-- Locking turns auto withdraw off for everyone and keeps it off: every
-- payment goes to the user's balance whatever a profile's own setting says
-- (payment_mode_for answers 'balance'), and neither the global switch nor a
-- profile can be turned on until an admin unlocks it. Locking also turns
-- the global switch off, which releases waiting forwards into balances
-- (admin_set_auto_withdraw_global). Stored in app_settings
-- 'auto_withdraw_locked_off'; lock and unlock need a passkey/aal2 admin
-- session and are audited.

create or replace function public.auto_withdraw_locked()
returns boolean
language sql
stable
set search_path to 'public'
as $$
  select coalesce((select value = 'true'::jsonb from app_settings where key = 'auto_withdraw_locked_off'), false)
$$;
revoke all on function public.auto_withdraw_locked() from public, anon, authenticated;

create or replace function public.payment_mode_for(p_user uuid)
returns text
language sql
stable security definer
set search_path to 'public'
as $$
  select case
    when payment_mode() = 'direct' then 'direct'
    when auto_withdraw_locked() then 'balance'
    when o.mode = 'on' then 'instant_forward'
    when o.mode = 'off' then 'balance'
    else payment_mode() end
  from (select 1) one left join auto_withdraw_overrides o on o.user_id = p_user
$$;
revoke all on function public.payment_mode_for(uuid) from public, anon, authenticated;
grant execute on function public.payment_mode_for(uuid) to service_role;

create or replace function public.admin_set_auto_withdraw_global(p_on boolean)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_old text := payment_mode(); v_new text; n integer := 0; u record;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if not public.strong_session() then
    raise exception 'Sign in again with your passkey first';
  end if;
  if p_on is null then raise exception 'Choose on or off'; end if;
  if p_on and auto_withdraw_locked() then
    raise exception 'Auto withdraw is locked off. Unlock it first.';
  end if;
  v_new := case when p_on then 'instant_forward' else 'balance' end;
  perform admin_set_platform_setting('payment_mode', to_jsonb(v_new));
  if not p_on then
    for u in select distinct f.user_id from payment_forwards f
              where f.status in ('queued', 'retry', 'owed') and f.batch_id is null
                and payment_mode_for(f.user_id) = 'balance' loop
      n := n + auto_withdraw_release_waiting(u.user_id);
    end loop;
  end if;
  perform record_audit('auto_withdraw.global', 'setting', 'payment_mode',
    jsonb_build_object('mode', v_old), jsonb_build_object('mode', v_new, 'released_forwards', n));
  return jsonb_build_object('auto_withdraw', p_on, 'payment_mode', v_new, 'released_forwards', n);
end;
$$;
revoke all on function public.admin_set_auto_withdraw_global(boolean) from public, anon;
grant execute on function public.admin_set_auto_withdraw_global(boolean) to authenticated;

create or replace function public.admin_set_auto_withdraw(p_user uuid, p_mode text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_old text; v_before text; v_after text; n integer := 0;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if not public.strong_session() then
    raise exception 'Sign in again with your passkey first';
  end if;
  if p_mode is null or p_mode not in ('default', 'on', 'off') then raise exception 'Choose default, on or off'; end if;
  if p_mode = 'on' and auto_withdraw_locked() then
    raise exception 'Auto withdraw is locked off. Unlock it first.';
  end if;
  perform 1 from profiles where id = p_user for update;
  if not found then raise exception 'Unknown user'; end if;
  select mode into v_old from auto_withdraw_overrides where user_id = p_user;
  v_before := payment_mode_for(p_user);
  if p_mode = 'default' then
    delete from auto_withdraw_overrides where user_id = p_user;
  else
    insert into auto_withdraw_overrides(user_id, mode, set_by, updated_at) values (p_user, p_mode, auth.uid(), now())
    on conflict (user_id) do update set mode = excluded.mode, set_by = excluded.set_by, updated_at = excluded.updated_at;
  end if;
  v_after := payment_mode_for(p_user);
  if v_after = 'balance' then n := auto_withdraw_release_waiting(p_user); end if;
  perform record_audit('auto_withdraw.profile', 'profile', p_user::text,
    jsonb_build_object('override', coalesce(v_old, 'default'), 'effective', v_before),
    jsonb_build_object('override', p_mode, 'effective', v_after, 'released_forwards', n));
  return jsonb_build_object('override', p_mode, 'effective', v_after, 'auto_withdraw', v_after = 'instant_forward', 'released_forwards', n);
end;
$$;
revoke all on function public.admin_set_auto_withdraw(uuid, text) from public, anon;
grant execute on function public.admin_set_auto_withdraw(uuid, text) to authenticated;

create or replace function public.admin_auto_withdraw_overview()
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if not public.strong_session() then
    raise exception 'Sign in again with your passkey first';
  end if;
  return jsonb_build_object(
    'global', payment_mode() = 'instant_forward',
    'payment_mode', payment_mode(),
    'locked_off', auto_withdraw_locked(),
    'users', coalesce((select jsonb_agg(jsonb_build_object(
        'user_id', p.id, 'override', coalesce(o.mode, 'default'),
        'auto_withdraw', payment_mode_for(p.id) = 'instant_forward',
        'has_address', exists (select 1 from receive_target_for(p.id)),
        'updated_at', o.updated_at))
      from profiles p left join auto_withdraw_overrides o on o.user_id = p.id), '[]'::jsonb));
end;
$$;

-- Lock (true) or unlock (false). Locking also turns the global switch off.
create or replace function public.admin_lock_auto_withdraw(p_locked boolean)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_old boolean := auto_withdraw_locked(); r jsonb := '{}'::jsonb;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if not public.strong_session() then
    raise exception 'Sign in again with your passkey first';
  end if;
  if p_locked is null then raise exception 'Choose lock or unlock'; end if;
  insert into app_settings(key, value) values ('auto_withdraw_locked_off', to_jsonb(p_locked))
  on conflict (key) do update set value = excluded.value, updated_at = now();
  if p_locked then r := admin_set_auto_withdraw_global(false); end if;
  perform record_audit('auto_withdraw.lock', 'setting', 'auto_withdraw_locked_off',
    jsonb_build_object('locked_off', v_old),
    jsonb_build_object('locked_off', p_locked, 'released_forwards', coalesce((r->>'released_forwards')::int, 0)));
  return jsonb_build_object('locked_off', p_locked, 'payment_mode', payment_mode(),
    'released_forwards', coalesce((r->>'released_forwards')::int, 0));
end;
$$;
revoke all on function public.admin_lock_auto_withdraw(boolean) from public, anon;
grant execute on function public.admin_lock_auto_withdraw(boolean) to authenticated;
