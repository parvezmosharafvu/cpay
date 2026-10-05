-- ============================================================
-- Reseller role removal (20261005020000): state AFTER
-- ============================================================
-- Runs after ci/role_removal_before.sql and the migration, on the same
-- throwaway database. Every balance, dashboard day, payment, withdrawal,
-- link, profile setting and resolved withdrawal fee must be identical; the
-- reseller account is now a regular freelancer that can withdraw by itself
-- and can still be paid. The final checks run inside BEGIN/ROLLBACK.
-- ============================================================
\set ON_ERROR_STOP 1

do $$
declare v_diff bigint;
begin
  select count(*) into v_diff from (
    (select * from ci_role_check.balances
     except select pr.id, b.earned, b.queued, b.withdrawn, b.available from profiles pr, lateral get_balance_for(pr.id) b)
    union all
    (select pr.id, b.earned, b.queued, b.withdrawn, b.available from profiles pr, lateral get_balance_for(pr.id) b
     except select * from ci_role_check.balances)) x;
  if v_diff > 0 then raise exception 'balances changed: % row(s) differ', v_diff; end if;

  select count(*) into v_diff from (
    (select * from ci_role_check.dashboard
     except select d.user_id, d.business_day, d.payment_count, d.settled, d.platform_fee, d.earnings
       from dashboard_user_days(array(select id from profiles), current_business_day() - 5, current_business_day(), true) d)
    union all
    (select d.user_id, d.business_day, d.payment_count, d.settled, d.platform_fee, d.earnings
       from dashboard_user_days(array(select id from profiles), current_business_day() - 5, current_business_day(), true) d
     except select * from ci_role_check.dashboard)) x;
  if v_diff > 0 then raise exception 'dashboard days changed: % row(s) differ', v_diff; end if;

  select count(*) into v_diff from (
    (select * from ci_role_check.payments
     except select id, user_id, payment_link_id, status, amount_settled, platform_fee_percent, platform_fee_amount from payments)
    union all
    (select id, user_id, payment_link_id, status, amount_settled, platform_fee_percent, platform_fee_amount from payments
     except select * from ci_role_check.payments)) x;
  if v_diff > 0 then raise exception 'payments changed: % row(s) differ', v_diff; end if;

  select count(*) into v_diff from (
    (select * from ci_role_check.withdrawals
     except select id, user_id, status, amount_requested, fee_percent, amount_after_fee, destination from withdrawals)
    union all
    (select id, user_id, status, amount_requested, fee_percent, amount_after_fee, destination from withdrawals
     except select * from ci_role_check.withdrawals)) x;
  if v_diff > 0 then raise exception 'withdrawals changed: % row(s) differ', v_diff; end if;

  select count(*) into v_diff from (
    (select * from ci_role_check.links except select id, user_id, slug, cost_percent, is_active, deleted_at from payment_links)
    union all
    (select id, user_id, slug, cost_percent, is_active, deleted_at from payment_links except select * from ci_role_check.links)) x;
  if v_diff > 0 then raise exception 'payment links changed (cost overrides must survive): % row(s) differ', v_diff; end if;

  select count(*) into v_diff from (
    (select * from ci_role_check.profiles
     except select id, email, account_status, cost_percent, withdrawal_fee_percent, platform_fee_percent from profiles)
    union all
    (select id, email, account_status, cost_percent, withdrawal_fee_percent, platform_fee_percent from profiles
     except select * from ci_role_check.profiles)) x;
  if v_diff > 0 then raise exception 'profile settings changed: % row(s) differ', v_diff; end if;

  select count(*) into v_diff from (
    (select * from ci_role_check.fees
     except select pr.id, r.fee_percent, r.source, resolve_withdrawal_fee(pr.id) from profiles pr, lateral withdrawal_fee_resolution(pr.id) r)
    union all
    (select pr.id, r.fee_percent, r.source, resolve_withdrawal_fee(pr.id) from profiles pr, lateral withdrawal_fee_resolution(pr.id) r
     except select * from ci_role_check.fees)) x;
  if v_diff > 0 then raise exception 'resolved withdrawal fees changed: % row(s) differ', v_diff; end if;

  raise notice 'PASS after: balances, dashboard days, payments, withdrawals, links (cost overrides), profile settings and withdrawal fees identical';
end $$;

do $$
begin
  if (select role from profiles where id = 'ca000000-0000-0000-0000-000000000001') <> 'creator' then
    raise exception 'the reseller account was not moved to a freelancer account';
  end if;
  if exists (select 1 from profiles where role not in ('creator', 'admin')) then
    raise exception 'a role other than creator/admin is left';
  end if;
  if not exists (select 1 from audit_log where action = 'profile.role_changed'
                 and subject_id = 'ca000000-0000-0000-0000-000000000001'
                 and old_value->>'role' = 'moderator' and new_value->>'role' = 'creator') then
    raise exception 'the role change was not audited';
  end if;
  if (select role from profiles where id = 'ca000000-0000-0000-0000-000000000009') <> 'admin' then
    raise exception 'the admin lost its role';
  end if;
  raise notice 'PASS reseller account is a freelancer now (audited); the admin is untouched';
end $$;

-- The former reseller withdraws by itself, an admin can withdraw for it,
-- and a new payment on its link still pays the platform fee.
begin;
create or replace function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
do $$
declare v_w withdrawals; v_fee numeric := resolve_withdrawal_fee('ca000000-0000-0000-0000-000000000001');
begin
  v_w := reserve_stablecoin_withdrawal('ca000000-0000-0000-0000-000000000001', 'role-check-quote', 20, v_fee,
           round(20 * (1 - v_fee / 100), 2), 'USDT', 'tron', 'TRoleResellerWa11etAddressXXXXXXXXX', 0.5, 19, 30000,
           now() + interval '5 minutes');
  if v_w.status <> 'sending' or v_w.fee_percent <> 2 then raise exception 'self-withdraw: %', row_to_json(v_w); end if;
  raise notice 'PASS former reseller reserves its own withdrawal (fee % = global default)', v_w.fee_percent;
end $$;
set test.uid = 'ca000000-0000-0000-0000-000000000009';
do $$
declare v_w withdrawals;
begin
  v_w := admin_request_withdrawal_for('ca000000-0000-0000-0000-000000000001', 10, 'tron', 'ignored');
  if v_w.admin_note <> 'USDT payout submitted by admin' or v_w.destination <> 'TRoleResellerWa11etAddressXXXXXXXXX' then
    raise exception 'admin withdraw-on-behalf: %', row_to_json(v_w);
  end if;
  raise notice 'PASS admin withdraws for the former reseller to its saved wallet';
end $$;
reset test.uid;
insert into payments (id, user_id, payment_link_id, amount_requested, status, expires_at)
values ('cc100000-0000-0000-0000-000000000099', 'ca000000-0000-0000-0000-000000000001', 'cb000000-0000-0000-0000-000000000001', 10, 'new', now() + interval '1 hour');
update payments set status = 'settled', amount_settled = 10, settled_at = now() where id = 'cc100000-0000-0000-0000-000000000099';
do $$
begin
  if (select platform_fee_amount from payments where id = 'cc100000-0000-0000-0000-000000000099') <> 0.30 then
    raise exception 'new settlement fee: %', (select platform_fee_amount from payments where id = 'cc100000-0000-0000-0000-000000000099');
  end if;
  raise notice 'PASS a new payment on the former reseller''s link pays the 3%% platform fee';
end $$;
rollback;
