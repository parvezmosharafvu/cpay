-- Enforce the payment status transitions in docs/PAYMENT-STATES.md.
-- Owner decision 2026-10-13: only an admin may reverse a settled payment.
--
-- Always allowed (every production writer):
--   new -> pending | expired | settled | invalid
--   pending -> expired | settled | invalid
--   expired -> settled (late payment: settle_breez_payment) | invalid
--   same status -> same status (idempotent no-op updates)
-- Admin context only (is_admin() JWT, or a server role that set
-- cpay.payment_admin_context = 'on' for the transaction):
--   settled -> invalid (reversal), invalid -> settled | expired
-- Never: anything -> new, -> pending from anything but new, settled ->
--   new | pending | expired.
-- Forward-only, BEFORE UPDATE OF status, no data change. It only ever
-- raises on an update that changes status, so settle_breez_payment()'s
-- guarded update (new/pending/expired -> settled) can never be refused.
create or replace function public.enforce_payment_status_transition()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  v_admin boolean;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if (old.status = 'new' and new.status in ('pending', 'expired', 'settled', 'invalid'))
     or (old.status = 'pending' and new.status in ('expired', 'settled', 'invalid'))
     or (old.status = 'expired' and new.status in ('settled', 'invalid')) then
    return new;
  end if;
  if (old.status = 'settled' and new.status = 'invalid')
     or (old.status = 'invalid' and new.status in ('settled', 'expired')) then
    v_admin := coalesce(public.is_admin(), false)
      or (coalesce(current_setting('cpay.payment_admin_context', true), '') = 'on'
          and current_user not in ('anon', 'authenticated'));
    if v_admin then
      return new;
    end if;
    raise exception 'payment %: % -> % needs an admin', old.id, old.status, new.status
      using errcode = 'insufficient_privilege';
  end if;
  raise exception 'payment %: invalid status transition % -> %', old.id, old.status, new.status
    using errcode = 'check_violation';
end;
$$;
revoke all on function public.enforce_payment_status_transition() from public, anon, authenticated;

drop trigger if exists payments_status_transition on public.payments;
create trigger payments_status_transition
  before update of status on public.payments
  for each row execute function public.enforce_payment_status_transition();
