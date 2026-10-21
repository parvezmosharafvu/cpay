-- 20261021050000: BTCPay checkout. Switch defaults off; attach; settle is
-- recorded exactly like a wallet-settled payment (same fee, same balance,
-- auto-withdraw forward row); dedupe; unknown/mismatch/underpaid write
-- nothing; expired/invalid never touch a settled row; service_role only.
-- BEGIN/ROLLBACK.
\set ON_ERROR_STOP on
begin;
insert into auth.users(id, email) values
  ('e9000000-0000-0000-0000-0000000000a1', 'gw-one@test.invalid'),
  ('e9000000-0000-0000-0000-0000000000a2', 'gw-two@test.invalid');
update profiles set account_status = 'active' where id::text like 'e9000000-%';
insert into payment_links(id, user_id, slug) values
  ('e9000000-0000-0000-0000-0000000001a1', 'e9000000-0000-0000-0000-0000000000a1', 'gw-link-one'),
  ('e9000000-0000-0000-0000-0000000001a2', 'e9000000-0000-0000-0000-0000000000a2', 'gw-link-two');

create function pg_temp.newpay(p_id text, p_user text, p_link text, p_usd numeric) returns void language sql as $$
  insert into payments(id, user_id, payment_link_id, amount_requested, method, status, expires_at)
  values (p_id::uuid, p_user::uuid, p_link::uuid, p_usd, 'lightning', 'new', now() + interval '60 min')
$$;

-- 1. Switch is off by default and is in the settings catalogue.
do $$ begin
  if gateway_checkout_enabled() then raise exception 'btcpay_enabled must default to off'; end if;
  if not exists (select 1 from platform_setting_defaults() where key = 'btcpay_enabled' and kind = 'boolean' and dangerous) then
    raise exception 'btcpay_enabled missing from the catalogue';
  end if;
end $$;
insert into platform_settings(key, value) values ('btcpay_enabled', 'true');
do $$ begin if not gateway_checkout_enabled() then raise exception 'switch on not read'; end if; end $$;

-- 2. Control: a wallet-settled payment of $20 for user two.
select pg_temp.newpay('e9000000-0000-0000-0000-0000000002b0', 'e9000000-0000-0000-0000-0000000000a2', 'e9000000-0000-0000-0000-0000000001a2', 20);
update payments set status = 'settled', amount_settled = 20, amount_sat = 20000, settled_at = now() where id = 'e9000000-0000-0000-0000-0000000002b0';

-- 3. Attach, then settle a $20 BTCPay invoice for user one.
select pg_temp.newpay('e9000000-0000-0000-0000-0000000002a1', 'e9000000-0000-0000-0000-0000000000a1', 'e9000000-0000-0000-0000-0000000001a1', 20);
do $$ begin
  if not system_attach_gateway_invoice('e9000000-0000-0000-0000-0000000002a1', 'btcpay', 'INV-gw-1', 'lnbc200u1pgatewaytestinvoice0000') then raise exception 'attach failed'; end if;
  if system_attach_gateway_invoice('e9000000-0000-0000-0000-0000000002a1', 'btcpay', 'INV-gw-other') then raise exception 'second attach allowed'; end if;
  if system_settle_gateway_invoice('btcpay', 'INV-nope', null, 20, 1, 'BTC-LN') <> 'unknown' then raise exception 'unknown'; end if;
  if system_settle_gateway_invoice('btcpay', 'INV-gw-1', 'e9000000-0000-0000-0000-0000000002b0', 20, 1, 'BTC-LN') <> 'mismatch' then raise exception 'mismatch'; end if;
  if system_settle_gateway_invoice('btcpay', 'INV-gw-1', null, 19.99, 1, 'BTC-LN') <> 'underpaid' then raise exception 'underpaid'; end if;
  if exists (select 1 from webhook_events where delivery_id like 'gateway:%') then raise exception 'refused outcome wrote an event'; end if;
  if (select status from payments where id = 'e9000000-0000-0000-0000-0000000002a1') <> 'new' then raise exception 'refused outcome changed the row'; end if;
  if system_settle_gateway_invoice('btcpay', 'INV-gw-1', 'e9000000-0000-0000-0000-0000000002a1', 20.00, 20000, 'BTC-CHAIN') <> 'settled' then raise exception 'settle'; end if;
  if system_settle_gateway_invoice('btcpay', 'INV-gw-1', null, 20, 20000, 'BTC-CHAIN') <> 'already_settled' then raise exception 'replay'; end if;
  if (select count(*) from webhook_events where delivery_id = 'gateway:btcpay:INV-gw-1') <> 1 then raise exception 'dedupe row'; end if;
end $$;

-- 4. Same ledger result as the wallet-settled control.
do $$
declare g payments; c payments;
begin
  select * into g from payments where id = 'e9000000-0000-0000-0000-0000000002a1';
  select * into c from payments where id = 'e9000000-0000-0000-0000-0000000002b0';
  if g.status <> 'settled' or g.amount_settled <> 20 or g.settled_at is null then raise exception 'not settled like a wallet payment'; end if;
  if g.platform_fee_amount <> c.platform_fee_amount or g.platform_fee_percent <> c.platform_fee_percent then
    raise exception 'fee differs: % vs %', g.platform_fee_amount, c.platform_fee_amount;
  end if;
  if g.platform_fee_amount <= 0 then raise exception 'no platform fee stamped'; end if;
  if g.invoice_ref is not null or g.lightning_invoice <> 'lnbc200u1pgatewaytestinvoice0000' then raise exception 'bolt11 / invoice_ref wrong'; end if;
  if g.amount_sat <> 20000 or g.gateway_payment_method <> 'BTC-CHAIN' then raise exception 'sats/method not stored'; end if;
  if (select available from get_balance_for('e9000000-0000-0000-0000-0000000000a1'))
     <> (select available from get_balance_for('e9000000-0000-0000-0000-0000000000a2')) then
    raise exception 'balance differs from a wallet-settled payment';
  end if;
end $$;

-- 5. Auto withdraw ON: the settle gets a forward row, like any payment.
insert into platform_settings(key, value) values ('payment_mode', '"instant_forward"')
  on conflict (key) do update set value = excluded.value;
select system_set_settlement_destination('e9000000-0000-0000-0000-0000000000a1', 'gw@pay.example.com', 'pay.example.com', 1000, 100000000);
alter table settlement_destinations disable trigger trg_guard_settlement_destination_changes;
update settlement_destinations set ready_at = now() - interval '1 minute' where user_id = 'e9000000-0000-0000-0000-0000000000a1';
alter table settlement_destinations enable trigger trg_guard_settlement_destination_changes;
select pg_temp.newpay('e9000000-0000-0000-0000-0000000002a2', 'e9000000-0000-0000-0000-0000000000a1', 'e9000000-0000-0000-0000-0000000001a1', 10);
select system_attach_gateway_invoice('e9000000-0000-0000-0000-0000000002a2', 'btcpay', 'INV-gw-2');
select system_settle_gateway_invoice('btcpay', 'INV-gw-2', null, 10, 10000, 'BTC-LN');
do $$ begin
  if not exists (select 1 from payment_forwards where payment_id = 'e9000000-0000-0000-0000-0000000002a2') then
    raise exception 'auto withdraw did not apply to a BTCPay payment';
  end if;
end $$;

-- 6. Expired / invalid.
select pg_temp.newpay('e9000000-0000-0000-0000-0000000002a3', 'e9000000-0000-0000-0000-0000000000a1', 'e9000000-0000-0000-0000-0000000001a1', 5);
select system_attach_gateway_invoice('e9000000-0000-0000-0000-0000000002a3', 'btcpay', 'INV-gw-3');
do $$ begin
  if system_close_gateway_invoice('btcpay', 'INV-gw-3', 'expired') <> 'expired' then raise exception 'expire'; end if;
  if system_close_gateway_invoice('btcpay', 'INV-gw-1', 'invalid') <> 'unchanged' then raise exception 'invalid touched a settled row'; end if;
  -- A late payment on an expired invoice still settles (money arrived).
  if system_settle_gateway_invoice('btcpay', 'INV-gw-3', null, 5, 5000, 'BTC-LN') <> 'settled' then raise exception 'late settle'; end if;
end $$;

-- 7. Privileges: service_role only.
do $$
declare f text;
begin
  foreach f in array array['system_attach_gateway_invoice(uuid,text,text,text)', 'system_settle_gateway_invoice(text,text,uuid,numeric,bigint,text)',
                           'system_close_gateway_invoice(text,text,text)', 'gateway_checkout_enabled()'] loop
    if has_function_privilege('anon', 'public.' || f, 'execute') or has_function_privilege('authenticated', 'public.' || f, 'execute') then
      raise exception '% is callable by clients', f;
    end if;
    if not has_function_privilege('service_role', 'public.' || f, 'execute') then raise exception '% not granted to service_role', f; end if;
  end loop;
end $$;
rollback;
select 'gateway checkout tests passed' as result;
