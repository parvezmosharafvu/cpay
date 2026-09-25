-- ============================================================
-- 0095: instant stablecoin withdrawals through the Breez payment service
-- ============================================================
-- A freelancer or reseller withdraws USDT/USDC to their own address on any
-- chain Breez routes to. The payment service quotes the send, then on
-- confirm reserves the balance here (status 'sending'), sends through Breez
-- with the withdrawal id as the idempotency key, and finalizes to 'paid'
-- or 'failed'. 'failed' drops out of get_balance_for, which is the refund.
--
-- Manual USDT BEP20 withdrawals and the USDT auto-queue go away. bKash,
-- Nagad, Binance Pay and bank stay manual. Rows already queued as
-- usdt_bep20 keep their method and are still processed by an admin.
--
-- Safe to re-run: columns and indexes use IF NOT EXISTS, constraints are
-- dropped and re-added NOT VALID, functions are CREATE OR REPLACE.
-- ============================================================

alter table public.withdrawals add column if not exists quote_id text;
alter table public.withdrawals add column if not exists coin text;
alter table public.withdrawals add column if not exists chain text;
alter table public.withdrawals add column if not exists amount_sat bigint;
alter table public.withdrawals add column if not exists quoted_fee numeric(18,8);
alter table public.withdrawals add column if not exists amount_out numeric(30,8);
alter table public.withdrawals add column if not exists quote_expires_at timestamptz;
alter table public.withdrawals add column if not exists breez_payment_id text;

comment on column public.withdrawals.quote_id is 'Payment service quote this stablecoin withdrawal was confirmed from. Unique, so a repeated confirm returns the same row.';
comment on column public.withdrawals.coin is 'Stablecoin delivered, e.g. USDT or USDC (method = stablecoin).';
comment on column public.withdrawals.chain is 'Destination chain as Breez names it, e.g. tron, bsc, ethereum, arbitrum, solana.';
comment on column public.withdrawals.amount_sat is 'Sats the platform wallet sent for amount_after_fee at the quoted BTC/USD rate.';
comment on column public.withdrawals.quoted_fee is 'Breez swap and network fee in USD from the quote. Paid by the user out of amount_after_fee.';
comment on column public.withdrawals.amount_out is 'Coin units the destination receives: the quoted estimate, replaced by the delivered amount once known.';
comment on column public.withdrawals.breez_payment_id is 'Breez payment id of the send. Equals the withdrawal id, which is the idempotency key.';

create unique index if not exists withdrawals_quote_id_key on public.withdrawals(quote_id) where quote_id is not null;
create unique index if not exists withdrawals_breez_payment_id_key on public.withdrawals(breez_payment_id) where breez_payment_id is not null;
create index if not exists withdrawals_sending_idx on public.withdrawals(requested_at) where status = 'sending';

alter table public.withdrawals drop constraint if exists withdrawals_status_check;
alter table public.withdrawals add constraint withdrawals_status_check
  check (status in ('pending','approved','processing','rejected','paid','sending','failed')) not valid;

alter table public.withdrawals drop constraint if exists withdrawals_method_check;
alter table public.withdrawals add constraint withdrawals_method_check
  check (method in ('bkash','nagad','binance','lightning','usdt_bep20','bank','stablecoin')) not valid;

alter table public.withdrawals drop constraint if exists withdrawals_stablecoin_fields;
alter table public.withdrawals add constraint withdrawals_stablecoin_fields
  check (method <> 'stablecoin' or (quote_id is not null and coin is not null and chain is not null and amount_sat > 0))
  not valid;

-- Balance: a failed send gives the reservation back.
create or replace function public.get_balance_for(p_user_id uuid)
returns table(earned numeric, queued numeric, withdrawn numeric, available numeric)
language sql stable security definer set search_path = public as $$
  select
    e.earned,
    q.queued,
    w.withdrawn,
    round(e.earned - q.queued, 8) as available
  from
    (select
        coalesce((
          select sum(amount_settled - coalesce(platform_fee_amount,0) - coalesce(reseller_commission_amount,0))
          from payments
          where user_id = p_user_id and status = 'settled'
            and amount_settled >= hide_threshold_for(p_user_id)
        ), 0)
        +
        coalesce((
          select sum(reseller_commission_amount)
          from payments
          where reseller_id = p_user_id and status = 'settled'
            and amount_settled >= hide_threshold_for(p_user_id)
        ), 0)
        as earned
    ) e,
    (select coalesce(sum(amount_requested), 0) as queued
     from withdrawals where user_id = p_user_id and status not in ('rejected','failed')) q,
    (select coalesce(sum(amount_after_fee), 0) as withdrawn
     from withdrawals where user_id = p_user_id and status = 'paid') w;
$$;

-- Manual requests: usdt_bep20 is no longer accepted, and 'sending' counts
-- toward the daily limit. Otherwise unchanged from 0091.
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
  select coalesce(sum(amount_requested),0) into v_used from withdrawals where user_id=v_uid and status in ('pending','approved','processing','sending','paid') and requested_at >= ((now() at time zone 'Asia/Dhaka')::date::text || ' 00:00:00')::timestamp at time zone 'Asia/Dhaka';
  if v_limit.daily_withdrawal_limit is not null and v_used+p_amount > v_limit.daily_withdrawal_limit then raise exception 'This request exceeds your daily withdrawal limit of $%', v_limit.daily_withdrawal_limit; end if;
  select coalesce(withdrawal_fee_percent,3.0) into v_fee from profiles where id=v_uid;
  select b.available into v_available from get_balance_for(v_uid) b;
  if p_amount > v_available then raise exception 'Insufficient balance. Available: $%', round(v_available,2); end if;
  v_after:=round(p_amount*(1-v_fee/100),2);
  insert into withdrawals(user_id,amount_requested,fee_percent,amount_after_fee,method,destination,status) values(v_uid,p_amount,v_fee,v_after,p_method,trim(p_destination),'pending') returning * into v_row;
  return v_row;
end; $_$;

-- Auto-withdraw on settlement: no longer queues USDT for an admin, and a
-- profile without a default method is skipped instead of defaulting to
-- usdt_bep20. 'sending' counts toward the daily limit.
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
  select coalesce(sum(amount_requested),0) into v_used from withdrawals where user_id=p_user_id and status in ('pending','approved','processing','sending','paid') and requested_at >= ((now() at time zone 'Asia/Dhaka')::date::text || ' 00:00:00')::timestamp at time zone 'Asia/Dhaka';
  v_amount:=least(v_available,coalesce(v_limit.single_withdrawal_limit,v_available));
  if v_limit.daily_withdrawal_limit is not null then v_amount:=least(v_amount,greatest(v_limit.daily_withdrawal_limit-v_used,0)); end if;
  if v_amount < 5 then return null; end if;
  insert into withdrawals(user_id,amount_requested,fee_percent,amount_after_fee,method,destination,status,admin_note) values(p_user_id,v_amount,coalesce(v_profile.withdrawal_fee_percent,3.0),round(v_amount*(1-coalesce(v_profile.withdrawal_fee_percent,3.0)/100),2),v_method,trim(v_destination),'pending','Auto-queued on settlement') returning id into v_id;
  return v_id;
end; $$;

-- Reserve the balance for a confirmed stablecoin quote. Runs every check
-- request_withdrawal runs (the insert triggers skip service-role callers,
-- so account and feature checks are repeated here) and inserts the row as
-- 'sending'. A second call with the same quote returns the first row.
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
  if p_fee_percent is distinct from coalesce(v_profile.withdrawal_fee_percent,3.0)
     or p_amount_after_fee is distinct from round(p_amount*(1-p_fee_percent/100),2) then
    raise exception 'Withdrawal fee changed. Review the new quote.';
  end if;

  select * into v_limit from profile_limits where user_id=p_user_id;
  if v_limit.single_withdrawal_limit is not null and p_amount > v_limit.single_withdrawal_limit then raise exception 'This amount exceeds your single-withdrawal limit of $%', v_limit.single_withdrawal_limit; end if;
  select coalesce(sum(amount_requested),0) into v_used from withdrawals where user_id=p_user_id and status in ('pending','approved','processing','sending','paid') and requested_at >= ((now() at time zone 'Asia/Dhaka')::date::text || ' 00:00:00')::timestamp at time zone 'Asia/Dhaka';
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

-- Move a 'sending' row to 'paid' or 'failed'. Only a 'sending' row moves,
-- so a refund ('failed') happens at most once however often this is
-- called. Returns the new status, or 'already_<status>' / 'unknown'.
create or replace function public.finalize_stablecoin_withdrawal(
  p_id uuid,
  p_outcome text,
  p_breez_payment_id text default null,
  p_amount_out numeric default null,
  p_note text default null
) returns text
language plpgsql security definer set search_path = public as $$
declare v_status text;
begin
  if p_outcome not in ('paid','failed') then raise exception 'Outcome must be paid or failed'; end if;
  update withdrawals
     set status = p_outcome,
         breez_payment_id = coalesce(p_breez_payment_id, breez_payment_id),
         amount_out = coalesce(p_amount_out, amount_out),
         admin_note = coalesce(p_note, admin_note),
         processed_at = now()
   where id = p_id and method = 'stablecoin' and status = 'sending';
  if found then return p_outcome; end if;
  select status into v_status from withdrawals where id = p_id;
  if not found then return 'unknown'; end if;
  return 'already_' || v_status;
end; $$;

revoke all on function public.reserve_stablecoin_withdrawal(uuid,text,numeric,numeric,numeric,text,text,text,numeric,numeric,bigint,timestamptz) from public, anon, authenticated;
revoke all on function public.finalize_stablecoin_withdrawal(uuid,text,text,numeric,text) from public, anon, authenticated;
grant execute on function public.reserve_stablecoin_withdrawal(uuid,text,numeric,numeric,numeric,text,text,text,numeric,numeric,bigint,timestamptz) to service_role;
grant execute on function public.finalize_stablecoin_withdrawal(uuid,text,text,numeric,text) to service_role;
