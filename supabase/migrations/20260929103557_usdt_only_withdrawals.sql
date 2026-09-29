-- Withdrawals are USDT-to-saved-address only.

create or replace function public.request_withdrawal(p_amount numeric, p_method text, p_destination text)
returns withdrawals
language plpgsql security definer set search_path = public as $$
begin
  raise exception 'Only USDT to a saved wallet address is supported. Use the USDT withdraw form.';
end;
$$;

create or replace function public.reseller_request_withdrawal_for(p_user_id uuid, p_amount numeric, p_method text, p_destination text)
returns withdrawals
language plpgsql security definer set search_path = public as $$
declare
  v_row withdrawals;
  v_avail numeric;
  v_fee numeric;
  v_after numeric;
  v_wallet usdt_wallets;
  v_limit profile_limits;
  v_used numeric;
  v_network text;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not is_admin() then
    if not is_reseller() then raise exception 'Not authorized'; end if;
    if p_user_id <> auth.uid() and not reseller_owns(p_user_id) then
      raise exception 'That account is not on your team';
    end if;
    if coalesce((select value from app_settings where key = 'feature_reseller_team_withdraw'), 'true'::jsonb) = 'false'::jsonb then
      raise exception 'Team withdrawals are turned off';
    end if;
  end if;
  if coalesce((select value::text from app_settings where key = 'emergency_withdrawals_stop'), 'false') = 'true' then
    raise exception 'Withdrawals are temporarily paused by the platform operator.';
  end if;
  if not account_is_active(p_user_id) then raise exception 'This account cannot withdraw'; end if;
  if p_amount is null or p_amount < 5 then raise exception 'Minimum withdrawal is $5'; end if;

  v_network := nullif(trim(p_method), '');
  if v_network in ('stablecoin', 'usdt', '') then v_network := null; end if;
  if v_network is null then
    select preferred_usdt_network into v_network from profiles where id = p_user_id;
  end if;
  if v_network is not null then
    select * into v_wallet from usdt_wallets where user_id = p_user_id and network = v_network;
  end if;
  if v_wallet.id is null then
    select * into v_wallet from usdt_wallets where user_id = p_user_id order by updated_at desc limit 1;
  end if;
  if v_wallet.id is null then
    raise exception 'Save a USDT address on this account first';
  end if;

  perform 1 from profiles where id = p_user_id for update;
  select * into v_limit from profile_limits where user_id = p_user_id;
  if v_limit.single_withdrawal_limit is not null and p_amount > v_limit.single_withdrawal_limit then
    raise exception 'This amount exceeds the single-withdrawal limit of $%', v_limit.single_withdrawal_limit;
  end if;
  select coalesce(sum(amount_requested), 0) into v_used
    from withdrawals
   where user_id = p_user_id
     and status in ('pending', 'approved', 'processing', 'sending', 'paid')
     and requested_at >= business_day_start(current_business_day());
  if v_limit.daily_withdrawal_limit is not null and v_used + p_amount > v_limit.daily_withdrawal_limit then
    raise exception 'This request exceeds the daily withdrawal limit of $%', v_limit.daily_withdrawal_limit;
  end if;
  select available into v_avail from get_balance_for(p_user_id);
  if v_avail is null or v_avail < p_amount then
    raise exception 'Insufficient balance. Available: $%', coalesce(v_avail, 0);
  end if;
  v_fee := resolve_withdrawal_fee(p_user_id);
  v_after := round(p_amount * (1 - v_fee / 100.0), 2);
  insert into withdrawals (
    user_id, amount_requested, fee_percent, amount_after_fee, method, destination, status, admin_note, coin, chain
  ) values (
    p_user_id, p_amount, v_fee, v_after, 'stablecoin', v_wallet.address, 'pending',
    case when p_user_id = auth.uid() then 'USDT payout' else 'USDT payout submitted by reseller' end,
    'USDT', v_wallet.network
  ) returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.system_queue_withdrawal(p_user_id uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_profile profiles; v_limit profile_limits; v_available numeric; v_used numeric;
        v_amount numeric; v_id uuid; v_fee numeric; v_wallet usdt_wallets; v_threshold numeric;
begin
  if coalesce((select value::text from app_settings where key='emergency_withdrawals_stop'),'false')='true' then return null; end if;
  select * into v_profile from profiles where id=p_user_id for update;
  if not found or v_profile.account_status <> 'active' or coalesce(v_profile.auto_withdraw_enabled,false)=false then return null; end if;
  if not self_withdraw_allowed(p_user_id) then return null; end if;
  select * into v_limit from profile_limits where user_id=p_user_id;
  v_threshold := coalesce(v_profile.withdraw_threshold, 5);
  if v_profile.preferred_usdt_network is not null then
    select * into v_wallet from usdt_wallets where user_id = p_user_id and network = v_profile.preferred_usdt_network;
  end if;
  if v_wallet.id is null then
    select * into v_wallet from usdt_wallets where user_id = p_user_id order by updated_at desc limit 1;
  end if;
  if v_wallet.id is null then return null; end if;
  select b.available into v_available from get_balance_for(p_user_id) b;
  if v_available is null or v_available < v_threshold then return null; end if;
  select coalesce(sum(amount_requested),0) into v_used from withdrawals
   where user_id=p_user_id and status in ('pending','approved','processing','sending','paid')
     and requested_at >= business_day_start(current_business_day());
  v_amount := least(v_available, coalesce(v_limit.single_withdrawal_limit, v_available));
  if v_limit.daily_withdrawal_limit is not null then
    v_amount := least(v_amount, greatest(v_limit.daily_withdrawal_limit - v_used, 0));
  end if;
  if v_amount < 5 then return null; end if;
  v_fee := resolve_withdrawal_fee(p_user_id);
  insert into withdrawals(
    user_id, amount_requested, fee_percent, amount_after_fee, method, destination, status, admin_note, coin, chain
  ) values (
    p_user_id, v_amount, v_fee, round(v_amount*(1-v_fee/100),2), 'stablecoin', trim(v_wallet.address), 'pending',
    'Auto-queued USDT on threshold', 'USDT', v_wallet.network
  ) returning id into v_id;
  return v_id;
end;
$$;
