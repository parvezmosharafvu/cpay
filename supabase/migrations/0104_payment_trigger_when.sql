-- CPAY — 0104: do not enter payment trigger functions when they would no-op.
-- The functions already return immediately in these cases. A WHEN clause
-- skips the plpgsql call on expiry updates and on inserts that already
-- carry a cost.

drop trigger if exists trg_stamp_payment_platform_fee on public.payments;
create trigger trg_stamp_payment_platform_fee
before update on public.payments
for each row
when (new.status = 'settled' and old.status is distinct from 'settled')
execute function public.stamp_payment_platform_fee();

drop trigger if exists trg_stamp_payment_cost_percent on public.payments;
create trigger trg_stamp_payment_cost_percent
before insert on public.payments
for each row
when (new.cost_percent is null and new.payment_link_id is not null)
execute function public.stamp_payment_cost_percent();
