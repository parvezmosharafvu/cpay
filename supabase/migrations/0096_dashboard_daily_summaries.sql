-- ============================================================
-- 0096: dashboard daily summaries on one business day
-- ============================================================
-- Parvez's rule: the accounting day closes at 17:00 Asia/Dhaka. Six
-- functions already followed it, each with its own copy of the
-- arithmetic. This migration puts the rule in business_day() and
-- friends, moves every day-bucketing function onto it, and adds the
-- per-freelancer / per-link daily RPCs the three dashboards read.
--
-- Also here, because the dashboards depend on them:
--   * payments.cost_percent: the cost rate charged, stamped on insert.
--     Before this nothing recorded it, so a day's report could only
--     show the link's rate as of today.
--   * a hard ceiling of 10 active links per non-admin owner.
--   * my_earnings_split() no longer fails with "cost_percent is
--     ambiguous".
--   * reseller_cycle_digest() and daily_totals_for_cycle() stop
--     answering arbitrary signed-in users.
--
-- Safe to re-run: create or replace, if [not] exists, and data
-- updates that are no-ops the second time.
-- ============================================================


-- ------------------------------------------------------------
-- 1. The business day
-- ------------------------------------------------------------
-- A business day is named after the Dhaka date on which it STARTS:
-- day D runs [D 17:00 Dhaka, D+1 17:00 Dhaka).

create or replace function business_day(p_ts timestamptz)
returns date
language sql
immutable
parallel safe
set search_path = public
as $$
  select ((p_ts at time zone 'Asia/Dhaka') - interval '17 hours')::date;
$$;

create or replace function business_day_start(p_day date)
returns timestamptz
language sql
immutable
parallel safe
set search_path = public
as $$
  select (p_day + time '17:00') at time zone 'Asia/Dhaka';
$$;

create or replace function business_day_end(p_day date)
returns timestamptz
language sql
immutable
parallel safe
set search_path = public
as $$
  select business_day_start(p_day + 1);
$$;

create or replace function current_business_day()
returns date
language sql
stable
set search_path = public
as $$
  select business_day(now());
$$;

-- The last p_days business days, newest first, with their bounds.
create or replace function business_days(p_days int)
returns table (business_day date, day_start timestamptz, day_end timestamptz)
language sql
stable
set search_path = public
as $$
  select gs::date, business_day_start(gs::date), business_day_end(gs::date)
  from generate_series(
         current_business_day() - (greatest(coalesce(p_days, 1), 1) - 1),
         current_business_day(),
         interval '1 day') as gs
  order by 1 desc;
$$;

revoke all on function business_day(timestamptz) from public, anon;
revoke all on function business_day_start(date) from public, anon;
revoke all on function business_day_end(date) from public, anon;
revoke all on function current_business_day() from public, anon;
revoke all on function business_days(int) from public, anon;
grant execute on function business_day(timestamptz) to authenticated, service_role;
grant execute on function business_day_start(date) to authenticated, service_role;
grant execute on function business_day_end(date) to authenticated, service_role;
grant execute on function current_business_day() to authenticated, service_role;
grant execute on function business_days(int) to authenticated, service_role;


-- ------------------------------------------------------------
-- 2. Cost rate snapshot on payments
-- ------------------------------------------------------------
-- create-invoice charges buyer_amount * (1 + cost/100) using the rate
-- system_link_for_invoice() returns. The same lookup here, at insert,
-- records that rate on the row. Rows from before 0096 stay null and the
-- reports fall back to the link's current rate for them.

alter table payments add column if not exists cost_percent numeric(7,3);
alter table payments drop constraint if exists payments_cost_percent_range;
alter table payments add constraint payments_cost_percent_range
  check (cost_percent is null or (cost_percent >= 0 and cost_percent <= 1000));

create or replace function stamp_payment_cost_percent()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.cost_percent is null and new.payment_link_id is not null then
    select least(greatest(coalesce(pl.cost_percent, pr.cost_percent, 0), 0), 1000)
      into new.cost_percent
    from payment_links pl
    join profiles pr on pr.id = pl.user_id
    where pl.id = new.payment_link_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_stamp_payment_cost_percent on payments;
create trigger trg_stamp_payment_cost_percent
  before insert on payments
  for each row execute function stamp_payment_cost_percent();

revoke all on function stamp_payment_cost_percent() from public, anon, authenticated;


-- ------------------------------------------------------------
-- 3. At most 10 active links per owner
-- ------------------------------------------------------------
-- profiles.max_payment_links stays the per-person limit an admin sets.
-- max_links_per_owner() is the ceiling above it. Admins used to bypass
-- the check entirely; now an admin acting on someone's links skips the
-- per-person limit but not the ceiling. Links OWNED by an admin are not
-- counted. A link is "active" when is_active and not soft-deleted. A
-- variant group (up to 4 spellings of one name) counts once, as before.

create or replace function max_links_per_owner()
returns int
language sql
immutable
set search_path = public
as $$
  select 10;
$$;

revoke all on function max_links_per_owner() from public, anon;
grant execute on function max_links_per_owner() to authenticated, service_role;

create or replace function enforce_link_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit int;
  v_current int;
  v_group_size int;
  v_owner_role text;
  v_profile_limit int;
begin
  if coalesce(new.is_active, true) = false or new.deleted_at is not null then
    return new;
  end if;

  -- Already counted: an active row staying active in the same group and
  -- with the same owner.
  if tg_op = 'UPDATE'
     and coalesce(old.is_active, true) = true
     and old.deleted_at is null
     and new.user_id = old.user_id
     and coalesce(new.variant_group, new.id) = coalesce(old.variant_group, old.id) then
    return new;
  end if;

  select role, max_payment_links into v_owner_role, v_profile_limit
  from profiles where id = new.user_id;

  if v_owner_role = 'admin' then
    return new;
  end if;

  -- Two inserts for the same owner in parallel would both see 9.
  perform pg_advisory_xact_lock(hashtextextended('cpay.link_limit:' || new.user_id::text, 0));

  if is_admin() then
    v_limit := max_links_per_owner();
  else
    v_limit := least(coalesce(v_profile_limit, max_links_per_owner()), max_links_per_owner());
  end if;

  select count(distinct coalesce(variant_group, id)) into v_current
  from payment_links
  where user_id = new.user_id
    and is_active = true
    and deleted_at is null
    and coalesce(variant_group, id) is distinct from coalesce(new.variant_group, new.id);

  if v_current >= v_limit then
    raise exception 'Limit reached: you can have at most % active links', v_limit;
  end if;

  if new.variant_group is not null then
    select count(*) into v_group_size
    from payment_links
    where user_id = new.user_id
      and variant_group = new.variant_group
      and id is distinct from new.id;

    if v_group_size >= 4 then
      raise exception 'A link can have at most 4 name variants';
    end if;
  end if;

  return new;
end;
$$;

create or replace function admin_set_link_limit(p_creator_id uuid, p_limit integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if p_limit is null or p_limit < 0 or p_limit > max_links_per_owner() then
    raise exception 'Limit must be between 0 and %', max_links_per_owner();
  end if;
  update profiles set max_payment_links = p_limit where id = p_creator_id;
end;
$$;

-- New accounts get the full 10. Only moves the setting if it is still
-- the factory 5, so an admin's own choice survives.
alter table profiles alter column max_payment_links set default 10;
update app_settings
   set value = jsonb_build_object('count', 10)
 where key = 'default_max_payment_links'
   and (value->>'count') = '5';


-- ------------------------------------------------------------
-- 4. Who is on a reseller's team
-- ------------------------------------------------------------
-- The same two routes reseller_owns() and my_team_members() use:
-- affiliate signup (referred_by) and moderator assignment.

create or replace function reseller_team_ids(p_reseller_id uuid)
returns table (user_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select pr.id from profiles pr
  where pr.referred_by = p_reseller_id and pr.id <> p_reseller_id
  union
  select ma.creator_id from moderator_assignments ma
  where ma.moderator_id = p_reseller_id and ma.creator_id <> p_reseller_id;
$$;

revoke all on function reseller_team_ids(uuid) from public, anon, authenticated;
grant execute on function reseller_team_ids(uuid) to service_role;


-- ------------------------------------------------------------
-- 5. The one definition of "a settled payment on a business day"
-- ------------------------------------------------------------
-- p_user_ids null means everyone. p_apply_hide applies each owner's
-- hide-small threshold, exactly as get_balance_for() does, so what a
-- freelancer or reseller sees per day adds up to their balance. Admin
-- views pass false. cost_rate is the snapshot, else (rows before 0096)
-- the link's current rate; null for payments with no link.

create or replace function dashboard_settled_payments(
  p_user_ids uuid[], p_from date, p_to date, p_apply_hide boolean
)
returns table (
  payment_id uuid,
  user_id uuid,
  business_day date,
  payment_link_id uuid,
  amount_settled numeric,
  platform_fee numeric,
  reseller_id uuid,
  reseller_commission numeric,
  cost_rate numeric
)
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
    p.reseller_id,
    coalesce(p.reseller_commission_amount, 0),
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

revoke all on function dashboard_settled_payments(uuid[], date, date, boolean) from public, anon, authenticated;
grant execute on function dashboard_settled_payments(uuid[], date, date, boolean) to service_role;

-- Links that existed at any moment of the day: created before it ended
-- and not deleted before it started.
create or replace function dashboard_links_on_day(p_user_ids uuid[], p_from date, p_to date)
returns table (user_id uuid, business_day date, link_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select pl.user_id, d.gs::date, pl.id
  from generate_series(p_from, p_to, interval '1 day') as d(gs)
  join payment_links pl
    on coalesce(pl.created_at, '-infinity'::timestamptz) < business_day_end(d.gs::date)
   and (pl.deleted_at is null or pl.deleted_at >= business_day_start(d.gs::date))
  where p_user_ids is null or pl.user_id = any (p_user_ids);
$$;

revoke all on function dashboard_links_on_day(uuid[], date, date) from public, anon, authenticated;
grant execute on function dashboard_links_on_day(uuid[], date, date) to service_role;

-- One row per (owner, day) for every owner in p_user_ids and every day.
create or replace function dashboard_user_days(
  p_user_ids uuid[], p_from date, p_to date, p_apply_hide boolean
)
returns table (
  user_id uuid,
  business_day date,
  day_start timestamptz,
  day_end timestamptz,
  link_count int,
  paid_link_count int,
  cost_rates numeric[],
  payment_count bigint,
  settled numeric,
  platform_fee numeric,
  reseller_commission numeric,
  earnings numeric
)
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
           sum(p.platform_fee) as fee,
           sum(p.reseller_commission) as comm
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
    coalesce(pd.comm, 0),
    coalesce(pd.settled, 0) - coalesce(pd.fee, 0) - coalesce(pd.comm, 0)
  from unnest(p_user_ids) as u(id)
  cross join generate_series(p_from, p_to, interval '1 day') as d(gs)
  left join pay_day pd on pd.user_id = u.id and pd.business_day = d.gs::date
  left join link_day ld on ld.user_id = u.id and ld.business_day = d.gs::date;
$$;

revoke all on function dashboard_user_days(uuid[], date, date, boolean) from public, anon, authenticated;
grant execute on function dashboard_user_days(uuid[], date, date, boolean) to service_role;

-- One row per (owner, day, link) for links that existed that day or
-- took a payment that day, plus a link_id-null row for payments with no
-- link, so the rows add up to dashboard_user_days().
create or replace function dashboard_link_days(
  p_user_ids uuid[], p_from date, p_to date, p_apply_hide boolean
)
returns table (
  user_id uuid,
  business_day date,
  day_start timestamptz,
  day_end timestamptz,
  link_id uuid,
  slug text,
  link_name text,
  is_active boolean,
  deleted_at timestamptz,
  cost_percent_now numeric,
  cost_percent_used_min numeric,
  cost_percent_used_max numeric,
  payment_count bigint,
  settled numeric,
  platform_fee numeric,
  reseller_commission numeric,
  earnings numeric
)
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
           sum(p.platform_fee) as fee, sum(p.reseller_commission) as comm
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
    coalesce(a.comm, 0),
    coalesce(a.settled, 0) - coalesce(a.fee, 0) - coalesce(a.comm, 0)
  from keys k
  join profiles pr on pr.id = k.user_id
  left join payment_links pl on pl.id = k.link_id
  left join agg a
    on a.user_id = k.user_id
   and a.business_day = k.business_day
   and a.link_id is not distinct from k.link_id;
$$;

revoke all on function dashboard_link_days(uuid[], date, date, boolean) from public, anon, authenticated;
grant execute on function dashboard_link_days(uuid[], date, date, boolean) to service_role;


-- ------------------------------------------------------------
-- 6. Dashboard RPCs
-- ------------------------------------------------------------
-- Money columns, everywhere below:
--   settled             sum of amount_settled
--   platform_fee        platform's cut (payments.platform_fee_amount)
--   reseller_commission reseller's cut (payments.reseller_commission_amount)
--   earnings            settled - platform_fee - reseller_commission,
--                       the freelancer's share, as in get_balance_for()
-- cost_rates is the distinct cost % charged that day, ascending.

-- Freelancer (or reseller) looking at their own book. commission_earned
-- is what the caller earned as someone's reseller that day.
create or replace function my_daily_summary(p_days int default 14)
returns table (
  business_day date,
  day_start timestamptz,
  day_end timestamptz,
  link_count int,
  paid_link_count int,
  cost_rates numeric[],
  payment_count bigint,
  settled numeric,
  platform_fee numeric,
  reseller_commission numeric,
  earnings numeric,
  commission_earned numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_to date := current_business_day();
  v_from date := current_business_day() - (least(greatest(coalesce(p_days, 14), 1), 60) - 1);
  v_hide_at numeric;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  v_hide_at := hide_threshold_for(v_uid);

  return query
  select
    d.business_day, d.day_start, d.day_end,
    d.link_count, d.paid_link_count, d.cost_rates,
    d.payment_count, d.settled, d.platform_fee, d.reseller_commission, d.earnings,
    coalesce((
      select sum(p.reseller_commission_amount)
      from payments p
      where p.reseller_id = v_uid
        and p.status = 'settled'
        and p.settled_at >= d.day_start
        and p.settled_at <  d.day_end
        and not (p.amount_settled < v_hide_at)
    ), 0)
  from dashboard_user_days(array[v_uid], v_from, v_to, true) d
  order by d.business_day desc;
end;
$$;

-- Reseller's team, one row per member per day, with the member's
-- profile. The reseller's own book is included with is_self = true.
create or replace function reseller_team_daily_summary(p_days int default 14)
returns table (
  user_id uuid,
  email text,
  display_name text,
  role text,
  account_status text,
  affiliate boolean,
  is_self boolean,
  business_day date,
  day_start timestamptz,
  day_end timestamptz,
  link_count int,
  paid_link_count int,
  cost_rates numeric[],
  payment_count bigint,
  settled numeric,
  platform_fee numeric,
  reseller_commission numeric,
  earnings numeric
)
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
    d.payment_count, d.settled, d.platform_fee, d.reseller_commission, d.earnings
  from dashboard_user_days(v_ids, v_from, v_to, true) d
  join profiles pr on pr.id = d.user_id
  order by d.business_day desc, (pr.id = v_uid) desc, d.settled desc, pr.email;
end;
$$;

-- Admin: every freelancer and reseller per day with profile, email and
-- reseller. Without p_user_id, days where a person had no link and no
-- payment are left out. p_reseller_id narrows to that reseller and
-- their team.
create or replace function admin_daily_summary(
  p_days int default 14,
  p_user_id uuid default null,
  p_reseller_id uuid default null
)
returns table (
  user_id uuid,
  email text,
  display_name text,
  role text,
  account_status text,
  created_at timestamptz,
  reseller_id uuid,
  reseller_email text,
  reseller_name text,
  max_payment_links int,
  business_day date,
  day_start timestamptz,
  day_end timestamptz,
  link_count int,
  paid_link_count int,
  cost_rates numeric[],
  payment_count bigint,
  settled numeric,
  platform_fee numeric,
  reseller_commission numeric,
  earnings numeric
)
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
    d.payment_count, d.settled, d.platform_fee, d.reseller_commission, d.earnings
  from dashboard_user_days(v_ids, v_from, v_to, false) d
  join profiles pr on pr.id = d.user_id
  join owner_reseller o on o.id = d.user_id
  left join profiles rs on rs.id = o.reseller_id
  where p_user_id is not null or d.link_count > 0 or d.payment_count > 0
  order by d.business_day desc, d.settled desc, pr.email;
end;
$$;

-- Admin graph: one row per business day, oldest first. Unfiltered it
-- covers every payment, like admin_daily_settled(). withdrawal_fee_revenue
-- is fees on payouts that went out that day (admin_daily_settled's
-- admin_profit), for the same people.
create or replace function admin_daily_timeseries(
  p_days int default 30,
  p_user_id uuid default null,
  p_reseller_id uuid default null
)
returns table (
  business_day date,
  day_start timestamptz,
  day_end timestamptz,
  payment_count bigint,
  settled numeric,
  platform_fee numeric,
  reseller_commission numeric,
  earnings numeric,
  active_earners int,
  withdrawal_fee_revenue numeric
)
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
           sum(p.platform_fee) as fee, sum(p.reseller_commission) as comm,
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
    coalesce(pd.comm, 0),
    coalesce(pd.settled, 0) - coalesce(pd.fee, 0) - coalesce(pd.comm, 0),
    coalesce(pd.earners, 0),
    round(coalesce(wd.fee, 0), 4)
  from business_days(v_days) d
  left join pay_day pd on pd.business_day = d.business_day
  left join wd_day wd on wd.business_day = d.business_day
  order by d.business_day asc;
end;
$$;

-- Per link per day for one person. Default is the caller. A reseller
-- may pass a team member, an admin anyone. Hide-small applies for
-- everyone except admins, as in the summaries.
create or replace function daily_link_breakdown(
  p_days int default 14,
  p_user_id uuid default null
)
returns table (
  user_id uuid,
  email text,
  display_name text,
  business_day date,
  day_start timestamptz,
  day_end timestamptz,
  link_id uuid,
  slug text,
  link_name text,
  is_active boolean,
  deleted_at timestamptz,
  cost_percent_now numeric,
  cost_percent_used_min numeric,
  cost_percent_used_max numeric,
  payment_count bigint,
  settled numeric,
  platform_fee numeric,
  reseller_commission numeric,
  earnings numeric
)
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
    l.payment_count, l.settled, l.platform_fee, l.reseller_commission, l.earnings
  from dashboard_link_days(array[v_target], v_from, v_to, not v_admin) l
  join profiles pr on pr.id = l.user_id
  order by l.business_day desc, l.settled desc, l.slug nulls last;
end;
$$;

revoke all on function my_daily_summary(int) from public, anon;
revoke all on function reseller_team_daily_summary(int) from public, anon;
revoke all on function admin_daily_summary(int, uuid, uuid) from public, anon;
revoke all on function admin_daily_timeseries(int, uuid, uuid) from public, anon;
revoke all on function daily_link_breakdown(int, uuid) from public, anon;
grant execute on function my_daily_summary(int) to authenticated;
grant execute on function reseller_team_daily_summary(int) to authenticated;
grant execute on function admin_daily_summary(int, uuid, uuid) to authenticated;
grant execute on function admin_daily_timeseries(int, uuid, uuid) to authenticated;
grant execute on function daily_link_breakdown(int, uuid) to authenticated;


-- ------------------------------------------------------------
-- 7. Existing day functions, now on business_day()
-- ------------------------------------------------------------
-- Same signatures and same numbers as before; only the day arithmetic
-- moves to the helpers.

create or replace function admin_daily_settled(p_days integer default 14)
returns table (cycle_date date, cycle_start timestamptz, cycle_end timestamptz,
               settled numeric, payment_count bigint, admin_profit numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;

  return query
  select
    b.business_day, b.day_start, b.day_end,
    coalesce((select sum(p.amount_settled) from payments p
              where p.status = 'settled'
                and p.settled_at >= b.day_start and p.settled_at < b.day_end), 0),
    (select count(*) from payments p
      where p.status = 'settled'
        and p.settled_at >= b.day_start and p.settled_at < b.day_end),
    round(coalesce((select sum(w.amount_requested - w.amount_after_fee) from withdrawals w
                    where w.status = 'paid'
                      and w.processed_at >= b.day_start and w.processed_at < b.day_end), 0), 4)
  from business_days(least(greatest(coalesce(p_days, 14), 1), 60)) b
  order by b.business_day desc;
end;
$$;

create or replace function my_daily_settled(p_days integer default 14)
returns table (cycle_date date, cycle_start timestamptz, cycle_end timestamptz,
               settled numeric, payment_count bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_hide_at numeric := small_payment_threshold();
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  return query
  select
    b.business_day, b.day_start, b.day_end,
    coalesce(sum(p.amount_settled), 0),
    count(p.id)
  from business_days(least(greatest(coalesce(p_days, 14), 1), 60)) b
  left join payments p
    on p.user_id = v_uid
   and p.status = 'settled'
   and not (p.amount_settled < v_hide_at)
   and p.settled_at >= b.day_start
   and p.settled_at <  b.day_end
  group by b.business_day, b.day_start, b.day_end
  order by b.business_day desc;
end;
$$;

create or replace function staff_daily_settled(p_days integer default 14)
returns table (creator_id uuid, creator_name text, creator_email text,
               cycle_date date, cycle_start timestamptz, cycle_end timestamptz,
               settled numeric, payment_count bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_hide_at numeric := small_payment_threshold();
begin
  if not (is_admin() or is_moderator()) then raise exception 'Not authorized'; end if;

  return query
  with mine as (
    select pr.id, pr.display_name, pr.email
    from profiles pr
    where pr.role = 'creator' and handles_creator(pr.id)
  )
  select
    m.id, m.display_name, m.email,
    b.business_day, b.day_start, b.day_end,
    coalesce(sum(p.amount_settled), 0),
    count(p.id)
  from mine m
  cross join business_days(least(greatest(coalesce(p_days, 14), 1), 60)) b
  left join payments p
    on p.user_id = m.id
   and p.status = 'settled'
   and not (p.amount_settled < v_hide_at)
   and p.settled_at >= b.day_start
   and p.settled_at <  b.day_end
  group by m.id, m.display_name, m.email, b.business_day, b.day_start, b.day_end
  order by b.business_day desc, m.display_name;
end;
$$;

create or replace function daily_totals_for_cycle(p_cycle_date date)
returns table (cycle_start timestamptz, cycle_end timestamptz, total_settled numeric,
               payment_count bigint, total_withdrawn numeric, total_admin_profit numeric)
language sql
security definer
stable
set search_path = public
as $$
  with b as (
    select business_day_start(p_cycle_date) as cycle_start,
           business_day_end(p_cycle_date) as cycle_end
  )
  select
    b.cycle_start,
    b.cycle_end,
    coalesce((select sum(p.amount_settled) from payments p
              where p.status = 'settled'
                and p.settled_at >= b.cycle_start and p.settled_at < b.cycle_end), 0),
    coalesce((select count(*) from payments p
              where p.status = 'settled'
                and p.settled_at >= b.cycle_start and p.settled_at < b.cycle_end), 0),
    coalesce((select sum(w.amount_after_fee) from withdrawals w
              where w.status = 'paid'
                and w.processed_at >= b.cycle_start and w.processed_at < b.cycle_end), 0),
    coalesce((select sum(p.platform_fee_amount) from payments p
              where p.status = 'settled'
                and p.settled_at >= b.cycle_start and p.settled_at < b.cycle_end), 0)
  from b;
$$;

-- 0062 limited this to the service role (daily-report); 0091 granted it
-- back to every signed-in user. Platform totals are admin data, and the
-- admin screen reads admin_daily_settled().
revoke all on function daily_totals_for_cycle(date) from public, anon, authenticated;
grant execute on function daily_totals_for_cycle(date) to service_role;

-- Was callable by any signed-in user for any reseller id. The
-- reseller-digest job calls it with the service role (auth.uid() null).
create or replace function reseller_cycle_digest(p_reseller_id uuid, p_cycle_date date default null)
returns table (reseller_id uuid, cycle_date date, total_settled numeric, payment_count bigint,
               link_slug text, link_name text, link_settled numeric, link_count bigint,
               cost_percent numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_date date := coalesce(p_cycle_date, current_business_day());
  v_start timestamptz := business_day_start(coalesce(p_cycle_date, current_business_day()));
  v_end timestamptz := business_day_end(coalesce(p_cycle_date, current_business_day()));
begin
  if auth.uid() is not null and auth.uid() <> p_reseller_id and not is_admin() then
    raise exception 'Not authorized';
  end if;

  return query
  with team as (
    select p_reseller_id as uid
    union
    select t.user_id from reseller_team_ids(p_reseller_id) t
  ),
  settled as (
    select pl.slug, pl.display_name,
           coalesce(p.cost_percent, pl.cost_percent, pr.cost_percent, 0) as cost_percent,
           p.amount_settled
    from payments p
    join payment_links pl on pl.id = p.payment_link_id
    join profiles pr on pr.id = p.user_id
    where p.status = 'settled'
      and p.settled_at >= v_start
      and p.settled_at < v_end
      and p.user_id in (select uid from team)
  )
  select
    p_reseller_id,
    v_date,
    (select coalesce(sum(s2.amount_settled), 0) from settled s2),
    (select count(*) from settled s2),
    s.slug,
    s.display_name,
    sum(s.amount_settled),
    count(*),
    max(s.cost_percent)
  from settled s
  group by s.slug, s.display_name;
end;
$$;

-- Bucketed by UTC midnight (current_date, settled_at::date). No caller
-- in the app today; moved to business days so it cannot disagree.
create or replace function get_my_analytics()
returns table (day date, revenue numeric, payments bigint, link_slug text,
               link_revenue numeric, link_payments bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_hide_at numeric := small_payment_threshold();
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  return query
  with daily as (
    select b.business_day as d,
           coalesce(sum(p.amount_settled), 0) as revenue,
           count(p.id) as payments
    from business_days(30) b
    left join payments p
      on p.user_id = v_uid
     and p.status = 'settled'
     and p.amount_settled >= v_hide_at
     and p.settled_at >= b.day_start
     and p.settled_at <  b.day_end
    group by b.business_day
  ),
  links as (
    select l.slug,
           coalesce(sum(p.amount_settled) filter (where p.status = 'settled' and p.amount_settled >= v_hide_at), 0) as link_revenue,
           count(p.id) filter (where p.status = 'settled' and p.amount_settled >= v_hide_at) as link_payments
    from payment_links l
    left join payments p on p.payment_link_id = l.id and p.user_id = v_uid
    where l.user_id = v_uid and l.deleted_at is null
    group by l.slug
  )
  select x.d, x.revenue, x.payments, null::text, null::numeric, null::bigint
  from daily x
  union all
  select current_business_day(), null::numeric, null::bigint, l.slug, l.link_revenue, l.link_payments
  from links l
  order by 1 desc, 4 nulls last;
end;
$$;

-- staff_list_payments: body unchanged except p_time => 'today', which
-- started at UTC midnight and now starts at the business day.
create or replace function public.staff_list_payments(p_limit integer DEFAULT 120, p_offset integer DEFAULT 0, p_search text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_time text DEFAULT NULL::text) RETURNS TABLE(id uuid, amount_requested numeric, amount_settled numeric, status text, method text, created_at timestamp with time zone, settled_at timestamp with time zone, expires_at timestamp with time zone, customer_city text, customer_country text, creator_id uuid, creator_email text, creator_name text, link_slug text, invoice_ref text, lightning_invoice text, marked_at timestamp with time zone, marked_by_name text, mark_note text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 120), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_status text := lower(nullif(trim(coalesce(p_status, '')), ''));
  v_time text := lower(nullif(trim(coalesce(p_time, '')), ''));
  v_now timestamptz := now();
  v_start timestamptz := null;
  v_hide_at numeric := small_payment_threshold();
begin
  if not (is_admin() or is_moderator()) then
    raise exception 'Not authorized';
  end if;

  if v_status is not null and v_status not in ('settled', 'new', 'pending', 'expired', 'invalid') then
    raise exception 'Invalid status filter';
  end if;

  if v_time = 'today' then
    v_start := business_day_start(current_business_day());
  elsif v_time = '7d' then
    v_start := v_now - interval '7 days';
  elsif v_time = '30d' then
    v_start := v_now - interval '30 days';
  elsif v_time is null or v_time = '' then
    v_start := null;
  else
    raise exception 'Invalid time filter';
  end if;

  return query
  select
    p.id,
    case when should_show_buyer_amount(p.user_id) then coalesce(p.buyer_amount, p.amount_requested) else p.amount_requested end,
    case when p.amount_settled is null then null
         when should_show_buyer_amount(p.user_id) then coalesce(p.buyer_amount, p.amount_settled)
         else p.amount_settled end,
    p.status,
    p.method,
    p.created_at,
    p.settled_at,
    p.expires_at,
    p.customer_city,
    p.customer_country,
    p.user_id,
    pr.email,
    pr.display_name,
    pl.slug,
    p.invoice_ref,
    p.lightning_invoice,
    p.marked_at,
    mb.display_name,
    p.mark_note
  from payments p
  join profiles pr on pr.id = p.user_id
  left join payment_links pl on pl.id = p.payment_link_id
  left join profiles mb on mb.id = p.marked_by
  where (is_admin() or handles_creator(p.user_id))
    and not (p.status = 'settled' and p.amount_settled < v_hide_at)
    and (
      p_search is null or p_search = ''
      or p.invoice_ref ilike '%' || p_search || '%'
      or p.lightning_invoice ilike '%' || p_search || '%'
      or pr.email ilike '%' || p_search || '%'
      or coalesce(pr.display_name, '') ilike '%' || p_search || '%'
      or coalesce(pl.slug, '') ilike '%' || p_search || '%'
    )
    and (v_status is null or p.status = v_status)
    and (v_start is null or p.created_at >= v_start)
  order by p.created_at desc
  limit v_limit
  offset v_offset;
end;
$$;


-- ------------------------------------------------------------
-- 8. my_earnings_split(): qualify profile columns
-- ------------------------------------------------------------
-- The RETURNS TABLE names cost_percent and cost_locked are variables
-- inside the body, so the bare column names were ambiguous and every
-- call failed.

create or replace function my_earnings_split()
returns table (settled numeric, platform_fee numeric, reseller_commission_out numeric,
               reseller_commission_in numeric, net numeric, cost_percent numeric,
               cost_locked boolean, commission_percent numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  return query
  select
    coalesce((select sum(p.amount_settled) from payments p where p.user_id = v_uid and p.status = 'settled'), 0),
    coalesce((select sum(p.platform_fee_amount) from payments p where p.user_id = v_uid and p.status = 'settled'), 0),
    coalesce((select sum(p.reseller_commission_amount) from payments p where p.user_id = v_uid and p.status = 'settled'), 0),
    coalesce((select sum(p.reseller_commission_amount) from payments p where p.reseller_id = v_uid and p.status = 'settled'), 0),
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
