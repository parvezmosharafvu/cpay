-- ============================================================
-- Commission removal (20261005010000): balances BEFORE
-- ============================================================
-- Runs on a database migrated up to, but NOT including, 20261005010000.
-- Seeds accounts that have no reseller commission (the only kind that
-- exists in production), records every balance and dashboard total in
-- ci_commission_check, and leaves the data committed so
-- ci/commission_removal_after.sql can compare once the migration runs.
-- Throwaway database only (see .github/workflows/verify.yml).
--
-- The accounts cover what get_balance_for() reads:
--   * default platform fee (3%), an account fee override (1.25%), fee 0
--   * settled payments, unsettled ones (new / expired), and a payment
--     under the hide-small-payments threshold for an account with hiding on
--   * withdrawals paid, pending, rejected and failed
--   * an account with nothing at all
--   * a reseller (moderator) with its own payments but no commission
-- ============================================================
\set ON_ERROR_STOP 1

insert into auth.users (id, email, raw_user_meta_data) values
 ('cc000000-0000-0000-0000-000000000001', 'bal.default@cpay.test', '{}'),
 ('cc000000-0000-0000-0000-000000000002', 'bal.override@cpay.test', '{}'),
 ('cc000000-0000-0000-0000-000000000003', 'bal.zerofee@cpay.test', '{}'),
 ('cc000000-0000-0000-0000-000000000004', 'bal.hidden@cpay.test', '{}'),
 ('cc000000-0000-0000-0000-000000000005', 'bal.empty@cpay.test', '{}'),
 ('cc000000-0000-0000-0000-000000000006', 'bal.reseller@cpay.test', '{}');
update profiles set account_status = 'active' where id::text like 'cc000000-%';
update profiles set role = 'moderator' where id = 'cc000000-0000-0000-0000-000000000006';
update profiles set platform_fee_percent = 1.25 where id = 'cc000000-0000-0000-0000-000000000002';
update profiles set platform_fee_percent = 0 where id = 'cc000000-0000-0000-0000-000000000003';
update profiles set hide_small_payments_mode = 'on' where id = 'cc000000-0000-0000-0000-000000000004';

insert into payment_links (id, user_id, slug, display_name, cost_percent)
select ('cd000000-0000-0000-0000-00000000000' || n)::uuid, ('cc000000-0000-0000-0000-00000000000' || n)::uuid,
       'bal-link-' || n, 'Balance link ' || n, n
from generate_series(1, 6) n where n <> 5;

-- Insert 'new', then settle, like production, so the trigger stamps fees.
create function pg_temp.pay(p_n int, p_owner int, p_amount numeric, p_status text, p_days_ago int)
returns void language plpgsql as $$
declare v_id uuid := ('ce000000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid;
begin
  insert into payments (id, user_id, payment_link_id, amount_requested, status, expires_at)
  values (v_id, ('cc000000-0000-0000-0000-00000000000' || p_owner)::uuid,
          ('cd000000-0000-0000-0000-00000000000' || p_owner)::uuid, p_amount, 'new', now() + interval '1 hour');
  if p_status = 'settled' then
    update payments set status = 'settled', amount_settled = p_amount,
           settled_at = now() - make_interval(days => p_days_ago)
     where id = v_id;
  elsif p_status <> 'new' then
    update payments set status = p_status where id = v_id;
  end if;
end $$;

do $$ begin perform pg_temp.pay(1, 1, 100,     'settled', 0); end $$;
do $$ begin perform pg_temp.pay(2, 1, 33.33,   'settled', 1); end $$;
do $$ begin perform pg_temp.pay(3, 1, 25,      'new',     0); end $$;
do $$ begin perform pg_temp.pay(4, 2, 250,     'settled', 2); end $$;
do $$ begin perform pg_temp.pay(5, 2, 0.07,    'settled', 0); end $$;
do $$ begin perform pg_temp.pay(6, 3, 80,      'settled', 0); end $$;
do $$ begin perform pg_temp.pay(7, 4, 5,       'settled', 0); end $$;   -- under the 10 USD hide threshold
do $$ begin perform pg_temp.pay(8, 4, 60,      'settled', 1); end $$;
do $$ begin perform pg_temp.pay(9, 6, 40,      'settled', 0); end $$;
do $$ begin perform pg_temp.pay(10, 6, 12.5,   'expired', 0); end $$;

-- Withdrawals: inserted as 'rejected' then moved, like ci/dashboards_test.sql,
-- so the balance guard checks the final status.
create function pg_temp.wd(p_owner int, p_amount numeric, p_status text)
returns void language plpgsql as $$
declare v_id uuid;
begin
  insert into withdrawals (user_id, amount_requested, fee_percent, amount_after_fee, method, destination, status, coin, chain)
  values (('cc000000-0000-0000-0000-00000000000' || p_owner)::uuid, p_amount, 2, round(p_amount * 0.98, 8),
          'stablecoin', 'T1111111111111111111111111111111111', 'rejected', 'USDT', 'tron')
  returning id into v_id;
  if p_status <> 'rejected' then
    update withdrawals set status = p_status, processed_at = case when p_status = 'paid' then now() end where id = v_id;
  end if;
end $$;

do $$ begin perform pg_temp.wd(1, 40, 'paid'); end $$;
do $$ begin perform pg_temp.wd(1, 10, 'pending'); end $$;
do $$ begin perform pg_temp.wd(1, 500, 'rejected'); end $$;
do $$ begin perform pg_temp.wd(2, 100, 'paid'); end $$;
do $$ begin perform pg_temp.wd(2, 20, 'failed'); end $$;
do $$ begin perform pg_temp.wd(3, 30, 'pending'); end $$;
do $$ begin perform pg_temp.wd(6, 15, 'paid'); end $$;

do $$
begin
  if exists (select 1 from payments where reseller_id is not null or coalesce(reseller_commission_amount, 0) <> 0) then
    raise exception 'fixture error: a seeded payment carries commission';
  end if;
end $$;

create schema ci_commission_check;
create table ci_commission_check.balances as
select pr.id as user_id, b.earned, b.queued, b.withdrawn, b.available
from profiles pr, lateral get_balance_for(pr.id) b;

create table ci_commission_check.dashboard as
select d.user_id, d.business_day, d.payment_count, d.settled, d.platform_fee, d.earnings
from dashboard_user_days(array(select id from profiles), current_business_day() - 5, current_business_day(), true) d;

create table ci_commission_check.payments as
select id, status, amount_settled, platform_fee_percent, platform_fee_amount from payments;

do $$
declare r record;
begin
  -- Spot-check the fixture itself, so a broken seed cannot pass vacuously.
  select * into r from ci_commission_check.balances where user_id = 'cc000000-0000-0000-0000-000000000001';
  -- (100 - 3.00) + (33.33 - 1.00) = 129.33; queued 40 + 10; paid 40 * 0.98
  if r.earned <> 129.33 or r.queued <> 50 or r.withdrawn <> 39.2 or r.available <> 79.33 then
    raise exception 'fixture balance wrong: %', row_to_json(r);
  end if;
  select * into r from ci_commission_check.balances where user_id = 'cc000000-0000-0000-0000-000000000004';
  -- the 5 USD payment is hidden; 60 - 1.80
  if r.earned <> 58.20 then raise exception 'hidden-payment fixture wrong: %', row_to_json(r); end if;
  raise notice 'PASS before: % balances, % dashboard rows, % payments recorded',
    (select count(*) from ci_commission_check.balances),
    (select count(*) from ci_commission_check.dashboard),
    (select count(*) from ci_commission_check.payments);
end $$;
