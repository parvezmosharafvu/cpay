-- ============================================================
-- 20261014050000: the 24-hour address wait holds on every payout path
-- ============================================================
-- Before this migration only the payment service checked the wait, on the
-- instant path. Auto-queue (system_queue_withdrawal) and admin-submitted
-- payouts (admin_request_withdrawal_for) took the saved address at once,
-- BEGIN/ROLLBACK.
\set ON_ERROR_STOP on
begin;
create or replace function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

insert into auth.users(id, email) values
  ('8c000000-0000-0000-0000-0000000000f1', 'cool-all-f@test.invalid'),
  ('8c000000-0000-0000-0000-0000000000a1', 'cool-all-a@test.invalid');
update profiles set account_status = 'active', role = 'creator', withdrawal_fee_percent = 0,
       auto_withdraw_enabled = true, withdraw_threshold = 5, preferred_usdt_network = 'tron'
 where id = '8c000000-0000-0000-0000-0000000000f1';
update profiles set account_status = 'active', role = 'admin' where id = '8c000000-0000-0000-0000-0000000000a1';

-- $20 settled for the freelancer.
insert into payments(user_id, invoice_ref, lightning_invoice, amount_requested, amount_sat, btc_usd_rate, status, expires_at)
values ('8c000000-0000-0000-0000-0000000000f1', 'coolall-ref', 'lnbcrt1coolall', 20.00, 20000, 100000, 'new', now() + interval '1 hour');
do $$ begin
  if settle_breez_payment('coolall-bid', 'coolall-ref', 20000) <> 'settled' then raise exception 'setup: settle failed'; end if;
end $$;

-- A just-saved address (as after an account takeover): cooling down.
insert into usdt_wallets(user_id, network, address)
values ('8c000000-0000-0000-0000-0000000000f1', 'tron', 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL');

do $$
declare u uuid := '8c000000-0000-0000-0000-0000000000f1'; v uuid;
begin
  -- 1. auto-queue does not use it
  v := system_queue_withdrawal(u);
  if v is not null or exists (select 1 from withdrawals where user_id = u) then
    raise exception 'auto-queue used an address still in its wait';
  end if;
  raise notice 'ok: auto-queue skips an address still in its wait';
end $$;

-- 2. admin-submitted payout refuses it too
select set_config('request.jwt.claim.sub', '8c000000-0000-0000-0000-0000000000a1', true);
set local role authenticated;
do $$ begin
  begin
    perform admin_request_withdrawal_for('8c000000-0000-0000-0000-0000000000f1', 5, 'tron', '');
    raise exception 'admin payout used a cooling address';
  exception when others then
    if sqlerrm not ilike '%24-hour safety wait%' then raise; end if;
  end;
  raise notice 'ok: admin payout refuses an address still in its wait';
end $$;
reset role;

-- 25 hours later (clock moved on the row with triggers off): every path works again.
set local session_replication_role = replica;
update usdt_wallets set usable_after = now() - interval '1 hour' where user_id = '8c000000-0000-0000-0000-0000000000f1';
set local session_replication_role = origin;

do $$
declare u uuid := '8c000000-0000-0000-0000-0000000000f1'; v uuid; r withdrawals;
begin
  v := system_queue_withdrawal(u);
  if v is null then raise exception 'auto-queue refused an aged address with money left'; end if;
  if (select destination from withdrawals where id = v) <> 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL' then raise exception 'auto-queue destination wrong'; end if;
  if (select available from get_balance_for(u)) < 0 then raise exception 'available went negative'; end if;
  -- admin payout works again too (balance left after the auto-queue is 0, so expect the balance refusal, not the wait)
  begin
    perform set_config('request.jwt.claim.sub', '8c000000-0000-0000-0000-0000000000a1', true);
    r := admin_request_withdrawal_for(u, 5, 'tron', '');
    raise exception 'admin payout over the remaining balance was accepted';
  exception when others then
    if sqlerrm not ilike 'Insufficient balance%' then raise; end if;
  end;
  raise notice 'ok: an aged address works on auto-queue; admin payout reaches the balance check; balance stays >= 0';
end $$;
\echo 'withdraw cooldown on all paths: PASS'
rollback;
