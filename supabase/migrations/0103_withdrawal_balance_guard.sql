-- ============================================================
-- 0103: a withdrawal can never take a balance below zero
-- ============================================================
-- Every withdrawal path (request_withdrawal, reserve_stablecoin_withdrawal,
-- reseller_request_withdrawal_for, system_queue_withdrawal) checks the
-- available balance itself, after locking the profile row. This trigger
-- makes the database refuse an overdraft on any other path too: a direct
-- insert by the service role, an admin edit, or a future function that
-- forgets the check.
--
-- It fires when a row starts counting against the balance (insert, or a
-- move out of 'rejected'/'failed'), or counts for more (a larger amount or
-- another user). It locks the profile row, the same lock the functions
-- above take, so two concurrent withdrawals are checked one after the
-- other, then reads get_balance_for(), which already includes this row.
--
-- Scope: this guards withdrawals. Earnings can still fall after money was
-- withdrawn (an admin marks a settled payment invalid, or turns on hiding
-- small payments), which is an admin correction, not something to block.
--
-- Safe to re-run.
-- ============================================================

create or replace function public.guard_withdrawal_balance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_available numeric;
begin
  if new.status in ('rejected', 'failed') then return new; end if;
  if tg_op = 'UPDATE'
     and old.status not in ('rejected', 'failed')
     and new.user_id = old.user_id
     and new.amount_requested <= old.amount_requested then
    return new;
  end if;
  perform 1 from profiles where id = new.user_id for update;
  select b.available into v_available from get_balance_for(new.user_id) b;
  if v_available < 0 then
    raise exception 'Insufficient balance. Available: $%', round(v_available + new.amount_requested, 2);
  end if;
  return new;
end;
$$;

revoke all on function public.guard_withdrawal_balance() from public, anon, authenticated;

drop trigger if exists trg_withdrawal_balance_guard on public.withdrawals;
create trigger trg_withdrawal_balance_guard
  after insert or update of status, amount_requested, user_id on public.withdrawals
  for each row execute function public.guard_withdrawal_balance();
