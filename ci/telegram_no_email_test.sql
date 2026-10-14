-- 20261014070000: a settled-payment Telegram message never names the
-- account by its email. BEGIN/ROLLBACK.
\set ON_ERROR_STOP on
begin;
insert into auth.users(id, email) values
  ('9e000000-0000-0000-0000-0000000000f1', 'secret-person@test.invalid'),
  ('9e000000-0000-0000-0000-0000000000f2', 'second-person@test.invalid');
update profiles set account_status = 'active', role = 'creator', display_name = null, public_slug = null
 where id = '9e000000-0000-0000-0000-0000000000f1';
update profiles set account_status = 'active', role = 'creator', display_name = '', public_slug = 'kiosk-two'
 where id = '9e000000-0000-0000-0000-0000000000f2';
insert into payments(user_id, invoice_ref, lightning_invoice, amount_requested, amount_sat, btc_usd_rate, status, expires_at) values
  ('9e000000-0000-0000-0000-0000000000f1', 'tgmail-1', 'lnbcrt1tgmail1', 20.00, 20000, 100000, 'new', now() + interval '1 hour'),
  ('9e000000-0000-0000-0000-0000000000f2', 'tgmail-2', 'lnbcrt1tgmail2', 20.00, 20000, 100000, 'new', now() + interval '1 hour');
do $$
declare n1 text; n2 text;
begin
  if settle_breez_payment('tgmail-b1', 'tgmail-1', 20000) <> 'settled' then raise exception 'setup: settle 1'; end if;
  if settle_breez_payment('tgmail-b2', 'tgmail-2', 20000) <> 'settled' then raise exception 'setup: settle 2'; end if;
  select o.payload->>'owner_name' into n1 from telegram_outbox o join payments p on p.id::text = o.ref where p.invoice_ref = 'tgmail-1';
  select o.payload->>'owner_name' into n2 from telegram_outbox o join payments p on p.id::text = o.ref where p.invoice_ref = 'tgmail-2';
  if n1 is null or n2 is null then raise exception 'messages not queued: % / %', n1, n2; end if;
  if position('@' in n1) > 0 or position('@' in n2) > 0 then raise exception 'email in Telegram name: % / %', n1, n2; end if;
  if n1 <> 'account 9e000000' then raise exception 'no-name fallback: %', n1; end if;
  if n2 <> 'kiosk-two' then raise exception 'store-name fallback: %', n2; end if;
end $$;
\echo 'telegram never names an account by email: PASS'
rollback;
