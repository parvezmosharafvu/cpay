-- CPAY — 20261021050000: BTCPay Server checkout (docs/BTCPAY.md).
--
-- When the owner turns on the Admin → Settings switch `btcpay_enabled`
-- (default OFF, so applying this changes nothing), create-invoice makes the
-- payer's invoice on the owner's BTCPay Server ('cpay' store, Greenfield API)
-- instead of the CPAY wallet. The btcpay-webhook Edge Function then records
-- the settled invoice here, into the same payments row, exactly like a
-- wallet-settled payment: status 'settled', amount_settled = amount_requested,
-- the platform fee stamped by the existing settle trigger, then the existing
-- auto-withdraw trigger (payment_mode_for: global switch + per-profile
-- override) forwards the net, or it stays in the CPAY balance.
--
-- Nothing here sends money. BTCPay only receives; every send stays in the
-- CPAY wallet / payment-service.
--
-- Database objects use the neutral word "gateway" (CI keeps the schema free
-- of objects named after the pre-2026 integration that was removed).
--
--   payments.gateway                 'btcpay' for BTCPay invoices, else null
--   payments.gateway_invoice_id      the BTCPay invoice id (unique)
--   payments.gateway_payment_method  e.g. 'BTC-LN' or 'BTC-CHAIN' (on settle)
--   gateway_checkout_enabled()       the btcpay_enabled switch
--   system_attach_gateway_invoice()  create-invoice links the BTCPay invoice
--   system_settle_gateway_invoice()  btcpay-webhook records a settled invoice
--   system_close_gateway_invoice()   btcpay-webhook: expired / invalid
-- All three system_* functions are service_role only.
--
-- Rollback (only while no gateway rows exist): drop the three functions and
-- gateway_checkout_enabled(); drop the three columns; re-run
-- 20261020030000's platform_setting_defaults() to drop the btcpay_enabled row.

-- 1. The switch -------------------------------------------------------------
do $do$
declare src text := pg_get_functiondef('public.platform_setting_defaults()'::regprocedure);
begin
  if src like '%btcpay_enabled%' then return; end if;
  if src not like '%''CPAY Wallet address (https)'')%' then
    raise exception 'platform_setting_defaults: patch point not found';
  end if;
  src := replace(src, $r$'CPAY Wallet address (https)')$r$,
    $r$'CPAY Wallet address (https)'),
  ('btcpay_enabled',                'false'::jsonb, 'boolean', true,  'BTCPay Server: new invoices are made on the BTCPay cpay store (Lightning + on-chain)')$r$);
  execute src;
end $do$;
revoke all on function public.platform_setting_defaults() from public, anon;
grant execute on function public.platform_setting_defaults() to authenticated, service_role;

create or replace function public.gateway_checkout_enabled()
returns boolean language sql stable security definer set search_path = public
as $$ select coalesce(platform_setting('btcpay_enabled') = 'true'::jsonb, false) $$;
revoke all on function public.gateway_checkout_enabled() from public, anon, authenticated;
grant execute on function public.gateway_checkout_enabled() to service_role;

-- 2. Columns ------------------------------------------------------------------
alter table public.payments
  add column if not exists gateway text,
  add column if not exists gateway_invoice_id text,
  add column if not exists gateway_payment_method text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'payments_gateway_check') then
    alter table public.payments add constraint payments_gateway_check
      check (gateway is null or gateway = 'btcpay');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'payments_gateway_invoice_check') then
    alter table public.payments add constraint payments_gateway_invoice_check
      check ((gateway is null) = (gateway_invoice_id is null)
             and (gateway_invoice_id is null or gateway_invoice_id ~ '^[A-Za-z0-9_-]{1,64}$')
             and (gateway_payment_method is null or gateway_payment_method ~ '^[A-Za-z0-9_-]{1,32}$'));
  end if;
end $$;
create unique index if not exists payments_gateway_invoice_uidx
  on public.payments (gateway, gateway_invoice_id) where gateway_invoice_id is not null;

-- 3. Attach (create-invoice) ------------------------------------------------
-- p_bolt11 (optional) is BTCPay's Lightning invoice, kept in
-- lightning_invoice so the pay page can redraw the QR on another device.
-- invoice_ref stays null: only the BTCPay webhook can settle this row.
create or replace function public.system_attach_gateway_invoice(p_payment_id uuid, p_gateway text, p_invoice_id text, p_bolt11 text default null)
returns boolean language plpgsql security definer set search_path = public
as $$
declare n integer;
begin
  if p_gateway is distinct from 'btcpay' then raise exception 'unknown gateway'; end if;
  if p_bolt11 is not null and (p_bolt11 !~ '^ln[a-z0-9]+$' or length(p_bolt11) not between 20 and 4000) then raise exception 'invalid Lightning invoice'; end if;
  update payments set gateway = p_gateway, gateway_invoice_id = p_invoice_id, lightning_invoice = p_bolt11
   where id = p_payment_id and status = 'new'
     and gateway_invoice_id is null and lightning_invoice is null and invoice_ref is null;
  get diagnostics n = row_count;
  return n = 1;
end $$;
revoke all on function public.system_attach_gateway_invoice(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.system_attach_gateway_invoice(uuid, text, text, text) to service_role;

-- 4. Settle (btcpay-webhook, after it re-fetched the invoice from BTCPay) ---
-- Outcomes: settled | already_settled | duplicate | unknown | mismatch |
-- underpaid | not_settleable. 'unknown' writes nothing, so the webhook can
-- answer 404 and BTCPay retries. Dedupe is per invoice (webhook_events
-- delivery 'gateway:btcpay:<invoice id>'), on top of the row lock.
create or replace function public.system_settle_gateway_invoice(
  p_gateway text, p_invoice_id text, p_payment_id uuid,
  p_paid_usd numeric, p_amount_sat bigint, p_payment_method text
) returns text language plpgsql security definer set search_path = public
as $$
declare v payments; n integer;
begin
  if p_gateway is distinct from 'btcpay' or coalesce(p_invoice_id, '') = '' or p_paid_usd is null then
    raise exception 'system_settle_gateway_invoice: gateway, invoice id and amount are required';
  end if;
  select * into v from payments
   where gateway = p_gateway and gateway_invoice_id = p_invoice_id for update;
  if not found then return 'unknown'; end if;
  if p_payment_id is not null and v.id <> p_payment_id then return 'mismatch'; end if;
  if v.status = 'settled' then return 'already_settled'; end if;
  if v.status not in ('new', 'pending', 'expired') then return 'not_settleable'; end if;
  if p_paid_usd < v.amount_requested then return 'underpaid'; end if;

  insert into webhook_events(delivery_id, invoice_id, event_type)
  values ('gateway:' || p_gateway || ':' || p_invoice_id, p_invoice_id, 'gateway.invoice_settled')
  on conflict (delivery_id) do nothing;
  get diagnostics n = row_count;
  if n = 0 then return 'duplicate'; end if;

  update payments
     set status = 'settled', amount_settled = amount_requested, settled_at = now(),
         amount_sat = case when coalesce(p_amount_sat, 0) > 0 then p_amount_sat else amount_sat end,
         gateway_payment_method = nullif(left(regexp_replace(coalesce(p_payment_method, ''), '[^A-Za-z0-9_-]', '', 'g'), 32), '')
   where id = v.id;
  begin
    perform system_queue_withdrawal(v.user_id);
  exception when others then
    raise warning 'auto-queue failed for %: %', v.user_id, sqlerrm;
  end;
  return 'settled';
end $$;
revoke all on function public.system_settle_gateway_invoice(text, text, uuid, numeric, bigint, text) from public, anon, authenticated;
grant execute on function public.system_settle_gateway_invoice(text, text, uuid, numeric, bigint, text) to service_role;

-- 5. Expired / invalid (never touches a settled row) ------------------------
create or replace function public.system_close_gateway_invoice(p_gateway text, p_invoice_id text, p_status text)
returns text language plpgsql security definer set search_path = public
as $$
declare v payments;
begin
  if p_status not in ('expired', 'invalid') then raise exception 'status must be expired or invalid'; end if;
  select * into v from payments where gateway = p_gateway and gateway_invoice_id = p_invoice_id for update;
  if not found then return 'unknown'; end if;
  if v.status not in ('new', 'pending') then return 'unchanged'; end if;
  update payments set status = p_status where id = v.id;
  return p_status;
end $$;
revoke all on function public.system_close_gateway_invoice(text, text, text) from public, anon, authenticated;
grant execute on function public.system_close_gateway_invoice(text, text, text) to service_role;
