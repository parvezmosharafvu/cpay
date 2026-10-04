-- ============================================================
-- Commission removal (20261005010000): balances AFTER
-- ============================================================
-- Runs after ci/commission_removal_before.sql and the migration. For
-- accounts without commission, every number must be identical: balance
-- (earned, queued, withdrawn, available), dashboard day totals, and each
-- payment's stamped platform fee. A payment settled now still gets the
-- platform fee, and the commission schema is gone.
-- ============================================================
\set ON_ERROR_STOP 1

do $$
declare v_diff int;
begin
  select count(*) into v_diff
  from ci_commission_check.balances o
  full join (select pr.id as user_id, b.earned, b.queued, b.withdrawn, b.available
             from profiles pr, lateral get_balance_for(pr.id) b) n using (user_id)
  where o.earned is distinct from n.earned or o.queued is distinct from n.queued
     or o.withdrawn is distinct from n.withdrawn or o.available is distinct from n.available;
  if v_diff > 0 then raise exception 'get_balance_for changed for % account(s)', v_diff; end if;

  select count(*) into v_diff
  from ci_commission_check.dashboard o
  full join dashboard_user_days(array(select id from profiles), current_business_day() - 5, current_business_day(), true) n
    using (user_id, business_day)
  where o.payment_count is distinct from n.payment_count or o.settled is distinct from n.settled
     or o.platform_fee is distinct from n.platform_fee or o.earnings is distinct from n.earnings;
  if v_diff > 0 then raise exception 'dashboard totals changed for % day row(s)', v_diff; end if;

  select count(*) into v_diff
  from ci_commission_check.payments o
  full join payments n using (id)
  where o.status is distinct from n.status or o.amount_settled is distinct from n.amount_settled
     or o.platform_fee_percent is distinct from n.platform_fee_percent
     or o.platform_fee_amount is distinct from n.platform_fee_amount;
  if v_diff > 0 then raise exception 'stamped platform fees changed on % payment(s)', v_diff; end if;

  raise notice 'PASS after: % balances, % dashboard rows and % payment fees identical',
    (select count(*) from ci_commission_check.balances),
    (select count(*) from ci_commission_check.dashboard),
    (select count(*) from ci_commission_check.payments);
end $$;

-- A payment settled after the migration still pays the platform fee,
-- default and override, and nothing else.
insert into payments (id, user_id, payment_link_id, amount_requested, status, expires_at) values
 ('ce000000-0000-0000-0000-000000000101', 'cc000000-0000-0000-0000-000000000001', 'cd000000-0000-0000-0000-000000000001', 77.77, 'new', now() + interval '1 hour'),
 ('ce000000-0000-0000-0000-000000000102', 'cc000000-0000-0000-0000-000000000002', 'cd000000-0000-0000-0000-000000000002', 77.77, 'new', now() + interval '1 hour');
update payments set status = 'settled', amount_settled = amount_requested, settled_at = now()
 where id in ('ce000000-0000-0000-0000-000000000101', 'ce000000-0000-0000-0000-000000000102');

do $$
declare v_old numeric; v_new numeric;
begin
  if (select platform_fee_percent from payments where id = 'ce000000-0000-0000-0000-000000000101') <> 3
     or (select platform_fee_amount from payments where id = 'ce000000-0000-0000-0000-000000000101') <> 2.33
     or (select platform_fee_percent from payments where id = 'ce000000-0000-0000-0000-000000000102') <> 1.25
     or (select platform_fee_amount from payments where id = 'ce000000-0000-0000-0000-000000000102') <> 0.97 then
    raise exception 'platform fee not stamped on a new settlement';
  end if;
  select available into v_old from ci_commission_check.balances where user_id = 'cc000000-0000-0000-0000-000000000001';
  select available into v_new from get_balance_for('cc000000-0000-0000-0000-000000000001');
  if v_new <> v_old + 77.77 - 2.33 then
    raise exception 'new settlement: available % -> %, want +75.44', v_old, v_new;
  end if;
  raise notice 'PASS new settlement: fee 3%% = 2.33 and override 1.25%% = 0.97 stamped; available +75.44';
end $$;

do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public'
               and ((table_name = 'payments' and column_name in ('reseller_id', 'reseller_commission_percent', 'reseller_commission_amount'))
                 or (table_name = 'profiles' and column_name = 'reseller_commission_percent'))) then
    raise exception 'a commission column still exists';
  end if;
  if exists (select 1 from app_settings where key = 'default_reseller_commission_percent') then
    raise exception 'default_reseller_commission_percent setting still exists';
  end if;
  if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
             and (proname like '%commission%' or prosrc ~* 'reseller_commission|commission_percent|commission_amount')) then
    raise exception 'a function still mentions commission: %',
      (select string_agg(oid::regprocedure::text, ', ') from pg_proc where pronamespace = 'public'::regnamespace
         and (proname like '%commission%' or prosrc ~* 'reseller_commission|commission_percent|commission_amount'));
  end if;
  raise notice 'PASS commission schema, setting and functions are gone; platform fee kept';
end $$;
