-- ============================================================
-- 0097: daily withdrawal limit resets at 17:00 Dhaka
-- ============================================================
-- profile_limits.daily_withdrawal_limit counted withdrawals since
-- midnight Dhaka, while every other daily figure (0096) runs 17:00 to
-- 17:00 Dhaka. The three functions that apply the limit now count from
-- business_day_start(current_business_day()). Bodies are copied from
-- 0095 with only that expression changed.
-- ============================================================

create or replace function public.request_withdrawal(p_amount numeric, p_method text, p_destination text)
returns public.withdrawals
language plpgsql security definer set search_path = public as $_$
declare v_uid uuid:=auth.uid(); v_fee numeric; v_available numeric; v_after numeric; v_row withdrawals; v_limit profile_limits; v_used numeric;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if coalesce((select value::text from app_settings where key='emergency_withdrawals_stop'),'false')='true' then raise exception 'Withdrawals are temporarily paused by the platform operator.'; end if;
  if coalesce((select value::text from app_settings where key='manual_withdrawals_enabled'),'true') <> 'true' then raise exception 'Withdrawal requests are temporarily paused. Please try again later.'; end if;
  perform 1 from profiles where id=v_uid for update;
  if p_amount is null or p_amount < 5 then raise exception 'Minimum withdrawal is $5'; end if;
  if p_method = 'usdt_bep20' then raise exception 'USDT withdrawals are sent instantly. Choose Stablecoin (instant) instead.'; end if;
  if p_method is null or p_method not in ('bkash','nagad','binance','lightning','bank') then raise exception 'Invalid withdrawal method'; end if;
  if p_destination is null or length(trim(p_destination))=0 then raise exception 'Destination account is required'; end if;
  if length(trim(p_destination)) > 500 then raise exception 'Destination is too long'; end if;
  select * into v_limit from profile_limits where user_id=v_uid;
  if v_limit.single_withdrawal_limit is not null and p_amount > v_limit.single_withdrawal_limit then raise exception 'This amount exceeds your single-withdrawal limit of $%', v_limit.single_withdrawal_limit; end if;
  select coalesce(sum(amount_requested),0) into v_used from withdrawals where user_id=v_uid and status in ('pending','approved','processing','sending','paid') and requested_at >= business_day_start(current_business_day());
  if v_limit.daily_withdrawal_limit is not null and v_used+p_amount > v_limit.daily_withdrawal_limit then raise exception 'This request exceeds your daily withdrawal limit of $%', v_limit.daily_withdrawal_limit; end if;
  select coalesce(withdrawal_fee_percent,0) into v_fee from profiles where id=v_uid;
  select b.available into v_available from get_balance_for(v_uid) b;
  if p_amount > v_available then raise exception 'Insufficient balance. Available: $%', round(v_available,2); end if;
  v_after:=round(p_amount*(1-v_fee/100),2);
  insert into withdrawals(user_id,amount_requested,fee_percent,amount_after_fee,method,destination,status) values(v_uid,p_amount,v_fee,v_after,p_method,trim(p_destination),'pending') returning * into v_row;
  return v_row;
end; $_$;


create or replace function public.system_queue_withdrawal(p_user_id uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_profile profiles; v_limit profile_limits; v_available numeric; v_used numeric; v_amount numeric; v_destination text; v_method text; v_id uuid;
begin
  if coalesce((select value::text from app_settings where key='emergency_withdrawals_stop'),'false')='true' then return null; end if;
  if coalesce((select value::text from app_settings where key='manual_withdrawals_enabled'),'true') <> 'true' then return null; end if;
  select * into v_profile from profiles where id=p_user_id for update;
  if not found or v_profile.account_status <> 'active' or coalesce(v_profile.auto_withdraw_enabled,false)=false then return null; end if;
  select * into v_limit from profile_limits where user_id=p_user_id;
  v_method:=v_profile.default_withdrawal_method;
  if v_method is null or v_method not in ('bkash','nagad','binance','bank') then return null; end if;
  v_destination:=coalesce(nullif(trim(coalesce(v_profile.default_withdrawal_destination,'')),''),case v_method when 'bkash' then v_profile.wallet_bkash when 'nagad' then v_profile.wallet_nagad when 'binance' then v_profile.wallet_binance_id when 'bank' then v_profile.wallet_bank end);
  if v_destination is null or length(trim(v_destination))=0 then return null; end if;
  select b.available into v_available from get_balance_for(p_user_id) b;
  if v_available is null or v_available < 5 then return null; end if;
  select coalesce(sum(amount_requested),0) into v_used from withdrawals where user_id=p_user_id and status in ('pending','approved','processing','sending','paid') and requested_at >= business_day_start(current_business_day());
  v_amount:=least(v_available,coalesce(v_limit.single_withdrawal_limit,v_available));
  if v_limit.daily_withdrawal_limit is not null then v_amount:=least(v_amount,greatest(v_limit.daily_withdrawal_limit-v_used,0)); end if;
  if v_amount < 5 then return null; end if;
  insert into withdrawals(user_id,amount_requested,fee_percent,amount_after_fee,method,destination,status,admin_note) values(p_user_id,v_amount,coalesce(v_profile.withdrawal_fee_percent,0),round(v_amount*(1-coalesce(v_profile.withdrawal_fee_percent,0)/100),2),v_method,trim(v_destination),'pending','Auto-queued on settlement') returning id into v_id;
  return v_id;
end; $$;

create or replace function public.reserve_stablecoin_withdrawal(
  p_user_id uuid,
  p_quote_id text,
  p_amount numeric,
  p_fee_percent numeric,
  p_amount_after_fee numeric,
  p_coin text,
  p_chain text,
  p_destination text,
  p_quoted_fee numeric,
  p_amount_out numeric,
  p_amount_sat bigint,
  p_quote_expires_at timestamptz
) returns public.withdrawals
language plpgsql security definer set search_path = public as $$
declare v_profile profiles; v_limit profile_limits; v_used numeric; v_available numeric; v_row withdrawals;
begin
  if p_user_id is null or coalesce(p_quote_id,'') = '' then raise exception 'User and quote are required'; end if;
  select * into v_profile from profiles where id=p_user_id for update;
  if not found then raise exception 'Unknown user'; end if;

  -- Checked after the profile lock so a concurrent confirm of the same
  -- quote waits here and then sees the committed row.
  select * into v_row from withdrawals where quote_id=p_quote_id;
  if found then
    if v_row.user_id <> p_user_id then raise exception 'Quote belongs to another user'; end if;
    return v_row;
  end if;

  if coalesce((select value::text from app_settings where key='emergency_withdrawals_stop'),'false')='true' then raise exception 'Withdrawals are temporarily paused by the platform operator.'; end if;
  if v_profile.account_status <> 'active' then raise exception 'Account approval is required before requesting withdrawals'; end if;
  if not cpay_feature_enabled(p_user_id,'can_request_withdrawals') then raise exception 'Withdrawal requests are disabled for this account'; end if;
  if p_quote_expires_at is null or p_quote_expires_at <= now() then raise exception 'Quote expired'; end if;
  if p_amount is null or p_amount < 5 then raise exception 'Minimum withdrawal is $5'; end if;
  if coalesce(p_coin,'') = '' or coalesce(p_chain,'') = '' then raise exception 'Coin and chain are required'; end if;
  if p_amount_sat is null or p_amount_sat <= 0 then raise exception 'Quoted sats must be positive'; end if;
  if p_destination is null or length(trim(p_destination))=0 then raise exception 'Destination address is required'; end if;
  if length(trim(p_destination)) > 200 then raise exception 'Destination is too long'; end if;
  if p_fee_percent is distinct from coalesce(v_profile.withdrawal_fee_percent,0)
     or p_amount_after_fee is distinct from round(p_amount*(1-p_fee_percent/100),2) then
    raise exception 'Withdrawal fee changed. Review the new quote.';
  end if;

  select * into v_limit from profile_limits where user_id=p_user_id;
  if v_limit.single_withdrawal_limit is not null and p_amount > v_limit.single_withdrawal_limit then raise exception 'This amount exceeds your single-withdrawal limit of $%', v_limit.single_withdrawal_limit; end if;
  select coalesce(sum(amount_requested),0) into v_used from withdrawals where user_id=p_user_id and status in ('pending','approved','processing','sending','paid') and requested_at >= business_day_start(current_business_day());
  if v_limit.daily_withdrawal_limit is not null and v_used+p_amount > v_limit.daily_withdrawal_limit then raise exception 'This request exceeds your daily withdrawal limit of $%', v_limit.daily_withdrawal_limit; end if;
  select b.available into v_available from get_balance_for(p_user_id) b;
  if p_amount > v_available then raise exception 'Insufficient balance. Available: $%', round(v_available,2); end if;

  insert into withdrawals(user_id, amount_requested, fee_percent, amount_after_fee, method, destination, status,
                          quote_id, coin, chain, amount_sat, quoted_fee, amount_out, quote_expires_at)
  values (p_user_id, p_amount, p_fee_percent, p_amount_after_fee, 'stablecoin', trim(p_destination), 'sending',
          p_quote_id, p_coin, p_chain, p_amount_sat, p_quoted_fee, p_amount_out, p_quote_expires_at)
  returning * into v_row;
  return v_row;
end; $$;
