-- Keep receipt_amount_sat and settlement_outcome in webhook_events so values
-- written by the earlier reconciliation function remain available as history.
-- The normal 90-day webhook retention policy continues to apply to those rows.

drop index if exists public.idx_webhook_events_reconciliation;
drop function if exists public.admin_list_lightning_reconciliation(integer);

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
  v_row public.payments;
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
