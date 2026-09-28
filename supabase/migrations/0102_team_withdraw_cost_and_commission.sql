-- Team withdrawals use the saved wallet, cost unlock does not rewrite the rate,
-- and reseller commission follows the freelancer hide threshold.

create or replace function public.cpay_feature_enabled(p_user_id uuid, p_feature_key text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(
    (select f.enabled from profile_feature_flags f where f.user_id = p_user_id and f.feature_key = p_feature_key),
    case
      when p_feature_key in (
        'can_create_links',
        'can_request_withdrawals',
        'can_use_lightning',
        'can_use_onchain_qr',
        'can_team_withdraw'
      ) then true
      else false
    end
  );
$$;

create or replace function public.reseller_request_withdrawal_for(
  p_user_id uuid,
  p_amount numeric,
  p_method text,
  p_destination text
)
returns withdrawals
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row withdrawals;
  v_avail numeric;
  v_fee numeric;
  v_after numeric;
  v_destination text;
  v_limit profile_limits;
  v_used numeric;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not is_admin() then
    if not is_reseller() then
      raise exception 'Not authorized';
    end if;
    if p_user_id <> auth.uid() and not reseller_owns(p_user_id) then
      raise exception 'That account is not on your team';
    end if;
    if coalesce((select value from app_settings where key = 'feature_reseller_team_withdraw'), 'true'::jsonb) = 'false'::jsonb then
      raise exception 'Team withdrawals are turned off';
    end if;
    if not cpay_feature_enabled(auth.uid(), 'can_team_withdraw') then
      raise exception 'Team withdrawals are turned off';
    end if;
  end if;

  if coalesce((select value::text from app_settings where key = 'emergency_withdrawals_stop'), 'false') = 'true' then
    raise exception 'Withdrawals are temporarily paused by the platform operator.';
  end if;
  if coalesce((select value::text from app_settings where key = 'manual_withdrawals_enabled'), 'true') <> 'true' then
    raise exception 'Withdrawal requests are temporarily paused. Please try again later.';
  end if;
  if not account_is_active(p_user_id) then
    raise exception 'This account cannot withdraw';
  end if;
  if not cpay_feature_enabled(p_user_id, 'can_request_withdrawals') then
    raise exception 'Withdrawals are turned off for this account';
  end if;

  if p_amount is null or p_amount < 5 then
    raise exception 'Minimum withdrawal is $5';
  end if;
  if p_method = 'usdt_bep20' then
    raise exception 'USDT withdrawals are sent instantly from the account''s own dashboard.';
  end if;
  if p_method not in ('bkash', 'nagad', 'binance', 'lightning', 'bank') then
    raise exception 'Invalid method';
  end if;

  if is_admin() then
    v_destination := nullif(trim(p_destination), '');
    if v_destination is null then
      raise exception 'Destination required';
    end if;
  else
    select case p_method
      when 'bkash' then nullif(trim(wallet_bkash), '')
      when 'nagad' then nullif(trim(wallet_nagad), '')
      when 'binance' then nullif(trim(wallet_binance_id), '')
      when 'bank' then nullif(trim(wallet_bank), '')
      when 'lightning' then coalesce(nullif(trim(wallet_lightning_address), ''), nullif(trim(wallet_lightning), ''))
    end
    into v_destination
    from profiles
    where id = p_user_id;
    if v_destination is null then
      raise exception 'Save a payout account for this method first';
    end if;
  end if;
  if length(v_destination) > 500 then
    raise exception 'Destination is too long';
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
  insert into withdrawals(
    user_id, amount_requested, fee_percent, amount_after_fee, method, destination, status, admin_note
  )
  values (
    p_user_id, p_amount, v_fee, v_after, p_method, v_destination, 'pending',
    case when p_user_id = auth.uid() then null else 'Submitted by reseller' end
  )
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.set_my_cost_percent(p_percent numeric)
returns numeric
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_locked boolean;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  select role, cost_locked into v_role, v_locked from profiles where id = v_uid;
  if v_role not in ('creator', 'moderator') then raise exception 'Not authorized'; end if;
  if coalesce(v_locked, false) and not is_admin() then
    raise exception 'Your reseller locked this payment-link cost rate';
  end if;
  if p_percent is null or p_percent < 0 then raise exception 'Cost must be 0 or more'; end if;
  update profiles set cost_percent = round(p_percent, 3) where id = v_uid;
  return round(p_percent, 3);
end;
$$;

create or replace function public.reseller_lock_team_cost(p_percent numeric, p_lock boolean default true)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_count int := 0;
begin
  if not is_reseller() and not is_admin() then raise exception 'Not authorized'; end if;
  if coalesce(p_lock, true) then
    if p_percent is null or p_percent < 0 or p_percent > 1000 then
      raise exception 'Cost must be 0–1000';
    end if;
    update profiles
       set team_cost_percent = round(p_percent, 3)
     where id = auth.uid();
    update profiles
       set cost_percent = round(p_percent, 3),
           cost_locked = true
     where referred_by = auth.uid()
        or id in (select creator_id from moderator_assignments where moderator_id = auth.uid());
  else
    update profiles
       set cost_locked = false
     where referred_by = auth.uid()
        or id in (select creator_id from moderator_assignments where moderator_id = auth.uid());
  end if;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.get_balance_for(p_user_id uuid)
returns table(earned numeric, queued numeric, withdrawn numeric, available numeric)
language sql
stable
security definer
set search_path to 'public'
as $$
  select
    e.earned,
    q.queued,
    w.withdrawn,
    round(e.earned - q.queued, 8) as available
  from
    (select
        coalesce((
          select sum(amount_settled - coalesce(platform_fee_amount, 0) - coalesce(reseller_commission_amount, 0))
          from payments
          where user_id = p_user_id
            and status = 'settled'
            and amount_settled >= hide_threshold_for(p_user_id)
        ), 0)
        +
        coalesce((
          select sum(reseller_commission_amount)
          from payments
          where reseller_id = p_user_id
            and status = 'settled'
            and amount_settled >= hide_threshold_for(user_id)
        ), 0)
        as earned
    ) e,
    (select coalesce(sum(amount_requested), 0) as queued
     from withdrawals
     where user_id = p_user_id
       and status not in ('rejected', 'failed')) q,
    (select coalesce(sum(amount_after_fee), 0) as withdrawn
     from withdrawals
     where user_id = p_user_id
       and status = 'paid') w;
$$;

create or replace function public.my_commission_totals()
returns table(commission_earned numeric, team_net numeric, payment_count bigint)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  return query
  select
    coalesce(sum(p.reseller_commission_amount), 0),
    coalesce(sum(p.amount_settled - p.platform_fee_amount), 0),
    count(*)
  from payments p
  where p.reseller_id = auth.uid()
    and p.status = 'settled'
    and p.amount_settled >= hide_threshold_for(p.user_id);
end;
$$;

create or replace function public.my_earnings_split()
returns table(
  settled numeric,
  platform_fee numeric,
  reseller_commission_out numeric,
  reseller_commission_in numeric,
  net numeric,
  cost_percent numeric,
  cost_locked boolean,
  commission_percent numeric
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  return query
  select
    coalesce((select sum(p.amount_settled) from payments p where p.user_id = v_uid and p.status = 'settled' and p.amount_settled >= hide_threshold_for(p.user_id)), 0),
    coalesce((select sum(p.platform_fee_amount) from payments p where p.user_id = v_uid and p.status = 'settled' and p.amount_settled >= hide_threshold_for(p.user_id)), 0),
    coalesce((select sum(p.reseller_commission_amount) from payments p where p.user_id = v_uid and p.status = 'settled' and p.amount_settled >= hide_threshold_for(p.user_id)), 0),
    coalesce((select sum(p.reseller_commission_amount) from payments p where p.reseller_id = v_uid and p.status = 'settled' and p.amount_settled >= hide_threshold_for(p.user_id)), 0),
    (select b.available from get_balance_for(v_uid) b),
    pr.cost_percent,
    pr.cost_locked,
    case
      when pr.role = 'moderator' then cpay_reseller_commission_percent(v_uid)
      when pr.referred_by is not null then coalesce(cpay_reseller_commission_percent(pr.referred_by), 0)
      else 0
    end
  from profiles pr
  where pr.id = v_uid;
end;
$$;

create or replace function public.my_affiliate_commission_rows()
returns table(
  freelancer_id uuid,
  freelancer_name text,
  link_slug text,
  settled numeric,
  platform_fee numeric,
  commission numeric,
  settled_at timestamp with time zone
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not is_reseller() and not is_admin() then raise exception 'Not authorized'; end if;
  return query
  select p.user_id,
         coalesce(pr.display_name, pr.email),
         pl.slug,
         p.amount_settled,
         p.platform_fee_amount,
         p.reseller_commission_amount,
         p.settled_at
  from payments p
  join profiles pr on pr.id = p.user_id
  left join payment_links pl on pl.id = p.payment_link_id
  where p.status = 'settled'
    and p.reseller_id = auth.uid()
    and p.amount_settled >= hide_threshold_for(p.user_id)
  order by p.settled_at desc
  limit 100;
end;
$$;
