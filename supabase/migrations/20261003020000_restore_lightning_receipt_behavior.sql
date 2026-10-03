-- Keep the 20261003010000 migration in history for databases that already ran
-- it. Archive its receipt details before removing the temporary columns, so
-- existing receipt history survives the rollback of the reconciliation API.

create table if not exists public.lightning_receipt_reconciliation_archive (
  webhook_event_id bigint primary key,
  delivery_id text not null unique,
  invoice_id text,
  event_type text,
  received_at timestamptz not null,
  receipt_amount_sat bigint check (receipt_amount_sat is null or receipt_amount_sat >= 0),
  settlement_outcome text,
  archived_at timestamptz not null default now()
);

alter table public.lightning_receipt_reconciliation_archive enable row level security;
revoke all on table public.lightning_receipt_reconciliation_archive from public, anon, authenticated, service_role;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'webhook_events'
      and column_name = 'receipt_amount_sat'
  ) and exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'webhook_events'
      and column_name = 'settlement_outcome'
  ) then
    insert into public.lightning_receipt_reconciliation_archive (
      webhook_event_id, delivery_id, invoice_id, event_type, received_at,
      receipt_amount_sat, settlement_outcome
    )
    select id, delivery_id, invoice_id, event_type, received_at,
           receipt_amount_sat, settlement_outcome
      from public.webhook_events
     where receipt_amount_sat is not null or settlement_outcome is not null
    on conflict (delivery_id) do update
      set webhook_event_id = excluded.webhook_event_id,
          invoice_id = excluded.invoice_id,
          event_type = excluded.event_type,
          received_at = excluded.received_at,
          receipt_amount_sat = excluded.receipt_amount_sat,
          settlement_outcome = excluded.settlement_outcome;
  end if;
end $$;

create or replace function public.prune_webhook_events()
returns integer
language sql
security definer
set search_path = public
as $$
  with deleted as (
    delete from webhook_events
    where received_at < now() - interval '90 days'
    returning 1
  )
  select count(*)::integer from deleted;
$$;

revoke all on function public.prune_webhook_events() from public, anon, authenticated;
grant execute on function public.prune_webhook_events() to service_role;

create or replace function public.settle_breez_payment(
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

revoke all on function public.settle_breez_payment(text, text, bigint) from public, anon, authenticated;
grant execute on function public.settle_breez_payment(text, text, bigint) to service_role;

drop function if exists public.admin_list_lightning_reconciliation(integer);

drop index if exists public.idx_webhook_events_reconciliation;

alter table public.webhook_events
  drop constraint if exists webhook_events_receipt_amount_nonnegative,
  drop column if exists receipt_amount_sat,
  drop column if exists settlement_outcome;
