begin;

alter table public.webhook_events
  add column if not exists receipt_amount_sat bigint,
  add column if not exists settlement_outcome text;

insert into public.webhook_events(
  delivery_id, invoice_id, event_type, receipt_amount_sat, settlement_outcome
)
values (
  'lightning-receipt-rollback-test', 'review-hash', 'breez.payment_received', 1015, 'underpaid'
);

\i supabase/migrations/20261003020000_restore_lightning_receipt_behavior.sql

do $$
declare
  v_amount bigint;
  v_outcome text;
  v_settle_function text;
  v_prune_function text;
begin
  if to_regprocedure('public.admin_list_lightning_reconciliation(integer)') is not null then
    raise exception 'reconciliation RPC was not removed';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'webhook_events'
      and column_name in ('receipt_amount_sat', 'settlement_outcome')
  ) then
    raise exception 'temporary reconciliation columns remain';
  end if;
  if has_table_privilege('anon', 'public.lightning_receipt_reconciliation_archive', 'select')
     or has_table_privilege('authenticated', 'public.lightning_receipt_reconciliation_archive', 'select')
     or has_table_privilege('service_role', 'public.lightning_receipt_reconciliation_archive', 'select') then
    raise exception 'receipt archive is exposed to an API role';
  end if;

  select receipt_amount_sat, settlement_outcome into v_amount, v_outcome
    from public.lightning_receipt_reconciliation_archive
   where delivery_id = 'lightning-receipt-rollback-test';
  if v_amount <> 1015 or v_outcome <> 'underpaid' then
    raise exception 'receipt metadata was not archived';
  end if;

  v_settle_function := pg_get_functiondef('public.settle_breez_payment(text,text,bigint)'::regprocedure);
  v_prune_function := pg_get_functiondef('public.prune_webhook_events()'::regprocedure);
  if position('receipt_amount_sat' in v_settle_function) > 0
     or position('settlement_outcome' in v_settle_function) > 0
     or position('settlement_outcome' in v_prune_function) > 0 then
    raise exception 'reconciliation function definitions remain active';
  end if;
end $$;

rollback;
