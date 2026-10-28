-- Manual payouts only (Admin → Settings → Payouts).
--
-- On: nothing leaves CPAY by itself. Auto withdraw is locked off (every
-- payment stays in the user's balance) and instant withdrawals are refused;
-- a user sends a withdrawal request instead (request_manual_withdrawal: a
-- 'pending' row that holds the amount in the balance). The admin pays it
-- outside CPAY and marks it paid, or rejects it (the amount goes back to
-- the balance), in Admin → Payouts (admin-actions /process-withdrawal).
-- Stored in app_settings 'manual_payouts_only'; turning it on or off needs
-- a passkey/aal2 admin session and is audited. While it is on, auto
-- withdraw cannot be unlocked and payment_mode_for answers 'balance' even
-- if it were. Turning it off leaves the auto withdraw lock as it is (unlock
-- it separately). Requests are paid by Lightning or USDT only (no
-- traditional payment methods, AGENTS.md) and need a passkey session.

create or replace function public.manual_payouts_only()
returns boolean
language sql
stable security definer
set search_path to 'public'
as $$
  select coalesce((select value = 'true'::jsonb from app_settings where key = 'manual_payouts_only'), false)
$$;
revoke all on function public.manual_payouts_only() from public, anon;
grant execute on function public.manual_payouts_only() to authenticated, service_role;

create or replace function public.admin_set_manual_payouts(p_on boolean)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_old boolean := manual_payouts_only(); r jsonb := '{}'::jsonb;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if not public.strong_session() then
    raise exception 'Sign in again with your passkey first';
  end if;
  if p_on is null then raise exception 'Choose on or off'; end if;
  insert into app_settings(key, value) values ('manual_payouts_only', to_jsonb(p_on))
  on conflict (key) do update set value = excluded.value, updated_at = now();
  if p_on then r := admin_lock_auto_withdraw(true); end if;
  perform record_audit('payouts.manual_only', 'setting', 'manual_payouts_only',
    jsonb_build_object('on', v_old),
    jsonb_build_object('on', p_on, 'released_forwards', coalesce((r->>'released_forwards')::int, 0)));
  return jsonb_build_object('manual_payouts_only', p_on, 'auto_withdraw_locked_off', auto_withdraw_locked(),
    'released_forwards', coalesce((r->>'released_forwards')::int, 0));
end;
$$;
revoke all on function public.admin_set_manual_payouts(boolean) from public, anon;
grant execute on function public.admin_set_manual_payouts(boolean) to authenticated;

-- A user's withdrawal request while manual payouts are on. Same checks as
-- an instant withdrawal (reserve_stablecoin_withdrawal): pause switch,
-- active account, feature, $5 minimum, limits, balance and fee.
create or replace function public.request_manual_withdrawal(p_amount numeric, p_method text, p_destination text)
returns withdrawals
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_uid uuid := auth.uid(); v_profile profiles; v_limit profile_limits; v_used numeric;
        v_available numeric; v_fee numeric; v_row withdrawals;
begin
  if v_uid is null then raise exception 'Sign in first'; end if;
  if not public.strong_session() then
    raise exception 'Confirm with your passkey to send a withdrawal request';
  end if;
  if not manual_payouts_only() then
    raise exception 'Withdraw from the Withdraw page; requests are only used while payouts are paid by hand.';
  end if;
  select * into v_profile from profiles where id = v_uid for update;
  if not found then raise exception 'Unknown user'; end if;
  if coalesce((select value::text from app_settings where key = 'emergency_withdrawals_stop'), 'false') = 'true' then
    raise exception 'Withdrawals are temporarily paused by the platform operator.';
  end if;
  if v_profile.account_status <> 'active' then raise exception 'Account approval is required before requesting withdrawals'; end if;
  if not cpay_feature_enabled(v_uid, 'can_request_withdrawals') then raise exception 'Withdrawal requests are disabled for this account'; end if;
  if p_method is null or p_method not in ('lightning', 'usdt_bep20') then
    raise exception 'Choose how you want to be paid';
  end if;
  if p_amount is null or p_amount <> round(p_amount, 2) then raise exception 'Enter the amount in dollars and cents'; end if;
  if p_amount < 5 then raise exception 'Minimum withdrawal is $5'; end if;
  if p_destination is null or length(trim(p_destination)) < 3 then raise exception 'Enter where to send the money'; end if;
  -- A Lightning invoice can be long (reserve_lightning_withdrawal allows 2000).
  if length(trim(p_destination)) > (case when p_method = 'lightning' then 2000 else 200 end) then
    raise exception 'Destination is too long';
  end if;

  select * into v_limit from profile_limits where user_id = v_uid;
  if v_limit.single_withdrawal_limit is not null and p_amount > v_limit.single_withdrawal_limit then
    raise exception 'This amount exceeds your single-withdrawal limit of $%', v_limit.single_withdrawal_limit;
  end if;
  select coalesce(sum(amount_requested), 0) into v_used from withdrawals
   where user_id = v_uid and status in ('pending', 'approved', 'processing', 'sending', 'paid')
     and requested_at >= business_day_start(current_business_day());
  if v_limit.daily_withdrawal_limit is not null and v_used + p_amount > v_limit.daily_withdrawal_limit then
    raise exception 'This request exceeds your daily withdrawal limit of $%', v_limit.daily_withdrawal_limit;
  end if;
  select b.available into v_available from get_balance_for(v_uid) b;
  if p_amount > v_available then raise exception 'Insufficient balance. Available: $%', round(v_available, 2); end if;

  v_fee := resolve_withdrawal_fee(v_uid);
  insert into withdrawals(user_id, amount_requested, fee_percent, amount_after_fee, method, destination, status, coin, chain)
  values (v_uid, p_amount, v_fee, round(p_amount * (1 - v_fee / 100), 2), p_method, trim(p_destination), 'pending',
          case when p_method = 'usdt_bep20' then 'USDT' end, case when p_method = 'usdt_bep20' then 'BEP20' end)
  returning * into v_row;
  return v_row;
end;
$$;
revoke all on function public.request_manual_withdrawal(numeric, text, text) from public, anon;
grant execute on function public.request_manual_withdrawal(numeric, text, text) to authenticated;

-- While manual payouts are on, nothing but a request ('pending') may be
-- created: the instant Lightning and USDT withdrawals (reserve_* functions,
-- which insert 'sending') are refused here.
create or replace function public.gate_manual_payouts()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if new.status <> 'pending' and manual_payouts_only() then
    raise exception 'Withdrawals are paid by hand now. Send a withdrawal request from the Withdraw page.';
  end if;
  return new;
end;
$$;
revoke all on function public.gate_manual_payouts() from public, anon, authenticated;
drop trigger if exists trg_gate_manual_payouts on public.withdrawals;
create trigger trg_gate_manual_payouts
  before insert on public.withdrawals
  for each row execute function public.gate_manual_payouts();

-- The switch rows change only through their RPCs (20261028040000).
create or replace function public.guard_switch_settings()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if coalesce(new.key, old.key) in ('auto_withdraw_locked_off', 'auto_approve_freelancer', 'manual_payouts_only')
     or (tg_op = 'UPDATE' and old.key in ('auto_withdraw_locked_off', 'auto_approve_freelancer', 'manual_payouts_only')) then
    if current_user in ('authenticated', 'anon') then
      raise exception 'Change this in Admin (passkey sign-in needed)';
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

-- While manual payouts are on, auto withdraw stays locked and nothing is
-- forwarded, whatever a profile's own setting says.
create or replace function public.payment_mode_for(p_user uuid)
returns text
language sql
stable security definer
set search_path to 'public'
as $$
  select case
    when payment_mode() = 'direct' then 'direct'
    when auto_withdraw_locked() or manual_payouts_only() then 'balance'
    when o.mode = 'on' then 'instant_forward'
    when o.mode = 'off' then 'balance'
    else payment_mode() end
  from (select 1) one left join auto_withdraw_overrides o on o.user_id = p_user
$$;
revoke all on function public.payment_mode_for(uuid) from public, anon, authenticated;
grant execute on function public.payment_mode_for(uuid) to service_role;

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
  if not p_locked and manual_payouts_only() then
    raise exception 'Manual payouts only is on. Turn it off first.';
  end if;
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
