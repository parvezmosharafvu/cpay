-- ============================================================
-- Reseller role removal (20261005020000): state BEFORE
-- ============================================================
-- Runs on a database migrated up to, but NOT including, 20261005020000.
-- Seeds what production has (a reseller account with its own links,
-- payments, a wallet and a withdrawal, an empty reseller_settings row, and
-- freelancers with and without their own withdrawal fee), records every
-- balance, dashboard day, payment, withdrawal, link and resolved withdrawal
-- fee in ci_role_check, and leaves the data committed so
-- ci/role_removal_after.sql can compare once the migration runs.
-- Throwaway database only (see .github/workflows/verify.yml).
-- ============================================================
\set ON_ERROR_STOP 1

insert into auth.users (id, email, raw_user_meta_data) values
 ('ca000000-0000-0000-0000-000000000001', 'role.reseller@cpay.test', '{}'),
 ('ca000000-0000-0000-0000-000000000002', 'role.ownfee@cpay.test', '{}'),
 ('ca000000-0000-0000-0000-000000000003', 'role.global@cpay.test', '{}'),
 ('ca000000-0000-0000-0000-000000000004', 'role.hidden@cpay.test', '{}'),
 ('ca000000-0000-0000-0000-000000000009', 'role.admin@cpay.test', '{}');
update profiles set account_status = 'active' where id::text like 'ca000000-%';
update profiles set role = 'moderator' where id = 'ca000000-0000-0000-0000-000000000001';
-- The role trigger gave it an affiliate code; production's reseller has
-- none (2026-10-05), and a code is an abort condition (role_removal_abort_test.sh).
update profiles set affiliate_code = null where id = 'ca000000-0000-0000-0000-000000000001';
update profiles set role = 'admin' where id = 'ca000000-0000-0000-0000-000000000009';
update profiles set withdrawal_fee_percent = 1.5 where id = 'ca000000-0000-0000-0000-000000000002';
update profiles set hide_small_payments_mode = 'on' where id = 'ca000000-0000-0000-0000-000000000004';
update profiles set cost_percent = 4 where id = 'ca000000-0000-0000-0000-000000000001';
-- Production's one reseller_settings row: no team fee, self-withdraw off.
insert into reseller_settings (reseller_id) values ('ca000000-0000-0000-0000-000000000001')
on conflict (reseller_id) do nothing;
insert into app_settings (key, value) values ('default_withdrawal_fee_percent', '{"percent": 2}')
on conflict (key) do update set value = excluded.value;

insert into payment_links (id, user_id, slug, display_name, cost_percent) values
 ('cb000000-0000-0000-0000-000000000001', 'ca000000-0000-0000-0000-000000000001', 'role-reseller-own', 'Reseller own', 6),
 ('cb000000-0000-0000-0000-000000000002', 'ca000000-0000-0000-0000-000000000002', 'role-ownfee', 'Own fee', null),
 ('cb000000-0000-0000-0000-000000000003', 'ca000000-0000-0000-0000-000000000003', 'role-global', 'Global', 2),
 ('cb000000-0000-0000-0000-000000000004', 'ca000000-0000-0000-0000-000000000004', 'role-hidden', 'Hidden', null);
insert into usdt_wallets (user_id, network, address) values
 ('ca000000-0000-0000-0000-000000000001', 'tron', 'TRoleResellerWa11etAddressXXXXXXXXX');

create function pg_temp.pay(p_n int, p_owner int, p_amount numeric, p_status text, p_days_ago int)
returns void language plpgsql as $$
declare v_id uuid := ('cc100000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid;
begin
  insert into payments (id, user_id, payment_link_id, amount_requested, status, expires_at)
  values (v_id, ('ca000000-0000-0000-0000-00000000000' || p_owner)::uuid,
          ('cb000000-0000-0000-0000-00000000000' || p_owner)::uuid, p_amount, 'new', now() + interval '1 hour');
  if p_status = 'settled' then
    update payments set status = 'settled', amount_settled = p_amount,
           settled_at = now() - make_interval(days => p_days_ago)
     where id = v_id;
  elsif p_status <> 'new' then
    update payments set status = p_status where id = v_id;
  end if;
end $$;

do $$ begin perform pg_temp.pay(1, 1, 120,   'settled', 0); end $$;
do $$ begin perform pg_temp.pay(2, 1, 45.5,  'settled', 2); end $$;
do $$ begin perform pg_temp.pay(3, 1, 30,    'expired', 0); end $$;
do $$ begin perform pg_temp.pay(4, 2, 200,   'settled', 1); end $$;
do $$ begin perform pg_temp.pay(5, 3, 77.77, 'settled', 0); end $$;
do $$ begin perform pg_temp.pay(6, 4, 6,     'settled', 0); end $$;   -- under the hide threshold
do $$ begin perform pg_temp.pay(7, 4, 50,    'settled', 3); end $$;

create function pg_temp.wd(p_owner int, p_amount numeric, p_status text)
returns void language plpgsql as $$
declare v_id uuid;
begin
  insert into withdrawals (user_id, amount_requested, fee_percent, amount_after_fee, method, destination, status, coin, chain)
  values (('ca000000-0000-0000-0000-00000000000' || p_owner)::uuid, p_amount, 2, round(p_amount * 0.98, 8),
          'stablecoin', 'TRoleResellerWa11etAddressXXXXXXXXX', 'rejected', 'USDT', 'tron')
  returning id into v_id;
  if p_status <> 'rejected' then
    update withdrawals set status = p_status, processed_at = case when p_status = 'paid' then now() end where id = v_id;
  end if;
end $$;

do $$ begin perform pg_temp.wd(1, 50, 'paid'); end $$;
do $$ begin perform pg_temp.wd(1, 10, 'pending'); end $$;
do $$ begin perform pg_temp.wd(2, 60, 'paid'); end $$;

create schema ci_role_check;
create table ci_role_check.balances as
select pr.id as user_id, b.earned, b.queued, b.withdrawn, b.available
from profiles pr, lateral get_balance_for(pr.id) b;
create table ci_role_check.dashboard as
select d.user_id, d.business_day, d.payment_count, d.settled, d.platform_fee, d.earnings
from dashboard_user_days(array(select id from profiles), current_business_day() - 5, current_business_day(), true) d;
create table ci_role_check.payments as
select id, user_id, payment_link_id, status, amount_settled, platform_fee_percent, platform_fee_amount from payments;
create table ci_role_check.withdrawals as
select id, user_id, status, amount_requested, fee_percent, amount_after_fee, destination from withdrawals;
create table ci_role_check.links as
select id, user_id, slug, cost_percent, is_active, deleted_at from payment_links;
create table ci_role_check.profiles as
select id, email, account_status, cost_percent, withdrawal_fee_percent, platform_fee_percent from profiles;
create table ci_role_check.fees as
select pr.id as user_id, r.fee_percent, r.source, resolve_withdrawal_fee(pr.id) as resolved
from profiles pr, lateral withdrawal_fee_resolution(pr.id) r;

do $$
declare r record;
begin
  -- Spot-check the fixture so a broken seed cannot pass vacuously.
  select * into r from ci_role_check.balances where user_id = 'ca000000-0000-0000-0000-000000000001';
  -- (120 - 3.60) + (45.50 - 1.37) = 160.53; queued 50 + 10; paid 50 * 0.98
  if r.earned <> 160.53 or r.queued <> 60 or r.withdrawn <> 49 or r.available <> 100.53 then
    raise exception 'fixture balance wrong: %', row_to_json(r);
  end if;
  if (select (fee_percent, source) from ci_role_check.fees where user_id = 'ca000000-0000-0000-0000-000000000001') is distinct from (2::numeric, 'global'::text)
     or (select (fee_percent, source) from ci_role_check.fees where user_id = 'ca000000-0000-0000-0000-000000000002') is distinct from (1.5::numeric, 'account'::text) then
    raise exception 'fixture fee wrong: %', (select json_agg(f) from ci_role_check.fees f where user_id::text like 'ca000000-%');
  end if;
  raise notice 'PASS before: % balances, % dashboard rows, % payments, % withdrawals, % links, % fees recorded',
    (select count(*) from ci_role_check.balances), (select count(*) from ci_role_check.dashboard),
    (select count(*) from ci_role_check.payments), (select count(*) from ci_role_check.withdrawals),
    (select count(*) from ci_role_check.links), (select count(*) from ci_role_check.fees);
end $$;
