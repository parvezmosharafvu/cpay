alter table public.webhook_events
  add column if not exists receipt_amount_sat bigint,
  add column if not exists settlement_outcome text;

alter table public.webhook_events
  drop constraint if exists webhook_events_receipt_amount_nonnegative,
  add constraint webhook_events_receipt_amount_nonnegative
    check (receipt_amount_sat is null or receipt_amount_sat >= 0);

create index if not exists idx_webhook_events_reconciliation
  on public.webhook_events(received_at desc)
  where event_type = 'breez.payment_received'
    and settlement_outcome in ('unknown', 'underpaid', 'overpaid', 'already_settled', 'not_settleable');

create or replace function public.prune_webhook_events()
returns integer
language sql
security definer
set search_path = public
as $$
  with deleted as (
    delete from webhook_events
    where received_at < now() - interval '90 days'
      and not (
        event_type = 'breez.payment_received'
        and settlement_outcome in ('unknown', 'underpaid', 'overpaid', 'already_settled', 'not_settleable')
      )
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
  v_outcome text;
begin
  if coalesce(p_breez_payment_id, '') = '' or p_amount_sat is null or p_amount_sat < 0 then
    raise exception 'settle_breez_payment: payment id and nonnegative amount are required';
  end if;

  insert into webhook_events(delivery_id, invoice_id, event_type, receipt_amount_sat)
  values ('breez:' || p_breez_payment_id, p_payment_hash, 'breez.payment_received', p_amount_sat)
  on conflict (delivery_id) do nothing;
  get diagnostics v_logged = row_count;
  if v_logged = 0 then
    return 'duplicate';
  end if;

  if p_payment_hash is null or p_payment_hash = '' then
    v_outcome := 'unknown';
  else
    update payments
       set status = 'settled', amount_settled = amount_requested, settled_at = now()
     where invoice_ref = p_payment_hash
       and status in ('new', 'pending', 'expired')
       and p_amount_sat >= amount_sat
    returning * into v_row;

    if found then
      v_outcome := case when p_amount_sat > v_row.amount_sat then 'overpaid' else 'settled' end;
      begin
        perform system_queue_withdrawal(v_row.user_id);
      exception when others then
        raise warning 'auto-queue failed for %: %', v_row.user_id, sqlerrm;
      end;
    else
      select * into v_row from payments where invoice_ref = p_payment_hash;
      if not found then
        v_outcome := 'unknown';
      elsif v_row.status = 'settled' then
        v_outcome := 'already_settled';
      elsif p_amount_sat < v_row.amount_sat then
        v_outcome := 'underpaid';
      else
        v_outcome := 'not_settleable';
      end if;
    end if;
  end if;

  update webhook_events
     set settlement_outcome = v_outcome
   where delivery_id = 'breez:' || p_breez_payment_id;
  return v_outcome;
end;
$$;

revoke all on function public.settle_breez_payment(text, text, bigint) from public, anon, authenticated;
grant execute on function public.settle_breez_payment(text, text, bigint) to service_role;

create or replace function public.admin_list_lightning_reconciliation(p_limit integer default 100)
returns table(
  received_at timestamptz,
  breez_payment_id text,
  payment_hash text,
  receipt_amount_sat bigint,
  settlement_outcome text,
  payment_id uuid,
  invoice_amount_sat bigint,
  payment_status text,
  amount_requested numeric,
  creator_email text
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;

  return query
  select e.received_at,
         substring(e.delivery_id from 7),
         e.invoice_id,
         e.receipt_amount_sat,
         e.settlement_outcome,
         p.id,
         p.amount_sat,
         p.status,
         p.amount_requested,
         pr.email
    from webhook_events e
    left join payments p on p.invoice_ref = e.invoice_id
    left join profiles pr on pr.id = p.user_id
   where e.event_type = 'breez.payment_received'
     and e.settlement_outcome in ('unknown', 'underpaid', 'overpaid', 'already_settled', 'not_settleable')
   order by e.received_at desc
   limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$$;

revoke all on function public.admin_list_lightning_reconciliation(integer) from public, anon;
grant execute on function public.admin_list_lightning_reconciliation(integer) to authenticated;
