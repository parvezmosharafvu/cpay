-- ============================================================
-- CPAY — 0094: Breez SDK Spark receive path
-- ============================================================
-- Invoices are now created by the cpay payment service (payment-service/,
-- a long-running Node process holding the one cpay Breez wallet). The flow:
--
--   1. create-invoice validates and prices, then inserts a payments row
--      (status 'new', no invoice yet).
--   2. The payment service quotes BTC/USD, creates a bolt11 for that row
--      and stores invoice_ref = payment hash, lightning_invoice = bolt11,
--      amount_sat and btc_usd_rate. The row exists before the invoice, so
--      a payment can never arrive for a row that is not there yet.
--   3. When Breez reports a received payment, the service calls
--      settle_breez_payment() below. It also calls it for every received
--      payment on startup and every few minutes (catch-up), so a replayed
--      or duplicate event must be harmless.
--
-- settle_breez_payment is the only code that credits a Breez payment.
-- Two gates stop a double credit, both inside one transaction:
--   * webhook_events.delivery_id is unique; the event is logged first,
--     keyed by the Breez payment id, and a repeat stops there.
--   * the update only matches a row that is not settled yet, so a second
--     Breez payment for the same hash credits nothing. The platform fee
--     trigger only fires on the transition to settled.
--
-- The reconcile edge function is removed: the service's catch-up replaces
-- it, so its daily cron job is unscheduled here.
--
-- Safe to re-run.
-- ============================================================

alter table payments add column if not exists amount_sat bigint;
alter table payments add column if not exists btc_usd_rate numeric;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payments_amount_sat_positive') then
    alter table payments add constraint payments_amount_sat_positive
      check (amount_sat is null or amount_sat > 0);
  end if;
end $$;

comment on column payments.amount_sat is
  'Sats the Lightning invoice asks for (Breez rows). Null on rows created before 0094.';
comment on column payments.btc_usd_rate is
  'BTC/USD rate the invoice was priced at: amount_sat = ceil(amount_requested / rate * 1e8).';

-- Outcomes: settled, duplicate (this Breez payment was seen before),
-- already_settled (another payment settled this hash first), unknown (no
-- row has this hash), underpaid (fewer sats than invoiced), not_settleable
-- (row is 'invalid': an admin decision this does not override).
create or replace function settle_breez_payment(
  p_breez_payment_id text,
  p_payment_hash text,
  p_amount_sat bigint
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_logged integer;
  v_row payments;
begin
  if coalesce(p_breez_payment_id, '') = '' or coalesce(p_payment_hash, '') = '' or p_amount_sat is null then
    raise exception 'settle_breez_payment: payment id, hash and amount are required';
  end if;

  insert into webhook_events(delivery_id, invoice_id, event_type)
  values ('breez:' || p_breez_payment_id, p_payment_hash, 'breez.payment_received')
  on conflict (delivery_id) do nothing;
  get diagnostics v_logged = row_count;
  if v_logged = 0 then
    return 'duplicate';
  end if;

  update payments
     set status = 'settled', amount_settled = amount_requested, settled_at = now()
   where invoice_ref = p_payment_hash
     and status in ('new', 'pending', 'expired')
     and p_amount_sat >= amount_sat
  returning * into v_row;

  if found then
    -- Same side effect the old provider webhook had. A failure here must
    -- not undo the settlement.
    begin
      perform system_queue_withdrawal(v_row.user_id);
    exception when others then
      raise warning 'auto-queue failed for %: %', v_row.user_id, sqlerrm;
    end;
    return 'settled';
  end if;

  select * into v_row from payments where invoice_ref = p_payment_hash;
  if not found then return 'unknown'; end if;
  if v_row.status = 'settled' then return 'already_settled'; end if;
  if p_amount_sat < v_row.amount_sat then return 'underpaid'; end if;
  return 'not_settleable';
end;
$$;

revoke all on function settle_breez_payment(text, text, bigint) from public, anon, authenticated;
grant execute on function settle_breez_payment(text, text, bigint) to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('cpay-reconcile')
    where exists (select 1 from cron.job where jobname = 'cpay-reconcile');
  end if;
end $$;
