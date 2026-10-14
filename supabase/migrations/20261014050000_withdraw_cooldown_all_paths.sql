-- Forward-only. The 24-hour wait on a newly saved USDT address
-- (20261009010000_withdraw_address_cooldown) was enforced only by the
-- payment service on the instant path. Two database paths picked the
-- account's saved address without checking it:
--   * system_queue_withdrawal()      (auto-withdraw after a settlement)
--   * admin_request_withdrawal_for() (admin submits a payout for a user)
-- so a just-saved address (for example after an account takeover) could
-- be queued straight away. Both now use only an address past its wait.
-- (The instant path, reserve_stablecoin_withdrawal(), is unchanged: the
-- payment service checks withdraw_destination_status() before it.) Bodies are the production definitions (md5 of prosrc checked
-- against production on 2026-10-14) with only those lines changed.
-- Balances, fees, limits, the emergency stop and every other rule are
-- unchanged. Grants are kept by CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION public.system_queue_withdrawal(p_user_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_profile profiles; v_limit profile_limits; v_available numeric; v_used numeric;
        v_amount numeric; v_id uuid; v_fee numeric; v_wallet usdt_wallets; v_threshold numeric;
begin
  if coalesce((select value::text from app_settings where key='emergency_withdrawals_stop'),'false')='true' then return null; end if;
  select * into v_profile from profiles where id=p_user_id for update;
  if not found or v_profile.account_status <> 'active' or coalesce(v_profile.auto_withdraw_enabled,false)=false then return null; end if;
  select * into v_limit from profile_limits where user_id=p_user_id;
  v_threshold := coalesce(v_profile.withdraw_threshold, 5);
  if v_profile.preferred_usdt_network is not null then
    select * into v_wallet from usdt_wallets where user_id = p_user_id and network = v_profile.preferred_usdt_network and usable_after <= now();
  end if;
  if v_wallet.id is null then
    select * into v_wallet from usdt_wallets where user_id = p_user_id and usable_after <= now() order by updated_at desc limit 1;
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
$function$;

CREATE OR REPLACE FUNCTION public.admin_request_withdrawal_for(p_user_id uuid, p_amount numeric, p_method text, p_destination text)
 RETURNS withdrawals
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  if not is_admin() then raise exception 'Not authorized'; end if;
  if p_user_id is null or not exists (select 1 from profiles where id = p_user_id) then
    raise exception 'Profile not found';
  end if;
  if coalesce((select value::text from app_settings where key = 'emergency_withdrawals_stop'), 'false') = 'true' then
    raise exception 'Withdrawals are temporarily paused by the platform operator.';
  end if;
  if not account_is_active(p_user_id) then raise exception 'This account cannot withdraw'; end if;
  if p_amount is null or p_amount < 5 then raise exception 'Minimum withdrawal is $5'; end if;

  -- p_destination is ignored: the payout always goes to a USDT address saved
  -- on the account, never to an address typed by the admin.
  v_network := nullif(trim(p_method), '');
  if v_network in ('stablecoin', 'usdt', '') then v_network := null; end if;
  if v_network is null then
    select preferred_usdt_network into v_network from profiles where id = p_user_id;
  end if;
  if v_network is not null then
    select * into v_wallet from usdt_wallets where user_id = p_user_id and network = v_network and usable_after <= now();
  end if;
  if v_wallet.id is null then
    select * into v_wallet from usdt_wallets where user_id = p_user_id and usable_after <= now() order by updated_at desc limit 1;
  end if;
  if v_wallet.id is null and exists (select 1 from usdt_wallets where user_id = p_user_id) then
    raise exception 'The saved USDT address is still in its 24-hour safety wait. Try again after it ends.';
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
    case when p_user_id = auth.uid() then 'USDT payout' else 'USDT payout submitted by admin' end,
    'USDT', v_wallet.network
  ) returning * into v_row;
  perform record_audit('withdrawal.requested_by_admin', 'withdrawal', v_row.id::text, null,
    jsonb_build_object('user_id', p_user_id, 'amount_requested', p_amount, 'fee_percent', v_fee, 'chain', v_wallet.network));
  return v_row;
end;
$function$;
