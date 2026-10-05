-- ============================================================
-- 20261005020000: remove the reseller role
-- ============================================================
-- Owner decision (2026-10-05): CPAY has two account types only, the
-- freelancer (role 'creator', shown as "Individual"/"Freelancer") and the
-- admin. The reseller role ('moderator' in the schema) and everything that
-- only existed for it is removed from the active schema. Forward-only: the
-- older migrations stay as history. Reseller commission was already removed
-- by 20261005010000 (PR A); this file depends on it.
--
-- Removed:
--   * the 'moderator' role and the 'reseller' application role;
--   * reseller teams: profiles.referred_by, profiles.affiliate_code,
--     moderator_assignments, sign-up attach, affiliate codes;
--   * reseller team pricing: profiles.team_cost_percent;
--   * the link-price lock: profiles.cost_locked, the trg_clear_link_costs_on_lock
--     trigger and link_update_is_lock_clear (they only served the lock, which
--     only a reseller could set: verdict "purely reseller-specific");
--   * the reseller team withdrawal fee and the self-withdraw switch
--     (reseller_settings, trg_guard_withdrawal_self_allowed);
--   * reseller notices, team chat, reseller Telegram groups and the
--     reseller daily close (reseller_notices, team_messages,
--     reseller_alert_channels, enqueue_daily_close and its cron job);
--   * the unused "staff" read functions that existed for the moderator role;
--   * per-account (reseller-owned) site domains: site_domains.owner_id must
--     now be null (global domains only). The column stays so the domain
--     lookups keep working.
--   * the app_settings keys auto_approve_reseller, feature_affiliate_enabled,
--     feature_reseller_team_withdraw, feature_reseller_notices.
--
-- Changed:
--   * every 'moderator' account becomes a regular freelancer ('creator').
--     Its own payments, links, wallets and withdrawals are untouched, so its
--     balance is unchanged (ci/role_removal_before.sql / _after.sql prove it
--     for every account);
--   * withdrawal fee = the account's own override, else the global default
--     (default_withdrawal_fee_percent), else 0;
--   * admin_review_account_application: approving now sets the account
--     'active' (it wrote 'approved' into profiles.account_status, which the
--     check constraint refuses, so every approval through it failed);
--   * new admin_request_withdrawal_for(user, amount, method, destination):
--     an admin queues a USDT withdrawal on an account's behalf, with the same
--     checks a reseller's request had (stop switch, active account, $5
--     minimum, saved wallet, single and daily limits, balance, fee).
--
-- Compatibility shims (dropped by a later migration once the new payment
-- service and user-withdraw edge function are deployed):
--   * self_withdraw_allowed(uuid) now always returns true (service_role
--     only). The previous payment service still selects it;
--   * my_withdraw_settings() still returns 'self_withdraw_allowed': true,
--     which the previously deployed user-withdraw edge function checks.
--
-- PRECONDITION: this migration ABORTS, changing nothing, if any reseller
-- relationship or reseller-specific setting still holds data:
--   * a profile with referred_by, affiliate_code, cost_locked = true or
--     team_cost_percent set;
--   * a row in moderator_assignments, reseller_notices, team_messages or
--     reseller_alert_channels;
--   * a reseller_settings row with a team withdrawal fee or with
--     allow_freelancer_self_withdraw = true;
--   * a pending reseller application;
--   * a site domain assigned to an account (owner_id set).
-- There is no silent deletion or conversion of any of that. Production on
-- 2026-10-05 had none of it (one empty reseller_settings row: fee null,
-- switch off, which is the default and carries no data).
--
-- Safe to re-run: the precondition only reads columns and tables that still
-- exist, every drop is "if exists", every function is created "or replace"
-- (or dropped and recreated when its signature changes).
-- ============================================================

-- ---------- 0. Precondition: nothing to lose ----------
do $$
declare
  v_reasons text[] := '{}';
  v_n bigint;
  t text;
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'profiles' and column_name = 'referred_by') then
    execute 'select count(*) from public.profiles where referred_by is not null' into v_n;
    if v_n > 0 then v_reasons := v_reasons || format('%s profile(s) on a reseller team (referred_by)', v_n); end if;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'profiles' and column_name = 'affiliate_code') then
    execute 'select count(*) from public.profiles where affiliate_code is not null' into v_n;
    if v_n > 0 then v_reasons := v_reasons || format('%s profile(s) with an affiliate code', v_n); end if;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'profiles' and column_name = 'cost_locked') then
    execute 'select count(*) from public.profiles where coalesce(cost_locked, false)' into v_n;
    if v_n > 0 then v_reasons := v_reasons || format('%s profile(s) with a locked cost rate', v_n); end if;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'profiles' and column_name = 'team_cost_percent') then
    execute 'select count(*) from public.profiles where team_cost_percent is not null' into v_n;
    if v_n > 0 then v_reasons := v_reasons || format('%s profile(s) with a team cost rate', v_n); end if;
  end if;
  foreach t in array array['moderator_assignments', 'reseller_notices', 'team_messages', 'reseller_alert_channels'] loop
    if to_regclass('public.' || t) is not null then
      execute format('select count(*) from public.%I', t) into v_n;
      if v_n > 0 then v_reasons := v_reasons || format('%s row(s) in %s', v_n, t); end if;
    end if;
  end loop;
  if to_regclass('public.reseller_settings') is not null then
    execute 'select count(*) from public.reseller_settings
              where team_withdrawal_fee_percent is not null or coalesce(allow_freelancer_self_withdraw, false)' into v_n;
    if v_n > 0 then v_reasons := v_reasons || format('%s reseller_settings row(s) with a team fee or self-withdraw on', v_n); end if;
  end if;
  select count(*) into v_n from public.account_applications where requested_role = 'reseller' and status = 'pending';
  if v_n > 0 then v_reasons := v_reasons || format('%s pending reseller application(s)', v_n); end if;
  if to_regclass('public.site_domains') is not null then
    select count(*) into v_n from public.site_domains where owner_id is not null;
    if v_n > 0 then v_reasons := v_reasons || format('%s site domain(s) assigned to an account', v_n); end if;
  end if;

  if cardinality(v_reasons) > 0 then
    raise exception 'ABORT 20261005020000: reseller data exists (%). Nothing was changed. Decide what happens to it in a reviewed migration first.',
      array_to_string(v_reasons, '; ');
  end if;
end $$;

-- ---------- 1. Triggers that only served the reseller role ----------
drop trigger if exists trg_reseller_affiliate_code on public.profiles;
drop trigger if exists trg_clear_link_costs_on_lock on public.profiles;
drop trigger if exists trg_guard_withdrawal_self_allowed on public.withdrawals;

-- ---------- 2. Reseller tables (empty, checked above; their policies go with them) ----------
drop table if exists public.reseller_notices;
drop table if exists public.team_messages;
drop table if exists public.reseller_alert_channels;
drop table if exists public.moderator_assignments;
drop table if exists public.reseller_settings;

-- ---------- 3. Move reseller accounts to regular freelancer accounts ----------
do $$
declare r record;
begin
  for r in select id from public.profiles where role = 'moderator' loop
    update public.profiles set role = 'creator' where id = r.id;
    perform public.record_audit('profile.role_changed', 'profile', r.id::text,
      jsonb_build_object('role', 'moderator'), jsonb_build_object('role', 'creator'),
      '20261005020000: reseller role removed; account kept as a freelancer');
  end loop;
end $$;
-- Decided (not pending) reseller applications keep their decision; only the
-- requested role label changes, because 'reseller' is no longer valid.
update public.account_applications set requested_role = 'freelancer' where requested_role = 'reseller';

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('creator', 'admin'));
alter table public.account_applications drop constraint if exists account_applications_requested_role_check;
alter table public.account_applications add constraint account_applications_requested_role_check
  check (requested_role in ('freelancer'));

-- ---------- 4. Functions that only existed for the reseller role ----------
drop function if exists public.admin_assign_creator(uuid, uuid, boolean);
drop function if exists public.admin_list_reseller_settings();
drop function if exists public.admin_list_resellers();
drop function if exists public.admin_list_staff();
drop function if exists public.admin_set_domain_owner(uuid, uuid);
drop function if exists public.admin_set_reseller_self_withdraw(uuid, boolean);
drop function if exists public.admin_set_reseller_withdrawal_fee(uuid, numeric);
drop function if exists public.attach_freelancer_to_reseller(uuid, uuid);
drop function if exists public.clear_link_costs_on_lock();
drop function if exists public.ensure_reseller_affiliate_code();
drop function if exists public.cpay_make_affiliate_code(uuid);
drop function if exists public.guard_withdrawal_self_allowed();
drop function if exists public.self_withdraw_off_message();
drop function if exists public.link_update_is_lock_clear(public.payment_links, public.payment_links, text);
drop function if exists public.my_team_totals();
drop function if exists public.my_team_members();
drop function if exists public.post_reseller_notice(text, text);
drop function if exists public.send_team_message(uuid, text);
drop function if exists public.reseller_lock_team_cost(numeric, boolean);
drop function if exists public.reseller_request_withdrawal_for(uuid, numeric, text, text);
drop function if exists public.reseller_set_freelancer_cost(uuid, numeric, boolean);
drop function if exists public.reseller_set_self_withdraw(boolean);
drop function if exists public.reseller_team_daily_summary(integer);
drop function if exists public.set_reseller_telegram(uuid, text, boolean);
drop function if exists public.telegram_resellers_for(uuid);
drop function if exists public.reseller_team_ids(uuid);
drop function if exists public.enqueue_daily_close(date);
drop function if exists public.staff_customer_directory();
drop function if exists public.staff_customer_totals();
drop function if exists public.staff_daily_settled(integer);
drop function if exists public.staff_global_stats(timestamptz, timestamptz);
drop function if exists public.staff_list_payments(integer, integer, text, text, text);

-- The reseller daily close was the only job calling enqueue_daily_close.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobname) from cron.job where jobname = 'cpay-daily-close';
  end if;
end $$;

-- ---------- 5. Withdrawals: own fee, else the global default ----------
create or replace function public.withdrawal_fee_resolution(p_user_id uuid)
returns table(fee_percent numeric, source text)
language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_own numeric; v_global numeric;
begin
  select p.withdrawal_fee_percent into v_own from profiles p where p.id = p_user_id;
  if v_own is not null then
    fee_percent := v_own; source := 'account'; return next; return;
  end if;
  begin
    select round((value->>'percent')::numeric, 2) into v_global
      from app_settings where key = 'default_withdrawal_fee_percent';
  exception when others then v_global := null;
  end;
  if v_global is not null and v_global >= 0 and v_global <= 100 then
    fee_percent := v_global; source := 'global';
  else
    fee_percent := 0; source := 'none';
  end if;
  return next;
end;
$function$;

-- Compatibility shim: the previous payment service selects this. Every
-- account may withdraw by itself now. Dropped by a later migration.
create or replace function public.self_withdraw_allowed(p_user_id uuid)
returns boolean
language sql stable security definer set search_path to 'public'
as $function$
  select true;
$function$;
revoke all on function public.self_withdraw_allowed(uuid) from public, anon, authenticated;
grant execute on function public.self_withdraw_allowed(uuid) to service_role;

create or replace function public.my_withdraw_settings()
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_uid uuid := auth.uid(); v_fee record; v_global numeric; v_p profiles;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  select * into v_p from profiles where id = v_uid;
  select * into v_fee from withdrawal_fee_resolution(v_uid);
  begin
    select round((value->>'percent')::numeric, 2) into v_global from app_settings where key = 'default_withdrawal_fee_percent';
  exception when others then v_global := null;
  end;
  return jsonb_build_object(
    'fee_percent', v_fee.fee_percent,
    'fee_source', v_fee.source,
    -- Kept for the previously deployed user-withdraw edge function.
    'self_withdraw_allowed', true,
    'global_fee_percent', coalesce(v_global, 0),
    'withdraw_threshold', v_p.withdraw_threshold,
    'preferred_usdt_network', v_p.preferred_usdt_network,
    'auto_withdraw_enabled', coalesce(v_p.auto_withdraw_enabled, false)
  );
end;
$function$;

drop function if exists public.admin_withdraw_fee_overview();
create function public.admin_withdraw_fee_overview()
returns table(user_id uuid, own_fee_percent numeric, fee_percent numeric, source text)
language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  return query
  select p.id, p.withdrawal_fee_percent, r.fee_percent, r.source
    from profiles p cross join lateral withdrawal_fee_resolution(p.id) r;
end;
$function$;
revoke all on function public.admin_withdraw_fee_overview() from public, anon;
grant execute on function public.admin_withdraw_fee_overview() to authenticated;

create or replace function public.admin_request_withdrawal_for(p_user_id uuid, p_amount numeric, p_method text, p_destination text)
returns withdrawals
language plpgsql security definer set search_path to 'public'
as $function$
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
    case when p_user_id = auth.uid() then 'USDT payout' else 'USDT payout submitted by admin' end,
    'USDT', v_wallet.network
  ) returning * into v_row;
  perform record_audit('withdrawal.requested_by_admin', 'withdrawal', v_row.id::text, null,
    jsonb_build_object('user_id', p_user_id, 'amount_requested', p_amount, 'fee_percent', v_fee, 'chain', v_wallet.network));
  return v_row;
end;
$function$;
revoke all on function public.admin_request_withdrawal_for(uuid, numeric, text, text) from public, anon;
grant execute on function public.admin_request_withdrawal_for(uuid, numeric, text, text) to authenticated, service_role;

create or replace function public.reserve_stablecoin_withdrawal(p_user_id uuid, p_quote_id text, p_amount numeric, p_fee_percent numeric, p_amount_after_fee numeric, p_coin text, p_chain text, p_destination text, p_quoted_fee numeric, p_amount_out numeric, p_amount_sat bigint, p_quote_expires_at timestamp with time zone)
returns withdrawals
language plpgsql security definer set search_path to 'public'
as $function$
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
  if p_fee_percent is distinct from resolve_withdrawal_fee(p_user_id)
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
end; $function$;

create or replace function public.system_queue_withdrawal(p_user_id uuid)
returns uuid
language plpgsql security definer set search_path to 'public'
as $function$
declare v_profile profiles; v_limit profile_limits; v_available numeric; v_used numeric;
        v_amount numeric; v_id uuid; v_fee numeric; v_wallet usdt_wallets; v_threshold numeric;
begin
  if coalesce((select value::text from app_settings where key='emergency_withdrawals_stop'),'false')='true' then return null; end if;
  select * into v_profile from profiles where id=p_user_id for update;
  if not found or v_profile.account_status <> 'active' or coalesce(v_profile.auto_withdraw_enabled,false)=false then return null; end if;
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
$function$;

-- ---------- 6. Sign-up, approval and roles: freelancer or admin ----------
create or replace function public.cpay_auto_approval_enabled(p_role text)
returns boolean
language sql stable security definer set search_path to 'public'
as $function$
  -- p_role is kept for the signature; every application is a freelancer one.
  select coalesce(((select value from app_settings where key = 'auto_approve_freelancer')::text)::boolean, false);
$function$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_name text := coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''), split_part(new.email, '@', 1));
  v_default_links int;
  v_auto boolean := cpay_auto_approval_enabled('freelancer');
  v_status text := case when v_auto then 'active' else 'pending' end;
begin
  select coalesce((value->>'count')::int, 5)
    into v_default_links
  from app_settings where key = 'default_max_payment_links';

  insert into public.profiles
    (id, email, display_name, role, account_status,
     withdrawal_fee_percent, max_payment_links)
  values
    (new.id, new.email, v_name, 'creator', v_status,
     null, coalesce(v_default_links, 5))
  on conflict (id) do nothing;

  insert into public.account_applications
    (user_id, email, display_name, requested_role, status, reviewed_at)
  values
    (new.id, new.email, v_name, 'freelancer',
     case when v_auto then 'approved' else 'pending' end,
     case when v_auto then now() else null end)
  on conflict (user_id) do update
    set email = excluded.email,
        display_name = excluded.display_name,
        requested_role = excluded.requested_role,
        updated_at = now();

  return new;
end;
$function$;

create or replace function public.admin_set_auto_approval(p_role text, p_enabled boolean)
returns void
language plpgsql security definer set search_path to 'public'
as $function$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if p_role is distinct from 'freelancer' then raise exception 'Invalid application role'; end if;
  insert into app_settings(key, value)
  values ('auto_approve_freelancer', to_jsonb(coalesce(p_enabled, false)))
  on conflict (key) do update set value = excluded.value, updated_at = now();
end;
$function$;

create or replace function public.admin_review_account_application(p_application_id uuid, p_decision text, p_note text default null::text)
returns void
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_app account_applications;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if p_decision not in ('approved', 'rejected', 'suspended') then
    raise exception 'Invalid application decision';
  end if;

  select * into v_app from account_applications where id = p_application_id for update;
  if not found then raise exception 'Application not found'; end if;
  if v_app.user_id is null then raise exception 'Application has no user account'; end if;

  -- An admin account is never demoted by an application decision.
  -- 'approved' maps to the 'active' account status: before this file the
  -- decision was written as the status itself, which profiles_account_status_check
  -- refuses, so approving through this RPC always failed.
  update profiles
  set account_status = case when p_decision = 'approved' then 'active' else p_decision end,
      role = case when role = 'admin' then role else 'creator' end
  where id = v_app.user_id;

  update account_applications
  set status = p_decision,
      review_note = nullif(trim(coalesce(p_note, '')), ''),
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      updated_at = now()
  where id = p_application_id;
end;
$function$;

create or replace function public.admin_set_role(p_user_id uuid, p_role text)
returns void
language plpgsql security definer set search_path to 'public'
as $function$
declare v_admin_count int; v_old text;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if p_role not in ('creator', 'admin') then
    raise exception 'Unknown role';
  end if;

  if p_role <> 'admin' then
    select count(*) into v_admin_count from profiles
     where role = 'admin' and id <> p_user_id;
    if v_admin_count = 0 then
      raise exception 'This is the only admin account — promote someone else first';
    end if;
  end if;

  select role into v_old from profiles where id = p_user_id;
  update profiles set role = p_role where id = p_user_id;

  perform record_audit(
    'profile.role_changed', 'profile', p_user_id::text,
    jsonb_build_object('role', v_old),
    jsonb_build_object('role', p_role)
  );
end; $function$;

create or replace function public.admin_update_account_control(p_user_id uuid, p_role text, p_account_status text, p_review_note text default null::text)
returns profiles
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_old_role text;
  v_old_status text;
  v_admins int;
  v_row public.profiles;
begin
  if not is_admin() then
    raise exception 'Not authorized';
  end if;

  if p_user_id = auth.uid() then
    raise exception 'You cannot change your own admin access';
  end if;

  if p_role not in ('creator', 'admin') then
    raise exception 'Invalid role';
  end if;

  if p_account_status not in ('pending', 'active', 'rejected', 'suspended') then
    raise exception 'Invalid account status';
  end if;

  select role, account_status
    into v_old_role, v_old_status
    from public.profiles
   where id = p_user_id
   for update;

  if not found then
    raise exception 'Profile not found';
  end if;

  if v_old_role = 'admin'
     and (p_role <> 'admin' or p_account_status <> 'active') then
    select count(*)
      into v_admins
      from public.profiles
     where role = 'admin'
       and account_status = 'active';

    if v_admins <= 1 then
      raise exception 'The last active admin cannot be removed';
    end if;
  end if;

  update public.profiles
     set role = p_role,
         account_status = p_account_status
   where id = p_user_id
   returning * into v_row;

  update public.account_applications
     set status = case
                    when p_account_status = 'active' then 'approved'
                    else p_account_status
                  end,
         review_note = nullif(trim(p_review_note), ''),
         reviewed_by = auth.uid(),
         reviewed_at = now(),
         updated_at = now()
   where user_id = p_user_id;

  perform public.record_audit(
    'profile.account_control_changed',
    'profile',
    p_user_id::text,
    jsonb_build_object('role', v_old_role, 'account_status', v_old_status),
    jsonb_build_object('role', p_role, 'account_status', p_account_status),
    p_review_note
  );

  return v_row;
end;
$function$;

create or replace function public.admin_set_feature_toggle(p_key text, p_enabled boolean)
returns boolean
language plpgsql security definer set search_path to 'public'
as $function$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if p_key not in (
    'emergency_payments_stop','emergency_withdrawals_stop','manual_withdrawals_enabled',
    'auto_withdraw_enabled','public_feed_enabled','hide_small_payments_enabled'
  ) then raise exception 'Unknown toggle'; end if;
  insert into app_settings(key, value) values (p_key, to_jsonb(p_enabled))
  on conflict (key) do update set value = to_jsonb(p_enabled);
  perform record_audit('settings.feature_toggle', 'setting', p_key,
    null, jsonb_build_object('enabled', p_enabled));
  return p_enabled;
end;
$function$;

-- ---------- 7. Profile and link guards: no lock, no team price ----------
create or replace function public.guard_profile_updates()
returns trigger
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  -- Anything else needs an admin or a no-session caller.
  user_editable_fields text[] := array[
    'display_name',
    'bio',
    'public_slug',
    'cost_percent',
    'withdraw_threshold',
    'preferred_usdt_network',
    'auto_withdraw_enabled'
  ];
begin
  -- No session: service role, cron, signup trigger.
  if v_uid is null then
    return new;
  end if;

  -- Nobody changes their own role or account status, admins included:
  -- that is done by another active admin, so the last active admin cannot
  -- lock themselves (or the platform) out.
  if old.id = v_uid
     and (new.role is distinct from old.role
          or new.account_status is distinct from old.account_status) then
    raise exception 'You cannot change your own role or account status';
  end if;

  if is_admin() then
    return new;
  end if;

  if (to_jsonb(new) - user_editable_fields)
     is distinct from
     (to_jsonb(old) - user_editable_fields) then
    raise exception 'You may only change user-editable profile fields';
  end if;

  -- Someone else's row: only an admin sets another account's cost rate.
  if old.id <> v_uid and new.cost_percent is distinct from old.cost_percent then
    raise exception 'Only an admin can set another account''s cost rate';
  end if;

  return new;
end;
$function$;

create or replace function public.guard_link_updates()
returns trigger
language plpgsql security definer set search_path to 'public'
as $function$
begin
  if auth.uid() is null or is_admin() then
    return new;
  end if;

  if new.user_id is distinct from auth.uid() then
    raise exception 'Cannot create or move a link for another user';
  end if;

  if tg_op = 'INSERT' then
    return new;
  end if;

  if new.user_id is distinct from old.user_id then
    raise exception 'Cannot change link owner';
  end if;
  if new.deleted_at is distinct from old.deleted_at then
    raise exception 'Deleted links cannot be restored from here';
  end if;
  if new.cost_percent is distinct from old.cost_percent
     and new.cost_percent is not null
     and (new.cost_percent < 0 or new.cost_percent > 1000) then
    raise exception 'Cost must be between 0 and 1000';
  end if;
  return new;
end;
$function$;

create or replace function public.guard_payment_link_account_status()
returns trigger
language plpgsql security definer set search_path to 'public'
as $function$
begin
  if not is_admin() and not account_is_active(new.user_id) then
    raise exception 'Account approval is required before creating payment links';
  end if;
  return new;
end;
$function$;

create or replace function public.set_my_cost_percent(p_percent numeric)
returns numeric
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_old numeric;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  select role, cost_percent into v_role, v_old from profiles where id = v_uid;
  if v_role is distinct from 'creator' then raise exception 'Not authorized'; end if;
  if p_percent is null or p_percent < 0 then raise exception 'Cost must be 0 or more'; end if;
  update profiles set cost_percent = round(p_percent, 3) where id = v_uid;
  perform record_audit(
    'profile.cost_percent_changed', 'profile', v_uid::text,
    jsonb_build_object('cost_percent', v_old),
    jsonb_build_object('cost_percent', round(p_percent, 3))
  );
  return round(p_percent, 3);
end;
$function$;

create or replace function public.set_link_cost_percent(p_link_id uuid, p_percent numeric)
returns numeric
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_old numeric;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  select pl.user_id, pl.cost_percent into v_owner, v_old
  from payment_links pl
  where pl.id = p_link_id and pl.deleted_at is null;
  if v_owner is null then raise exception 'Link not found'; end if;
  if v_owner <> v_uid and not is_admin() then
    raise exception 'Not authorized';
  end if;
  if p_percent is not null and (p_percent < 0 or p_percent > 1000) then
    raise exception 'Cost must be between 0 and 1000';
  end if;
  update payment_links
     set cost_percent = case when p_percent is null then null else round(p_percent, 3) end
   where id = p_link_id;
  perform record_audit(
    'link.cost_changed', 'payment_link', p_link_id::text,
    jsonb_build_object('cost_percent', v_old),
    jsonb_build_object('cost_percent', case when p_percent is null then null else round(p_percent, 3) end)
  );
  return p_percent;
end;
$function$;

create or replace function public.set_payment_link_experience(p_link_id uuid, p_theme text default null::text, p_wallet_mode text default null::text, p_invoice_theme text default null::text)
returns boolean
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_owner uuid;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  select user_id into v_owner from payment_links where id = p_link_id and deleted_at is null;
  if v_owner is null then raise exception 'Link not found'; end if;
  if v_owner <> v_uid and not is_admin() then
    raise exception 'Not authorized';
  end if;
  if p_theme is not null and p_theme not in (
    'keypad','classic','tile','focus','receipt','pulse','ledger','studio','boulevard','aurora'
  ) then raise exception 'Unknown payment design'; end if;
  if p_wallet_mode is not null and p_wallet_mode not in ('cashapp','all_wallets') then
    raise exception 'Unknown wallet mode';
  end if;
  if p_invoice_theme is not null and p_invoice_theme not in ('default','compact','poster','night','cashier') then
    raise exception 'Unknown invoice design';
  end if;
  update payment_links
     set theme = coalesce(p_theme, theme),
         wallet_mode = coalesce(p_wallet_mode, wallet_mode),
         invoice_theme = coalesce(p_invoice_theme, invoice_theme)
   where id = p_link_id;
  return true;
end;
$function$;

create or replace function public.set_payment_link_theme(p_link_id uuid, p_theme text)
returns text
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_old text;
  v_user uuid;
begin
  if p_theme is not null and p_theme not in (
    'keypad','classic','tile','focus','receipt','pulse','ledger','studio','boulevard','aurora'
  ) then
    raise exception 'Invalid payment theme';
  end if;
  select theme, user_id into v_old, v_user from payment_links
  where id = p_link_id and deleted_at is null for update;
  if not found then raise exception 'Payment link not found'; end if;
  if not is_admin() and v_user <> auth.uid() then
    raise exception 'Not authorized';
  end if;
  update payment_links set theme = p_theme where id = p_link_id;
  return p_theme;
end;
$function$;

create or replace function public.mark_payment(p_payment_id uuid, p_note text default null::text)
returns void
language plpgsql security definer set search_path to 'public'
as $function$
declare v_owner uuid; v_status text;
begin
  select user_id, status into v_owner, v_status from payments where id = p_payment_id;
  if not found then raise exception 'Payment not found'; end if;

  if not (v_owner = auth.uid() or is_admin()) then
    raise exception 'Not authorized';
  end if;

  if v_status <> 'settled' then
    raise exception 'Only settled payments can be marked';
  end if;

  update payments
     set marked_at = now(), marked_by = auth.uid(),
         mark_note = nullif(trim(coalesce(p_note, '')), '')
   where id = p_payment_id;
end;
$function$;

create or replace function public.unmark_payment(p_payment_id uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $function$
declare v_owner uuid;
begin
  select user_id into v_owner from payments where id = p_payment_id;
  if not found then raise exception 'Payment not found'; end if;

  if not (v_owner = auth.uid() or is_admin()) then
    raise exception 'Not authorized';
  end if;

  update payments set marked_at = null, marked_by = null, mark_note = null
   where id = p_payment_id;
end;
$function$;

-- Global domains only now: per-account domains were a reseller feature.
create or replace function public.cpay_validate_domain_owner()
returns trigger
language plpgsql security definer set search_path to 'public'
as $function$
begin
  if new.owner_id is not null then
    raise exception 'Domains are global; they cannot be assigned to an account';
  end if;
  return new;
end; $function$;

-- ---------- 8. Read functions: freelancers and admins only ----------
drop function if exists public.handles_creator(uuid);
drop function if exists public.is_moderator();
drop function if exists public.is_reseller();
drop function if exists public.reseller_owns(uuid);
drop function if exists public.my_reseller_id();
drop function if exists public.reseller_of(uuid);

create or replace function public.admin_list_payments(p_limit integer default 100, p_offset integer default 0, p_search text default null::text)
returns table(id uuid, amount_requested numeric, amount_settled numeric, status text, method text, created_at timestamp with time zone, settled_at timestamp with time zone, expires_at timestamp with time zone, customer_city text, customer_country text, creator_id uuid, creator_email text, creator_name text, link_slug text, invoice_ref text, lightning_invoice text, marked_at timestamp with time zone, marked_by_name text, mark_note text, total_count bigint)
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_limit int := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_search text := nullif(trim(coalesce(p_search, '')), '');
begin
  if not is_admin() then raise exception 'Not authorized'; end if;

  return query
  with filtered as (
    select p.*
    from payments p
    join profiles pr on pr.id = p.user_id
    left join payment_links pl on pl.id = p.payment_link_id
    where (
        v_search is null
        or p.invoice_ref ilike '%' || v_search || '%'
        or p.lightning_invoice ilike '%' || v_search || '%'
        or pr.email ilike '%' || v_search || '%'
        or pl.slug ilike '%' || v_search || '%'
      )
  )
  select
    f.id,
    case when should_show_buyer_amount(f.user_id) then coalesce(f.buyer_amount, f.amount_requested) else f.amount_requested end,
    case when f.amount_settled is null then null
         when should_show_buyer_amount(f.user_id) then coalesce(f.buyer_amount, f.amount_settled)
         else f.amount_settled end,
    f.status, f.method,
    f.created_at, f.settled_at, f.expires_at,
    f.customer_city, f.customer_country,
    f.user_id, pr.email, pr.display_name,
    pl.slug,
    f.invoice_ref, f.lightning_invoice,
    f.marked_at, mb.display_name, f.mark_note,
    count(*) over () as total_count
  from filtered f
  join profiles pr on pr.id = f.user_id
  left join payment_links pl on pl.id = f.payment_link_id
  left join profiles mb on mb.id = f.marked_by
  order by f.created_at desc
  limit v_limit offset v_offset;
end; $function$;

create or replace function public.admin_list_people()
returns table(id uuid, email text, display_name text, role text, withdrawal_fee_percent numeric, max_payment_links integer, auto_withdraw_enabled boolean, cost_percent numeric, total_settled numeric, available_balance numeric, created_at timestamp with time zone)
language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  return query
  select
    pr.id, pr.email, pr.display_name, pr.role,
    pr.withdrawal_fee_percent, pr.max_payment_links,
    pr.auto_withdraw_enabled,
    coalesce(pr.cost_percent, 0),
    coalesce((select sum(p.amount_settled) from payments p
              where p.user_id = pr.id and p.status = 'settled'), 0),
    coalesce((select b.available from get_balance_for(pr.id) b), 0),
    pr.created_at
  from profiles pr
  where pr.role = 'creator'
  order by pr.created_at desc;
end;
$function$;

create or replace function public.admin_link_usage()
returns table(user_id uuid, links_used integer, link_limit integer, max_payment_links integer)
language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  return query
  select pr.id, u.links_used, u.link_limit, pr.max_payment_links
  from profiles pr
  cross join lateral link_usage_for(pr.id) u
  where pr.role = 'creator';
end;
$function$;

create or replace function public.admin_global_stats(p_start timestamp with time zone default null::timestamp with time zone, p_end timestamp with time zone default null::timestamp with time zone)
returns table(total_settled numeric, total_admin_profit numeric, total_withdrawn numeric, pending_withdrawals_count integer, pending_withdrawals_amount numeric, payment_count bigint, active_creators bigint, calculated_node_balance numeric)
language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  v_total_settled numeric;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;

  select coalesce(sum(amount_settled), 0) into v_total_settled
  from payments
  where status = 'settled'
    and (p_start is null or settled_at >= p_start)
    and (p_end   is null or settled_at <= p_end);

  return query
  select
    v_total_settled,
    coalesce((
      select sum(p.platform_fee_amount)
      from payments p
      where p.status = 'settled'
        and (p_start is null or p.settled_at >= p_start)
        and (p_end   is null or p.settled_at <= p_end)
    ), 0),
    coalesce((
      select sum(w.amount_after_fee) from withdrawals w
      where w.status = 'paid'
        and (p_start is null or w.processed_at >= p_start)
        and (p_end   is null or w.processed_at <= p_end)
    ), 0),
    (select count(*) from withdrawals w where w.status = 'pending')::int,
    coalesce((select sum(w.amount_requested) from withdrawals w where w.status = 'pending'), 0),
    (select count(*) from payments p
      where p.status = 'settled'
        and (p_start is null or p.settled_at >= p_start)
        and (p_end   is null or p.settled_at <= p_end)),
    (select count(*) from profiles where account_status = 'active' and role = 'creator'),
    v_total_settled;
end;
$function$;

create or replace function public.get_public_store(p_user_id uuid)
returns table(display_name text, tagline text, bio text, avatar_url text, theme text, accent text, cta text, links jsonb)
language sql stable security definer set search_path to 'public'
as $function$
  select coalesce(pr.display_name,'CPAY creator'),
         coalesce(pr.store_tagline,''),
         coalesce(pr.store_bio,''),
         coalesce(pr.store_avatar_url,''),
         coalesce(pr.store_theme,'midnight'),
         coalesce(pr.store_accent,'#00D632'),
         coalesce(pr.store_cta,'Pay now'),
         coalesce((select jsonb_agg(jsonb_build_object(
           'slug',l.slug,
           'display_name',coalesce(l.display_name,l.slug),
           'theme',coalesce(l.theme,'keypad'),
           'og_image',l.og_image
         ) order by l.created_at desc)
         from payment_links l where l.user_id=p_user_id and l.is_active=true and l.deleted_at is null),'[]'::jsonb)
  from profiles pr
  where pr.id=p_user_id
    and pr.role = 'creator'
    and pr.account_status = 'active';
$function$;

create or replace function public.admin_get_profile_workspace(p_user_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare v_workspace jsonb;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if p_user_id is null or not exists (select 1 from profiles where id=p_user_id) then raise exception 'Profile not found'; end if;
  select jsonb_build_object(
    'profile',to_jsonb(p),
    'application',coalesce((select to_jsonb(a) from account_applications a where a.user_id=p.id order by a.created_at desc limit 1),'{}'::jsonb),
    'domains',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'hostname',d.hostname,'purpose',d.purpose,'theme',d.theme,'is_active',d.is_active,'is_primary_site',d.is_primary_site,'scope','global') order by d.sort_order,d.hostname) from site_domains d where d.is_active and d.owner_id is null),'[]'::jsonb),
    'links',coalesce((select jsonb_agg(x.row order by x.created_at desc) from (select jsonb_build_object('id',l.id,'slug',l.slug,'display_name',l.display_name,'theme',l.theme,'is_active',l.is_active,'created_at',l.created_at,'payment_count',(select count(*) from payments pay where pay.payment_link_id=l.id),'settled_total',coalesce((select sum(pay.amount_settled) from payments pay where pay.payment_link_id=l.id and pay.status='settled'),0)) as row,l.created_at from payment_links l where l.user_id=p.id and l.deleted_at is null) x),'[]'::jsonb),
    'payment_summary',jsonb_build_object('count',(select count(*) from payments pay where pay.user_id=p.id),'settled_count',(select count(*) from payments pay where pay.user_id=p.id and pay.status='settled'),'settled_total',coalesce((select sum(pay.amount_settled) from payments pay where pay.user_id=p.id and pay.status='settled'),0),'last_settled_at',(select max(pay.settled_at) from payments pay where pay.user_id=p.id and pay.status='settled')),
    'withdrawals',coalesce((select jsonb_agg(x.row order by x.requested_at desc) from (select jsonb_build_object('id',w.id,'amount_requested',w.amount_requested,'amount_after_fee',w.amount_after_fee,'fee_percent',w.fee_percent,'method',w.method,'status',w.status,'admin_note',w.admin_note,'requested_at',w.requested_at,'processed_at',w.processed_at) as row,w.requested_at from withdrawals w where w.user_id=p.id order by w.requested_at desc limit 100) x),'[]'::jsonb),
    'audit',coalesce((select jsonb_agg(x.row order by x.occurred_at desc) from (select jsonb_build_object('id',al.id,'occurred_at',al.occurred_at,'actor_email',al.actor_email,'action',al.action,'old_value',al.old_value,'new_value',al.new_value,'note',al.note) as row,al.occurred_at from audit_log al where (al.subject_type='profile' and al.subject_id=p.id::text) or (al.subject_type='payment_link' and al.subject_id in (select l.id::text from payment_links l where l.user_id=p.id)) order by al.occurred_at desc limit 100) x),'[]'::jsonb)
  ) into v_workspace from profiles p where p.id=p_user_id;
  return v_workspace;
end; $function$;

drop function if exists public.admin_list_business_profiles();
create function public.admin_list_business_profiles()
returns table(id uuid, email text, display_name text, role text, account_status text, platform_fee_percent numeric, hide_small_payments_mode text, withdrawal_fee_percent numeric, earned numeric, available numeric, created_at timestamp with time zone)
language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  return query
  select pr.id, pr.email, pr.display_name, pr.role, pr.account_status,
         coalesce(pr.platform_fee_percent, cpay_platform_fee_percent(pr.id)),
         coalesce(pr.hide_small_payments_mode, 'inherit'),
         pr.withdrawal_fee_percent,
         b.earned, b.available, pr.created_at
  from profiles pr
  left join lateral get_balance_for(pr.id) b on true
  where pr.role in ('creator','admin')
  order by pr.created_at desc;
end;
$function$;
revoke all on function public.admin_list_business_profiles() from public, anon;
grant execute on function public.admin_list_business_profiles() to authenticated;

drop function if exists public.my_dashboard_profile();
create function public.my_dashboard_profile()
returns table(user_id uuid, email text, display_name text, role text, account_status text, created_at timestamp with time zone, links_used integer, link_limit integer, cost_percent numeric)
language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  return query
  select
    pr.id, pr.email, pr.display_name, pr.role, pr.account_status, pr.created_at,
    u.links_used, u.link_limit,
    pr.cost_percent
  from profiles pr
  cross join link_usage_for(v_uid) u
  where pr.id = v_uid;
end;
$function$;
revoke all on function public.my_dashboard_profile() from public, anon;
grant execute on function public.my_dashboard_profile() to authenticated;

drop function if exists public.my_earnings_split();
create function public.my_earnings_split()
returns table(settled numeric, platform_fee numeric, net numeric, cost_percent numeric)
language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  return query
  select
    coalesce((select sum(p.amount_settled) from payments p where p.user_id = v_uid and p.status = 'settled' and p.amount_settled >= hide_threshold_for(p.user_id)), 0),
    coalesce((select sum(p.platform_fee_amount) from payments p where p.user_id = v_uid and p.status = 'settled' and p.amount_settled >= hide_threshold_for(p.user_id)), 0),
    (select b.available from get_balance_for(v_uid) b),
    pr.cost_percent
  from profiles pr
  where pr.id = v_uid;
end;
$function$;
revoke all on function public.my_earnings_split() from public, anon;
grant execute on function public.my_earnings_split() to authenticated, service_role;

create or replace function public.daily_link_breakdown(p_days integer default 14, p_user_id uuid default null::uuid)
returns table(user_id uuid, email text, display_name text, business_day date, day_start timestamp with time zone, day_end timestamp with time zone, link_id uuid, slug text, link_name text, is_active boolean, deleted_at timestamp with time zone, cost_percent_now numeric, cost_percent_used_min numeric, cost_percent_used_max numeric, payment_count bigint, settled numeric, platform_fee numeric, earnings numeric)
language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_target uuid := coalesce(p_user_id, auth.uid());
  v_admin boolean := is_admin();
  v_to date := current_business_day();
  v_from date := current_business_day() - (least(greatest(coalesce(p_days, 14), 1), 60) - 1);
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if v_target <> v_uid and not v_admin then
    raise exception 'Not authorized';
  end if;

  return query
  select
    pr.id, pr.email, pr.display_name,
    l.business_day, l.day_start, l.day_end,
    l.link_id, l.slug, l.link_name, l.is_active, l.deleted_at,
    l.cost_percent_now, l.cost_percent_used_min, l.cost_percent_used_max,
    l.payment_count, l.settled, l.platform_fee, l.earnings
  from dashboard_link_days(array[v_target], v_from, v_to, not v_admin) l
  join profiles pr on pr.id = l.user_id
  order by l.business_day desc, l.settled desc, l.slug nulls last;
end;
$function$;

drop function if exists public.admin_daily_summary(integer, uuid, uuid);
create or replace function public.admin_daily_summary(p_days integer default 14, p_user_id uuid default null::uuid)
returns table(user_id uuid, email text, display_name text, role text, account_status text, created_at timestamp with time zone, max_payment_links integer, business_day date, day_start timestamp with time zone, day_end timestamp with time zone, link_count integer, paid_link_count integer, cost_rates numeric[], payment_count bigint, settled numeric, platform_fee numeric, earnings numeric)
language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  v_to date := current_business_day();
  v_from date := current_business_day() - (least(greatest(coalesce(p_days, 14), 1), 60) - 1);
  v_ids uuid[];
begin
  if not is_admin() then raise exception 'Not authorized'; end if;

  select array_agg(pr.id) into v_ids
  from profiles pr
  where pr.role = 'creator'
    and (p_user_id is null or pr.id = p_user_id);

  if v_ids is null then return; end if;

  return query
  select
    pr.id, pr.email, pr.display_name, pr.role, pr.account_status, pr.created_at,
    least(coalesce(pr.max_payment_links, max_links_per_owner()), max_links_per_owner()),
    d.business_day, d.day_start, d.day_end,
    d.link_count, d.paid_link_count, d.cost_rates,
    d.payment_count, d.settled, d.platform_fee, d.earnings
  from dashboard_user_days(v_ids, v_from, v_to, false) d
  join profiles pr on pr.id = d.user_id
  where p_user_id is not null or d.link_count > 0 or d.payment_count > 0
  order by d.business_day desc, d.settled desc, pr.email;
end;
$function$;
revoke all on function public.admin_daily_summary(integer, uuid) from public, anon;
grant execute on function public.admin_daily_summary(integer, uuid) to authenticated, service_role;

drop function if exists public.admin_daily_timeseries(integer, uuid, uuid);
create or replace function public.admin_daily_timeseries(p_days integer default 30, p_user_id uuid default null::uuid)
returns table(business_day date, day_start timestamp with time zone, day_end timestamp with time zone, payment_count bigint, settled numeric, platform_fee numeric, earnings numeric, active_earners integer, withdrawal_fee_revenue numeric)
language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  v_days int := least(greatest(coalesce(p_days, 30), 1), 366);
  v_to date := current_business_day();
  v_from date := current_business_day() - (least(greatest(coalesce(p_days, 30), 1), 366) - 1);
  v_ids uuid[];
begin
  if not is_admin() then raise exception 'Not authorized'; end if;

  if p_user_id is not null then
    v_ids := array[p_user_id];
  end if;

  return query
  with pay as (
    select * from dashboard_settled_payments(v_ids, v_from, v_to, false)
  ),
  pay_day as (
    select p.business_day, count(*) as n, sum(p.amount_settled) as settled,
           sum(p.platform_fee) as fee,
           count(distinct p.user_id)::int as earners
    from pay p group by p.business_day
  ),
  wd_day as (
    select business_day(w.processed_at) as business_day,
           sum(w.amount_requested - w.amount_after_fee) as fee
    from withdrawals w
    where w.status = 'paid'
      and w.processed_at >= business_day_start(v_from)
      and w.processed_at <  business_day_end(v_to)
      and (v_ids is null or w.user_id = any (v_ids))
    group by 1
  )
  select
    d.business_day, d.day_start, d.day_end,
    coalesce(pd.n, 0),
    coalesce(pd.settled, 0),
    coalesce(pd.fee, 0),
    coalesce(pd.settled, 0) - coalesce(pd.fee, 0),
    coalesce(pd.earners, 0),
    round(coalesce(wd.fee, 0), 4)
  from business_days(v_days) d
  left join pay_day pd on pd.business_day = d.business_day
  left join wd_day wd on wd.business_day = d.business_day
  order by d.business_day asc;
end;
$function$;
revoke all on function public.admin_daily_timeseries(integer, uuid) from public, anon;
grant execute on function public.admin_daily_timeseries(integer, uuid) to authenticated, service_role;

-- ---------- 9. Telegram: the admin group only ----------
create or replace function public.enqueue_payment_settled_telegram()
returns trigger
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_link payment_links;
  v_owner profiles;
begin
  -- A message must never stop a payment from settling.
  begin
    if coalesce(new.amount_settled, 0) < hide_threshold_for(new.user_id) then
      return null;
    end if;
    select * into v_link from payment_links where id = new.payment_link_id;
    select * into v_owner from profiles where id = new.user_id;
    insert into telegram_outbox (kind, ref, recipient, chat, payload)
    values ('payment_settled', new.id::text, 'admin', 'admin', jsonb_build_object(
      'payment_id', new.id,
      'link_name', coalesce(nullif(v_link.display_name, ''), v_link.slug),
      'link_slug', v_link.slug,
      'owner_id', new.user_id,
      'owner_name', coalesce(nullif(v_owner.display_name, ''), v_owner.email),
      'amount_usd', coalesce(new.amount_settled, 0),
      'amount_sat', new.amount_sat,
      'fee_usd', coalesce(new.platform_fee_amount, 0),
      'net_usd', coalesce(new.amount_settled, 0) - coalesce(new.platform_fee_amount, 0),
      'settled_at', new.settled_at,
      'show_owner', true
    ))
    on conflict on constraint telegram_outbox_once do nothing;
  exception when others then
    raise warning 'telegram message for payment % not queued: %', new.id, sqlerrm;
  end;
  return null;
end;
$function$;

-- telegram_context is long and only its role filter changes, so it is
-- patched in place (same signature, same grants). Section 11 fails the
-- migration if the old filter is still there.
do $$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.telegram_context(text, integer)'::regprocedure);
  if v_def like '%pr.role in (''creator'', ''moderator'')%' then
    execute replace(v_def, 'pr.role in (''creator'', ''moderator'')', 'pr.role = ''creator''');
  end if;
end $$;

-- ---------- 10. Columns and settings ----------
drop index if exists public.idx_profiles_affiliate_code;
drop index if exists public.idx_profiles_referred_by;
alter table public.profiles drop constraint if exists profiles_team_cost_range;
alter table public.profiles drop column if exists referred_by;
alter table public.profiles drop column if exists affiliate_code;
alter table public.profiles drop column if exists cost_locked;
alter table public.profiles drop column if exists team_cost_percent;
delete from public.app_settings
 where key in ('auto_approve_reseller', 'feature_affiliate_enabled',
               'feature_reseller_team_withdraw', 'feature_reseller_notices');

-- ---------- 11. Nothing still knows the reseller role ----------
-- validate_link_slug keeps 'moderator' and 'reseller' as reserved link
-- names; self_withdraw_allowed and my_withdraw_settings are the documented
-- compatibility shims.
do $$
declare v_left text;
begin
  select string_agg(p.oid::regprocedure::text, ', ' order by 1) into v_left
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.prosrc ~* 'reseller|moderator|referred_by|affiliate|team_cost|cost_locked|self_withdraw|handles_creator|team_messages'
    and p.oid::regprocedure::text not in (
      'validate_link_slug()', 'self_withdraw_allowed(uuid)', 'my_withdraw_settings()');
  if v_left is not null then
    raise exception '20261005020000: functions still refer to the reseller role: %', v_left;
  end if;
  if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'my_withdraw_settings'
             and prosrc ~* 'reseller') then
    raise exception '20261005020000: my_withdraw_settings still refers to resellers';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public'
             and coalesce(qual, '') || coalesce(with_check, '') ~* 'reseller|moderator|handles_creator') then
    raise exception '20261005020000: a policy still refers to the reseller role';
  end if;
end $$;
