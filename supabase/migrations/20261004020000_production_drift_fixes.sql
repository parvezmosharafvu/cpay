-- ============================================================
-- 20261004020000: production drift fixes
-- ============================================================
-- Spec (repo behaviour, production behaviour, intended behaviour, per item):
-- the PR description. Forward-only and idempotent against BOTH starting
-- states: production (no store columns, no get_public_store, usdt_wallets
-- policy with OR is_admin(), narrow profile allowlist, telegram_context
-- present) and the CI build from this repo (0085 store objects present,
-- wider allowlist, no telegram_context).
--
-- No data is updated. No payment, ledger, settlement or withdrawal logic
-- changes.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Storefront: profiles.store_* and get_public_store(uuid)
-- ------------------------------------------------------------
alter table public.profiles add column if not exists store_tagline text;
alter table public.profiles add column if not exists store_bio text;
alter table public.profiles add column if not exists store_avatar_url text;
alter table public.profiles add column if not exists store_theme text not null default 'midnight';
alter table public.profiles add column if not exists store_accent text not null default '#00D632';
alter table public.profiles add column if not exists store_cta text not null default 'Pay now';

alter table public.profiles drop constraint if exists profiles_store_theme_check;
alter table public.profiles add constraint profiles_store_theme_check
  check (store_theme in ('midnight','snow','glass','sunset'));

-- Same return shape as 0085 (store.html depends on it). Public fields only:
-- no email, balance, fee, cost, payout data or payment history. Only
-- active accounts have a store, like get_link_preview().
create or replace function public.get_public_store(p_user_id uuid)
returns table (
  display_name text,
  tagline text,
  bio text,
  avatar_url text,
  theme text,
  accent text,
  cta text,
  links jsonb
)
language sql
security definer
stable
set search_path = public
as $$
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
    and pr.role in ('creator','moderator')
    and pr.account_status = 'active';
$$;
revoke all on function public.get_public_store(uuid) from public;
grant execute on function public.get_public_store(uuid) to anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 2. Payout wallets
-- ------------------------------------------------------------
-- 2a. Own rows only. Admins change payout addresses through the audited
--     admin_set_user_usdt_wallet() and read them through
--     admin_list_user_wallets(); production's OR is_admin() is removed.
drop policy if exists usdt_wallets_own on public.usdt_wallets;
create policy usdt_wallets_own on public.usdt_wallets
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- 2b. Admin payout-address change: unchanged validation, now audited with
--     the old and new address.
create or replace function public.admin_set_user_usdt_wallet(p_user_id uuid, p_network text, p_address text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  a text := trim(p_address);
  v_old text;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'Unknown account';
  end if;
  if p_network is null or p_network not in ('tron','bsc','ethereum','polygon','arbitrum','base','optimism','avalanche','solana') then
    raise exception 'Unknown USDT network';
  end if;
  if not public.usdt_address_ok(p_network, a) then
    raise exception 'That address is not valid for %', p_network;
  end if;
  select address into v_old
    from public.usdt_wallets
   where user_id = p_user_id and network = p_network
   for update;
  insert into public.usdt_wallets (user_id, network, address)
  values (p_user_id, p_network, a)
  on conflict (user_id, network) do update
    set address = excluded.address, updated_at = now();
  perform public.record_audit(
    'payout_wallet.admin_set', 'profile', p_user_id::text,
    jsonb_build_object('network', p_network, 'address', v_old),
    jsonb_build_object('network', p_network, 'address', a)
  );
end;
$$;
revoke all on function public.admin_set_user_usdt_wallet(uuid, text, text) from public, anon;
grant execute on function public.admin_set_user_usdt_wallet(uuid, text, text) to authenticated, service_role;

-- 2c. Production's newer definitions, verbatim (no-op in production).
create or replace function public.my_withdraw_settings()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v_uid uuid := auth.uid(); v_role text; v_fee record; v_rs reseller_settings; v_global numeric; v_p profiles;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  select * into v_p from profiles where id = v_uid;
  v_role := v_p.role;
  select * into v_fee from withdrawal_fee_resolution(v_uid);
  begin
    select round((value->>'percent')::numeric, 2) into v_global from app_settings where key = 'default_withdrawal_fee_percent';
  exception when others then v_global := null;
  end;
  if v_role = 'moderator' then
    select * into v_rs from reseller_settings where reseller_id = v_uid;
  end if;
  return jsonb_build_object(
    'fee_percent', v_fee.fee_percent,
    'fee_source', v_fee.source,
    'self_withdraw_allowed', self_withdraw_allowed(v_uid),
    'has_reseller', v_role = 'creator' and reseller_of(v_uid) is not null,
    'global_fee_percent', coalesce(v_global, 0),
    'team_withdraw_enabled', coalesce((select value from app_settings where key = 'feature_reseller_team_withdraw'), 'true'::jsonb) <> 'false'::jsonb,
    'withdraw_threshold', v_p.withdraw_threshold,
    'preferred_usdt_network', v_p.preferred_usdt_network,
    'auto_withdraw_enabled', coalesce(v_p.auto_withdraw_enabled, false),
    'reseller', case when v_role = 'moderator' then jsonb_build_object(
      'allow_freelancer_self_withdraw', coalesce(v_rs.allow_freelancer_self_withdraw, false),
      'team_withdrawal_fee_percent', v_rs.team_withdrawal_fee_percent) end
  );
end;
$function$;

create or replace function public.delete_my_usdt_wallet(p_network text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  delete from public.usdt_wallets where user_id = v_uid and network = p_network;
  update profiles set preferred_usdt_network = null
   where id = v_uid and preferred_usdt_network = p_network;
end;
$function$;

-- 2d. The caller's own wallet functions: signed-in users only. Each raises
--     'Not authenticated' without auth.uid(), so anon loses nothing usable.
revoke all on function public.my_payout_book() from public, anon;
revoke all on function public.set_my_payout_prefs(numeric, text, boolean) from public, anon;
revoke all on function public.set_my_usdt_wallet(text, text) from public, anon;
revoke all on function public.delete_my_usdt_wallet(text) from public, anon;
revoke all on function public.my_withdraw_settings() from public, anon;
grant execute on function public.my_payout_book() to authenticated, service_role;
grant execute on function public.set_my_payout_prefs(numeric, text, boolean) to authenticated, service_role;
grant execute on function public.set_my_usdt_wallet(text, text) to authenticated, service_role;
grant execute on function public.delete_my_usdt_wallet(text) to authenticated, service_role;
grant execute on function public.my_withdraw_settings() to authenticated, service_role;

-- ------------------------------------------------------------
-- 3 + 4. Profile guard: price lock (D4) and self role/status
-- ------------------------------------------------------------
-- Browser PATCH is already limited to display_name, bio and public_slug by
-- column grants (20261003000000). This trigger is the rule for SECURITY
-- DEFINER paths, which still run with the caller's auth.uid(), and the
-- backstop if a column grant is ever widened.
create or replace function public.guard_profile_updates()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  -- Production's list plus the three price fields, which the rules below
  -- decide. Anything else still needs an admin or a no-session caller.
  user_editable_fields text[] := array[
    'display_name',
    'bio',
    'public_slug',
    'cost_percent',
    'withdraw_threshold',
    'preferred_usdt_network',
    'auto_withdraw_enabled',
    'cost_locked',
    'team_cost_percent'
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

  if old.id = v_uid then
    -- Own row: a lock is set and lifted only by the reseller or an admin.
    if new.cost_locked is distinct from old.cost_locked then
      raise exception 'Only your reseller or an admin can lock or unlock your cost rate';
    end if;
    if coalesce(old.cost_locked, false)
       and new.cost_percent is distinct from old.cost_percent then
      raise exception 'Your reseller locked this payment-link cost rate';
    end if;
    if new.team_cost_percent is distinct from old.team_cost_percent
       and not is_reseller() then
      raise exception 'Only an active reseller can set a team cost rate';
    end if;
  else
    -- Someone else's row: only their own active reseller may price it.
    if new.team_cost_percent is distinct from old.team_cost_percent then
      raise exception 'You may only change user-editable profile fields';
    end if;
    if (new.cost_percent is distinct from old.cost_percent
        or new.cost_locked is distinct from old.cost_locked)
       and not (is_reseller() and reseller_owns(old.id)) then
      raise exception 'Only the account''s reseller or an admin can set its cost rate';
    end if;
  end if;

  return new;
end;
$$;
revoke all on function public.guard_profile_updates() from anon, authenticated;

-- Link-level cost overrides the profile rate (coalesce(link, profile)), so
-- a locked owner must not set it directly through REST either.
--
-- One update is always allowed, whoever makes it: clearing a link's
-- cost_percent to NULL, with nothing else changed, on a link whose owner is
-- locked. It can only move the price to the locked profile rate. This is
-- what clear_link_costs_on_lock() does from inside a reseller's or admin's
-- lock; RLS still limits direct REST to the caller's own links.
create or replace function public.guard_link_updates()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_locked boolean;
begin
  if auth.uid() is null or is_admin() then
    return new;
  end if;

  if public.link_update_is_lock_clear(old, new, tg_op) then
    return new;
  end if;

  if new.user_id is distinct from auth.uid() then
    raise exception 'Cannot create or move a link for another user';
  end if;

  if (tg_op = 'INSERT' and new.cost_percent is not null)
     or (tg_op = 'UPDATE' and new.cost_percent is distinct from old.cost_percent) then
    select cost_locked into v_locked from profiles where id = new.user_id;
    if coalesce(v_locked, false) then
      raise exception 'Your reseller locked this payment-link cost rate';
    end if;
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
$$;
revoke all on function public.guard_link_updates() from anon, authenticated;

-- ------------------------------------------------------------
-- 3b. Applying a lock clears that freelancer's link-level overrides
-- ------------------------------------------------------------
-- Whenever an UPDATE sets profiles.cost_locked = true (the column is in the
-- SET list and the new value is true: reseller_set_freelancer_cost(),
-- reseller_lock_team_cost(), the admin path through the same functions, or
-- any future lock path), the same statement clears cost_percent on every
-- non-deleted link of that freelancer, active or paused (a paused link
-- can be switched back on). The effective rate is then the profile rate.
-- The old values go to audit_log. Unlocking restores nothing.
-- Runs in the lock's own statement and transaction: if the lock fails or
-- rolls back, the links are untouched. Nothing runs at migration time.
create or replace function public.link_update_is_lock_clear(p_old public.payment_links, p_new public.payment_links, p_op text)
returns boolean
language sql
stable
set search_path = public
as $$
  select p_op = 'UPDATE'
     and p_new.cost_percent is null
     and p_old.cost_percent is not null
     and (to_jsonb(p_new) - 'cost_percent') = (to_jsonb(p_old) - 'cost_percent')
     and coalesce((select cost_locked from profiles where id = p_new.user_id), false);
$$;
revoke all on function public.link_update_is_lock_clear(public.payment_links, public.payment_links, text) from public, anon, authenticated;

-- The account-status guard would refuse the clear for a suspended or
-- pending team member and so block the whole lock; the clear is exempt.
create or replace function public.guard_payment_link_account_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.link_update_is_lock_clear(old, new, tg_op) then
    return new;
  end if;
  if not is_admin() and not account_is_active(new.user_id) then
    raise exception 'Account approval is required before creating payment links';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_payment_link_account_status() from anon, authenticated;

create or replace function public.clear_link_costs_on_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
begin
  select jsonb_agg(jsonb_build_object('link_id', l.id, 'slug', l.slug, 'cost_percent', l.cost_percent) order by l.slug)
    into v_old
    from payment_links l
   where l.user_id = new.id
     and l.deleted_at is null
     and l.cost_percent is not null;
  if v_old is null then
    return null;
  end if;
  update payment_links
     set cost_percent = null
   where user_id = new.id
     and deleted_at is null
     and cost_percent is not null;
  perform public.record_audit(
    'link.cost_cleared_by_lock', 'profile', new.id::text,
    jsonb_build_object('links', v_old),
    jsonb_build_object('profile_cost_percent', new.cost_percent, 'link_cost_percent', null)
  );
  return null;
end;
$$;
revoke all on function public.clear_link_costs_on_lock() from public, anon, authenticated;

drop trigger if exists trg_clear_link_costs_on_lock on public.profiles;
create trigger trg_clear_link_costs_on_lock
  after update of cost_locked on public.profiles
  for each row
  when (new.cost_locked)
  execute function public.clear_link_costs_on_lock();

-- ------------------------------------------------------------
-- 5. get_my_analytics(): signed-in callers only, as in the repo
-- ------------------------------------------------------------
revoke all on function public.get_my_analytics() from public, anon;
grant execute on function public.get_my_analytics() to authenticated, service_role;

-- ------------------------------------------------------------
-- 6. telegram_context(): production-only until now. Still called by the
--    deployed telegram-report Edge Function (service role), so it is
--    adopted verbatim, service-role only, rather than dropped.
-- ------------------------------------------------------------
create or replace function public.telegram_context(p_range text default 'today'::text, p_days integer default 7)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_range text := lower(trim(coalesce(p_range, 'today')));
  v_days int := least(greatest(coalesce(p_days, 7), 1), 30);
  v_cycle_date date := ((now() at time zone 'Asia/Dhaka') - interval '17 hours')::date;
  v_start timestamptz;
  v_end timestamptz;
  v_margin numeric;
  v_total_settled numeric := 0;
  v_admin_profit numeric := 0;
  v_total_withdrawn numeric := 0;
  v_pending_count bigint := 0;
  v_pending_amount numeric := 0;
  v_payment_count bigint := 0;
  v_active_creators bigint := 0;
  v_creators jsonb := '[]'::jsonb;
  v_locations jsonb := '[]'::jsonb;
  v_payments jsonb := '[]'::jsonb;
  v_withdrawals jsonb := '[]'::jsonb;
  v_daily jsonb := '[]'::jsonb;
begin
  if v_range not in ('today', '7d', '30d', 'all') then
    raise exception 'Invalid report range';
  end if;

  if v_range = 'today' then v_days := 1;
  elsif v_range = '7d' then v_days := 7;
  elsif v_range = '30d' then v_days := 30;
  end if;

  if v_range = 'all' then
    v_start := null;
    v_end := null;
  else
    v_start := ((v_cycle_date - (v_days - 1))::text || ' 17:00')::timestamp at time zone 'Asia/Dhaka';
    v_end := (v_cycle_date::text || ' 17:00')::timestamp at time zone 'Asia/Dhaka' + interval '24 hours';
  end if;

  select coalesce((value->>'percent')::numeric, 7.7)
    into v_margin
  from app_settings where key = 'profit_margin_percent';

  select
    coalesce(sum(p.amount_settled) filter (where p.status = 'settled'), 0),
    count(*) filter (where p.status = 'settled'),
    count(distinct p.user_id) filter (where p.status = 'settled')
  into v_total_settled, v_payment_count, v_active_creators
  from payments p
  where (v_start is null or p.settled_at >= v_start)
    and (v_end is null or p.settled_at < v_end);

  select
    coalesce(sum(w.amount_requested - w.amount_after_fee) filter (where w.status = 'paid'), 0),
    coalesce(sum(w.amount_after_fee) filter (where w.status = 'paid'), 0),
    count(*) filter (where w.status in ('pending', 'approved')),
    coalesce(sum(w.amount_requested) filter (where w.status in ('pending', 'approved')), 0)
  into v_admin_profit, v_total_withdrawn, v_pending_count, v_pending_amount
  from withdrawals w
  where (v_start is null or w.processed_at >= v_start or w.status in ('pending', 'approved'))
    and (v_end is null or w.processed_at < v_end or w.status in ('pending', 'approved'));

  select coalesce(jsonb_agg(x.row order by x.settled desc), '[]'::jsonb)
    into v_creators
  from (
    select jsonb_build_object(
      'name', coalesce(nullif(trim(pr.display_name), ''), 'Unnamed creator'),
      'role', pr.role,
      'settled', coalesce(pay.settled, 0),
      'withdrawn', coalesce(wd.withdrawn, 0),
      'pendingWithdrawals', coalesce(wd.pending_amount, 0),
      'paymentCount', coalesce(pay.payment_count, 0),
      'pendingPayments', coalesce(pay.pending_amount, 0)
    ) as row,
    coalesce(pay.settled, 0) as settled
    from profiles pr
    left join lateral (
      select
        coalesce(sum(p.amount_settled) filter (where p.status = 'settled' and (v_start is null or p.settled_at >= v_start) and (v_end is null or p.settled_at < v_end)), 0) as settled,
        count(*) filter (where p.status = 'settled' and (v_start is null or p.settled_at >= v_start) and (v_end is null or p.settled_at < v_end)) as payment_count,
        coalesce(sum(p.amount_requested) filter (where p.status in ('new', 'pending') and (v_start is null or p.created_at >= v_start) and (v_end is null or p.created_at < v_end)), 0) as pending_amount
      from payments p
      where p.user_id = pr.id
    ) pay on true
    left join lateral (
      select
        coalesce(sum(w.amount_after_fee) filter (where w.status = 'paid' and (v_start is null or w.processed_at >= v_start) and (v_end is null or w.processed_at < v_end)), 0) as withdrawn,
        coalesce(sum(w.amount_requested) filter (where w.status in ('pending', 'approved')), 0) as pending_amount
      from withdrawals w
      where w.user_id = pr.id
    ) wd on true
    where pr.role in ('creator', 'moderator')
      and (coalesce(pay.settled, 0) > 0 or coalesce(wd.withdrawn, 0) > 0 or coalesce(wd.pending_amount, 0) > 0)
  ) x;

  select coalesce(jsonb_agg(x.row order by x.payment_count desc), '[]'::jsonb)
    into v_locations
  from (
    select jsonb_build_object(
      'country', coalesce(nullif(trim(p.customer_country), ''), 'Unknown'),
      'city', coalesce(nullif(trim(p.customer_city), ''), 'Unknown'),
      'paymentCount', count(*),
      'settled', coalesce(sum(p.amount_settled), 0)
    ) as row, count(*) as payment_count
    from payments p
    where p.status = 'settled'
      and (v_start is null or p.settled_at >= v_start)
      and (v_end is null or p.settled_at < v_end)
      and nullif(trim(coalesce(p.customer_country, '')), '') is not null
    group by p.customer_country, p.customer_city
    having count(*) >= 2
    order by count(*) desc
    limit 20
  ) x;

  select coalesce(jsonb_agg(row order by settled_at desc), '[]'::jsonb)
    into v_payments
  from (
    select jsonb_build_object(
      'creator', coalesce(nullif(trim(pr.display_name), ''), 'Unnamed creator'),
      'amount', p.amount_settled,
      'status', p.status,
      'method', p.method,
      'settledAt', p.settled_at,
      'country', p.customer_country,
      'city', p.customer_city
    ) as row, p.settled_at
    from payments p
    join profiles pr on pr.id = p.user_id
    where (v_start is null or p.settled_at >= v_start or p.created_at >= v_start)
      and (v_end is null or p.settled_at < v_end or p.created_at < v_end)
    order by p.settled_at desc nulls last
    limit 25
  ) x;

  select coalesce(jsonb_agg(row order by requested_at desc), '[]'::jsonb)
    into v_withdrawals
  from (
    select jsonb_build_object(
      'creator', coalesce(nullif(trim(pr.display_name), ''), 'Unnamed creator'),
      'amountRequested', w.amount_requested,
      'amountAfterFee', w.amount_after_fee,
      'status', w.status,
      'method', w.method,
      'requestedAt', w.requested_at,
      'processedAt', w.processed_at
    ) as row, w.requested_at
    from withdrawals w
    join profiles pr on pr.id = w.user_id
    where (v_start is null or w.processed_at >= v_start or w.status in ('pending', 'approved'))
      and (v_end is null or w.processed_at < v_end or w.status in ('pending', 'approved'))
    order by w.requested_at desc
    limit 25
  ) x;

  if v_range <> 'all' then
    select coalesce(jsonb_agg(row order by cycle_date desc), '[]'::jsonb)
      into v_daily
    from (
      select jsonb_build_object(
        'cycleDate', d.cycle_date,
        'cycleStart', d.cycle_start,
        'cycleEnd', d.cycle_end,
        'settled', coalesce((select sum(p.amount_settled) from payments p where p.status = 'settled' and p.settled_at >= d.cycle_start and p.settled_at < d.cycle_end), 0),
        'paymentCount', coalesce((select count(*) from payments p where p.status = 'settled' and p.settled_at >= d.cycle_start and p.settled_at < d.cycle_end), 0),
        'adminProfit', coalesce((select round(sum(w.amount_requested - w.amount_after_fee), 4) from withdrawals w where w.status = 'paid' and w.processed_at >= d.cycle_start and w.processed_at < d.cycle_end), 0)
      ) as row, d.cycle_date
      from (
        select gs::date as cycle_date,
          (gs::date::text || ' 17:00')::timestamp at time zone 'Asia/Dhaka' as cycle_start,
          (gs::date::text || ' 17:00')::timestamp at time zone 'Asia/Dhaka' + interval '24 hours' as cycle_end
        from generate_series(v_cycle_date - (v_days - 1), v_cycle_date, interval '1 day') gs
      ) d
    ) x;
  end if;

  return jsonb_build_object(
    'generatedAt', now(),
    'range', v_range,
    'timezone', 'Asia/Dhaka',
    'cycleBoundary', '17:00–17:00 Asia/Dhaka',
    'global', jsonb_build_object(
      'totalSettled', v_total_settled,
      'adminProfit', round(v_admin_profit, 4),
      'totalWithdrawn', v_total_withdrawn,
      'pendingWithdrawalsCount', v_pending_count,
      'pendingWithdrawalsAmount', v_pending_amount,
      'paymentCount', v_payment_count,
      'activeCreators', v_active_creators,
      'calculatedNodeBalance', round(v_total_settled * (1 + v_margin / 100.0), 4),
      'profitMarginPercent', v_margin
    ),
    'daily', v_daily,
    'creators', v_creators,
    'locations', v_locations,
    'recentPayments', v_payments,
    'recentWithdrawals', v_withdrawals,
    'privacy', jsonb_build_object(
      'customerLocations', 'Only grouped locations with at least two settled payments are included',
      'withdrawalDestinations', 'Never included',
      'privateSocialData', 'Never collected'
    )
  );
end;
$function$;
revoke all on function public.telegram_context(text, integer) from public, anon, authenticated;
grant execute on function public.telegram_context(text, integer) to service_role;
