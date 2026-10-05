-- ============================================================
-- 20261005010000: remove reseller commission (keep the platform fee)
-- ============================================================
-- Owner decision (2026-10-05): reseller commission is removed completely
-- from the active schema. This supersedes 0092 "Model G" and the later
-- migrations that carried commission (0096, 0102, 20261004010000). Those
-- files stay as history; this one is forward-only.
--
-- Money model after this migration:
--
--   gross settled payment
--     -> CPAY platform fee   (payments.platform_fee_amount, stamped on settle)
--     -> net payable         (settled - platform fee)
--
--   available = sum(settled - platform fee)            own settled payments
--                                                       at or above the hide threshold
--             - sum(withdrawals not rejected / failed)
--
-- For an account that never had commission (every account in production:
-- 0 payments with a reseller or a non-zero commission on 2026-10-05) every
-- balance and dashboard number is unchanged. ci/commission_removal_*.sql
-- proves it by snapshotting balances before this file and comparing after.
--
-- PRECONDITION: this migration ABORTS, changing nothing, if any commission
-- was ever stamped or configured per account:
--   * a payment with reseller_id set, or a non-zero commission percent or
--     amount;
--   * a profile with a commission override.
-- There is no silent deletion or conversion. If it aborts, the owner
-- decides what happens to that money first (reverse to the freelancer,
-- pay out, or archive) in a separate, reviewed migration.
--
-- Safe to re-run: the precondition only reads columns that still exist,
-- functions are dropped "if exists" and recreated, and the column drops
-- are "if exists".
--
-- Functions dropped (commission only, no other purpose):
--   admin_set_default_reseller_commission, admin_set_reseller_commission,
--   cpay_reseller_commission_percent, cpay_reseller_for (already unused),
--   my_affiliate_commission_rows, my_commission_totals
-- Functions rewritten without the commission term:
--   stamp_payment_platform_fee (trigger), get_balance_for,
--   dashboard_settled_payments, dashboard_user_days, dashboard_link_days,
--   my_daily_summary, admin_daily_summary, admin_daily_timeseries,
--   daily_link_breakdown, reseller_team_daily_summary, my_earnings_split
-- Schema dropped:
--   payments.reseller_id, payments.reseller_commission_percent,
--   payments.reseller_commission_amount, idx_payments_reseller,
--   profiles.reseller_commission_percent, profiles_reseller_commission_range,
--   app_settings 'default_reseller_commission_percent'
--
-- The reseller role itself (teams, notices, link-cost lock, team fee) is
-- removed by the next migration, in its own PR.
-- ============================================================

-- ---------- 0. Precondition: nothing to lose ----------
do $$
declare
  v_pay bigint := 0;
  v_prof bigint := 0;
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'payments'
               and column_name = 'reseller_commission_amount') then
    execute $q$
      select count(*) from public.payments
       where reseller_id is not null
          or coalesce(reseller_commission_percent, 0) <> 0
          or coalesce(reseller_commission_amount, 0) <> 0
    $q$ into v_pay;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'profiles'
               and column_name = 'reseller_commission_percent') then
    execute $q$
      select count(*) from public.profiles where reseller_commission_percent is not null
    $q$ into v_prof;
  end if;
  if v_pay > 0 or v_prof > 0 then
    raise exception 'ABORT 20261005010000: reseller commission data exists (% payment(s) with a reseller or non-zero commission, % profile override(s)). Nothing was changed. Decide what happens to that money in a reviewed migration first.', v_pay, v_prof;
  end if;
end $$;

-- ---------- 1. Settle stamp: platform fee only ----------
create or replace function public.stamp_payment_platform_fee()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pct numeric;
begin
  if new.status = 'settled' and (old.status is distinct from 'settled') then
    v_pct := cpay_platform_fee_percent(new.user_id);
    new.platform_fee_percent := v_pct;
    new.platform_fee_amount := round(coalesce(new.amount_settled, new.amount_requested, 0) * v_pct / 100.0, 2);
  end if;
  return new;
end;
$$;
-- A trigger function is never called directly; nobody needs EXECUTE.
revoke all on function public.stamp_payment_platform_fee() from public, anon, authenticated;

-- ---------- 2. The balance: settled minus platform fee, minus withdrawals ----------
create or replace function public.get_balance_for(p_user_id uuid)
returns table (earned numeric, queued numeric, withdrawn numeric, available numeric)
language sql
security definer
stable
set search_path = public
as $$
  select
    e.earned,
    q.queued,
    w.withdrawn,
    round(e.earned - q.queued, 8) as available
  from
    (select coalesce((
        select sum(amount_settled - coalesce(platform_fee_amount, 0))
        from payments
        where user_id = p_user_id
          and status = 'settled'
          and amount_settled >= hide_threshold_for(p_user_id)
      ), 0) as earned) e,
    (select coalesce(sum(amount_requested), 0) as queued
     from withdrawals
     where user_id = p_user_id
       and status not in ('rejected', 'failed')) q,
    (select coalesce(sum(amount_after_fee), 0) as withdrawn
     from withdrawals
     where user_id = p_user_id
       and status = 'paid') w;
$$;
revoke all on function public.get_balance_for(uuid) from public, anon, authenticated;
grant execute on function public.get_balance_for(uuid) to service_role;

-- ---------- 3. Commission-only functions ----------
drop function if exists public.admin_set_default_reseller_commission(numeric);
drop function if exists public.admin_set_reseller_commission(uuid, numeric);
drop function if exists public.my_affiliate_commission_rows();
drop function if exists public.my_commission_totals();
drop function if exists public.cpay_reseller_commission_percent(uuid);
drop function if exists public.cpay_reseller_for(uuid);

-- ---------- 4. Dashboards: the OUT columns change, so drop and recreate ----------
-- Readers first, then the source. enqueue_daily_close() reads
-- dashboard_settled_payments() but only columns that stay; it is unchanged.
drop function if exists public.my_daily_summary(integer);
drop function if exists public.admin_daily_summary(integer, uuid, uuid);
drop function if exists public.reseller_team_daily_summary(integer);
drop function if exists public.daily_link_breakdown(integer, uuid);
drop function if exists public.admin_daily_timeseries(integer, uuid, uuid);
drop function if exists public.my_earnings_split();
drop function if exists public.dashboard_user_days(uuid[], date, date, boolean);
drop function if exists public.dashboard_link_days(uuid[], date, date, boolean);
drop function if exists public.dashboard_settled_payments(uuid[], date, date, boolean);

-- One row per settled payment the dashboards count.
create function public.dashboard_settled_payments(p_user_ids uuid[], p_from date, p_to date, p_apply_hide boolean)
returns table (payment_id uuid, user_id uuid, business_day date, payment_link_id uuid,
               amount_settled numeric, platform_fee numeric, cost_rate numeric)
language sql
stable
security definer
set search_path = public
as $$
  with owners as (
    select pr.id,
           case when p_apply_hide then hide_threshold_for(pr.id) else -1 end as hide_at
    from profiles pr
    where p_user_ids is null or pr.id = any (p_user_ids)
  )
  select
    p.id,
    p.user_id,
    business_day(p.settled_at),
    p.payment_link_id,
    coalesce(p.amount_settled, 0),
    coalesce(p.platform_fee_amount, 0),
    case when p.payment_link_id is null then null
         else coalesce(p.cost_percent, pl.cost_percent, pr.cost_percent, 0) end
  from payments p
  join owners o on o.id = p.user_id
  join profiles pr on pr.id = p.user_id
  left join payment_links pl on pl.id = p.payment_link_id
  where p.status = 'settled'
    and p.settled_at >= business_day_start(p_from)
    and p.settled_at <  business_day_end(p_to)
    and not (p.amount_settled < o.hide_at);
$$;

create function public.dashboard_user_days(p_user_ids uuid[], p_from date, p_to date, p_apply_hide boolean)
returns table (user_id uuid, business_day date, day_start timestamptz, day_end timestamptz,
               link_count integer, paid_link_count integer, cost_rates numeric[],
               payment_count bigint, settled numeric, platform_fee numeric, earnings numeric)
language sql
stable
security definer
set search_path = public
as $$
  with pay as (
    select * from dashboard_settled_payments(p_user_ids, p_from, p_to, p_apply_hide)
  ),
  pay_day as (
    select p.user_id, p.business_day,
           count(distinct p.payment_link_id)::int as paid_links,
           array_agg(distinct p.cost_rate order by p.cost_rate)
             filter (where p.cost_rate is not null) as rates,
           count(*) as n,
           sum(p.amount_settled) as settled,
           sum(p.platform_fee) as fee
    from pay p
    group by p.user_id, p.business_day
  ),
  link_day as (
    select l.user_id, l.business_day, count(*)::int as n
    from dashboard_links_on_day(p_user_ids, p_from, p_to) l
    group by l.user_id, l.business_day
  )
  select
    u.id,
    d.gs::date,
    business_day_start(d.gs::date),
    business_day_end(d.gs::date),
    coalesce(ld.n, 0),
    coalesce(pd.paid_links, 0),
    coalesce(pd.rates, '{}'::numeric[]),
    coalesce(pd.n, 0),
    coalesce(pd.settled, 0),
    coalesce(pd.fee, 0),
    coalesce(pd.settled, 0) - coalesce(pd.fee, 0)
  from unnest(p_user_ids) as u(id)
  cross join generate_series(p_from, p_to, interval '1 day') as d(gs)
  left join pay_day pd on pd.user_id = u.id and pd.business_day = d.gs::date
  left join link_day ld on ld.user_id = u.id and ld.business_day = d.gs::date;
$$;

create function public.dashboard_link_days(p_user_ids uuid[], p_from date, p_to date, p_apply_hide boolean)
returns table (user_id uuid, business_day date, day_start timestamptz, day_end timestamptz,
               link_id uuid, slug text, link_name text, is_active boolean, deleted_at timestamptz,
               cost_percent_now numeric, cost_percent_used_min numeric, cost_percent_used_max numeric,
               payment_count bigint, settled numeric, platform_fee numeric, earnings numeric)
language sql
stable
security definer
set search_path = public
as $$
  with pay as (
    select * from dashboard_settled_payments(p_user_ids, p_from, p_to, p_apply_hide)
  ),
  agg as (
    select p.user_id, p.business_day, p.payment_link_id as link_id,
           min(p.cost_rate) as rate_min, max(p.cost_rate) as rate_max,
           count(*) as n, sum(p.amount_settled) as settled,
           sum(p.platform_fee) as fee
    from pay p
    group by p.user_id, p.business_day, p.payment_link_id
  ),
  keys as (
    select l.user_id, l.business_day, l.link_id
    from dashboard_links_on_day(p_user_ids, p_from, p_to) l
    union
    select a.user_id, a.business_day, a.link_id from agg a
  )
  select
    k.user_id,
    k.business_day,
    business_day_start(k.business_day),
    business_day_end(k.business_day),
    k.link_id,
    pl.slug,
    pl.display_name,
    pl.is_active,
    pl.deleted_at,
    case when pl.id is null then null else coalesce(pl.cost_percent, pr.cost_percent, 0) end,
    a.rate_min,
    a.rate_max,
    coalesce(a.n, 0),
    coalesce(a.settled, 0),
    coalesce(a.fee, 0),
    coalesce(a.settled, 0) - coalesce(a.fee, 0)
  from keys k
  join profiles pr on pr.id = k.user_id
  left join payment_links pl on pl.id = k.link_id
  left join agg a
    on a.user_id = k.user_id
   and a.business_day = k.business_day
   and a.link_id is not distinct from k.link_id;
$$;

create function public.my_daily_summary(p_days integer default 14)
returns table (business_day date, day_start timestamptz, day_end timestamptz,
               link_count integer, paid_link_count integer, cost_rates numeric[],
               payment_count bigint, settled numeric, platform_fee numeric, earnings numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_to date := current_business_day();
  v_from date := current_business_day() - (least(greatest(coalesce(p_days, 14), 1), 60) - 1);
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  return query
  select
    d.business_day, d.day_start, d.day_end,
    d.link_count, d.paid_link_count, d.cost_rates,
    d.payment_count, d.settled, d.platform_fee, d.earnings
  from dashboard_user_days(array[v_uid], v_from, v_to, true) d
  order by d.business_day desc;
end;
$$;

create function public.admin_daily_summary(p_days integer default 14, p_user_id uuid default null, p_reseller_id uuid default null)
returns table (user_id uuid, email text, display_name text, role text, account_status text,
               created_at timestamptz, reseller_id uuid, reseller_email text, reseller_name text,
               max_payment_links integer, business_day date, day_start timestamptz, day_end timestamptz,
               link_count integer, paid_link_count integer, cost_rates numeric[],
               payment_count bigint, settled numeric, platform_fee numeric, earnings numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_to date := current_business_day();
  v_from date := current_business_day() - (least(greatest(coalesce(p_days, 14), 1), 60) - 1);
  v_ids uuid[];
begin
  if not is_admin() then raise exception 'Not authorized'; end if;

  select array_agg(pr.id) into v_ids
  from profiles pr
  where pr.role in ('creator', 'moderator')
    and (p_user_id is null or pr.id = p_user_id)
    and (p_reseller_id is null
         or pr.id = p_reseller_id
         or pr.id in (select t.user_id from reseller_team_ids(p_reseller_id) t));

  if v_ids is null then return; end if;

  return query
  with owner_reseller as (
    select pr.id,
           coalesce(pr.referred_by,
                    (select ma.moderator_id from moderator_assignments ma
                     where ma.creator_id = pr.id
                     order by ma.assigned_at limit 1)) as reseller_id
    from profiles pr
    where pr.id = any (v_ids)
  )
  select
    pr.id, pr.email, pr.display_name, pr.role, pr.account_status, pr.created_at,
    rs.id, rs.email, rs.display_name,
    least(coalesce(pr.max_payment_links, max_links_per_owner()), max_links_per_owner()),
    d.business_day, d.day_start, d.day_end,
    d.link_count, d.paid_link_count, d.cost_rates,
    d.payment_count, d.settled, d.platform_fee, d.earnings
  from dashboard_user_days(v_ids, v_from, v_to, false) d
  join profiles pr on pr.id = d.user_id
  join owner_reseller o on o.id = d.user_id
  left join profiles rs on rs.id = o.reseller_id
  where p_user_id is not null or d.link_count > 0 or d.payment_count > 0
  order by d.business_day desc, d.settled desc, pr.email;
end;
$$;

create function public.admin_daily_timeseries(p_days integer default 30, p_user_id uuid default null, p_reseller_id uuid default null)
returns table (business_day date, day_start timestamptz, day_end timestamptz,
               payment_count bigint, settled numeric, platform_fee numeric, earnings numeric,
               active_earners integer, withdrawal_fee_revenue numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_days int := least(greatest(coalesce(p_days, 30), 1), 366);
  v_to date := current_business_day();
  v_from date := current_business_day() - (least(greatest(coalesce(p_days, 30), 1), 366) - 1);
  v_ids uuid[];
begin
  if not is_admin() then raise exception 'Not authorized'; end if;

  if p_user_id is not null or p_reseller_id is not null then
    select coalesce(array_agg(pr.id), '{}'::uuid[]) into v_ids
    from profiles pr
    where (p_user_id is null or pr.id = p_user_id)
      and (p_reseller_id is null
           or pr.id = p_reseller_id
           or pr.id in (select t.user_id from reseller_team_ids(p_reseller_id) t));
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
$$;

create function public.daily_link_breakdown(p_days integer default 14, p_user_id uuid default null)
returns table (user_id uuid, email text, display_name text, business_day date,
               day_start timestamptz, day_end timestamptz, link_id uuid, slug text, link_name text,
               is_active boolean, deleted_at timestamptz, cost_percent_now numeric,
               cost_percent_used_min numeric, cost_percent_used_max numeric,
               payment_count bigint, settled numeric, platform_fee numeric, earnings numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_target uuid := coalesce(p_user_id, auth.uid());
  v_admin boolean := is_admin();
  v_to date := current_business_day();
  v_from date := current_business_day() - (least(greatest(coalesce(p_days, 14), 1), 60) - 1);
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if v_target <> v_uid and not v_admin and not (is_reseller() and reseller_owns(v_target)) then
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
$$;

create function public.reseller_team_daily_summary(p_days integer default 14)
returns table (user_id uuid, email text, display_name text, role text, account_status text,
               affiliate boolean, is_self boolean, business_day date, day_start timestamptz,
               day_end timestamptz, link_count integer, paid_link_count integer, cost_rates numeric[],
               payment_count bigint, settled numeric, platform_fee numeric, earnings numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_to date := current_business_day();
  v_from date := current_business_day() - (least(greatest(coalesce(p_days, 14), 1), 60) - 1);
  v_ids uuid[];
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not (is_reseller() or is_admin()) then raise exception 'Not authorized'; end if;

  select array_agg(t.user_id) || v_uid into v_ids from reseller_team_ids(v_uid) t;
  v_ids := coalesce(v_ids, array[v_uid]);

  return query
  select
    pr.id, pr.email, pr.display_name, pr.role, pr.account_status,
    coalesce(pr.referred_by = v_uid, false), (pr.id = v_uid),
    d.business_day, d.day_start, d.day_end,
    d.link_count, d.paid_link_count, d.cost_rates,
    d.payment_count, d.settled, d.platform_fee, d.earnings
  from dashboard_user_days(v_ids, v_from, v_to, true) d
  join profiles pr on pr.id = d.user_id
  order by d.business_day desc, (pr.id = v_uid) desc, d.settled desc, pr.email;
end;
$$;

-- Own totals: settled, platform fee, net (= available), and link cost.
create function public.my_earnings_split()
returns table (settled numeric, platform_fee numeric, net numeric, cost_percent numeric, cost_locked boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  return query
  select
    coalesce((select sum(p.amount_settled) from payments p where p.user_id = v_uid and p.status = 'settled' and p.amount_settled >= hide_threshold_for(p.user_id)), 0),
    coalesce((select sum(p.platform_fee_amount) from payments p where p.user_id = v_uid and p.status = 'settled' and p.amount_settled >= hide_threshold_for(p.user_id)), 0),
    (select b.available from get_balance_for(v_uid) b),
    pr.cost_percent,
    pr.cost_locked
  from profiles pr
  where pr.id = v_uid;
end;
$$;

-- Internal sources: service role only. Page RPCs: signed-in users (each
-- checks its own caller).
revoke all on function public.dashboard_settled_payments(uuid[], date, date, boolean) from public, anon, authenticated;
revoke all on function public.dashboard_user_days(uuid[], date, date, boolean) from public, anon, authenticated;
revoke all on function public.dashboard_link_days(uuid[], date, date, boolean) from public, anon, authenticated;
grant execute on function public.dashboard_settled_payments(uuid[], date, date, boolean) to service_role;
grant execute on function public.dashboard_user_days(uuid[], date, date, boolean) to service_role;
grant execute on function public.dashboard_link_days(uuid[], date, date, boolean) to service_role;

revoke all on function public.my_daily_summary(integer) from public, anon;
revoke all on function public.admin_daily_summary(integer, uuid, uuid) from public, anon;
revoke all on function public.admin_daily_timeseries(integer, uuid, uuid) from public, anon;
revoke all on function public.daily_link_breakdown(integer, uuid) from public, anon;
revoke all on function public.reseller_team_daily_summary(integer) from public, anon;
revoke all on function public.my_earnings_split() from public, anon;
grant execute on function public.my_daily_summary(integer) to authenticated, service_role;
grant execute on function public.admin_daily_summary(integer, uuid, uuid) to authenticated, service_role;
grant execute on function public.admin_daily_timeseries(integer, uuid, uuid) to authenticated, service_role;
grant execute on function public.daily_link_breakdown(integer, uuid) to authenticated, service_role;
grant execute on function public.reseller_team_daily_summary(integer) to authenticated, service_role;
grant execute on function public.my_earnings_split() to authenticated, service_role;

-- ---------- 5. Schema ----------
drop index if exists public.idx_payments_reseller;
alter table public.payments drop column if exists reseller_commission_amount;
alter table public.payments drop column if exists reseller_commission_percent;
alter table public.payments drop column if exists reseller_id;
alter table public.profiles drop constraint if exists profiles_reseller_commission_range;
alter table public.profiles drop column if exists reseller_commission_percent;
delete from public.app_settings where key = 'default_reseller_commission_percent';

-- ---------- 6. Nothing still reads commission ----------
do $$
declare v_left text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into v_left
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.prosrc ~* 'reseller_commission|commission_percent|commission_amount';
  if v_left is not null then
    raise exception '20261005010000: functions still read commission: %', v_left;
  end if;
end $$;
