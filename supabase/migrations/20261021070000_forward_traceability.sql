-- 20261021070000: forward traceability. Additive only.
--   1. Which saved row a forward used. Lightning forwards already store
--      payment_forwards.destination_id (settlement_destinations). USDT
--      forwards left it null because that column can only point at a
--      Lightning address row, so they now store usdt_wallet_id instead
--      (on payment_forwards and forward_batches), filled on insert.
--   2. forward_batches.spark_payment_id: the wallet's own payment id for the
--      send, recorded by the worker (system_usdt_batch_payment). payment_ref
--      is unchanged (an admin may still set it by hand).
--   3. audit_log rows: 'forward.created' for each forward and
--      'forward.batch_<outcome>' when a batch leaves 'sending'. Ids, amounts,
--      network and status only: no address, no secret.

-- 1. Columns -----------------------------------------------------------------
alter table public.payment_forwards add column if not exists usdt_wallet_id uuid references public.usdt_wallets(id) on delete set null;
alter table public.forward_batches  add column if not exists usdt_wallet_id uuid references public.usdt_wallets(id) on delete set null;
alter table public.forward_batches  add column if not exists spark_payment_id text;
comment on column public.payment_forwards.usdt_wallet_id is 'USDT forwards: the saved usdt_wallets row used (destination_id is for Lightning address rows).';
comment on column public.forward_batches.spark_payment_id is 'The wallet''s own payment id for this send, set by the worker once seen.';
create index if not exists payment_forwards_usdt_wallet_idx on public.payment_forwards (usdt_wallet_id) where usdt_wallet_id is not null;

-- Fill the saved-row id on insert, and when a forward joins a batch.
create or replace function public.forward_fill_destination()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.kind = 'usdt' and new.usdt_wallet_id is null then
    select w.id into new.usdt_wallet_id from usdt_wallets w where w.user_id = new.user_id and w.network = new.network;
  end if;
  if tg_op = 'UPDATE' and new.batch_id is not null and new.batch_id is distinct from old.batch_id then
    select coalesce(b.usdt_wallet_id, new.usdt_wallet_id) into new.usdt_wallet_id from forward_batches b where b.id = new.batch_id;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_payment_forwards_fill_destination on public.payment_forwards;
create trigger trg_payment_forwards_fill_destination before insert or update of batch_id on public.payment_forwards
  for each row execute function public.forward_fill_destination();

create or replace function public.forward_batch_fill_destination()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.usdt_wallet_id is null then
    select w.id into new.usdt_wallet_id from usdt_wallets w where w.user_id = new.user_id and w.network = new.network;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_forward_batches_fill_destination on public.forward_batches;
create trigger trg_forward_batches_fill_destination before insert on public.forward_batches
  for each row execute function public.forward_batch_fill_destination();

-- Backfill USDT rows that already exist (current saved wallet for that network).
-- Only rows that are not finished: payment_forwards_guard refuses any change
-- to a 'forwarded' or 'released' row, and that guard stays as it is.
update public.payment_forwards f set usdt_wallet_id = w.id
  from public.usdt_wallets w
 where f.kind = 'usdt' and f.usdt_wallet_id is null and f.status not in ('forwarded', 'released') and w.user_id = f.user_id and w.network = f.network
   and (f.address is null or f.address = w.address);
update public.forward_batches b set usdt_wallet_id = w.id
  from public.usdt_wallets w
 where b.usdt_wallet_id is null and w.user_id = b.user_id and w.network = b.network and w.address = b.address;

-- 2. Worker records the wallet payment id (set once, never overwritten) -----
create or replace function public.system_usdt_batch_payment(p_id uuid, p_spark_payment_id text)
returns void language sql security definer set search_path = public
as $$
  update forward_batches set spark_payment_id = left(btrim(p_spark_payment_id), 200), updated_at = now()
   where id = p_id and spark_payment_id is null and nullif(btrim(p_spark_payment_id), '') is not null
$$;
revoke all on function public.system_usdt_batch_payment(uuid, text) from public, anon, authenticated;
grant execute on function public.system_usdt_batch_payment(uuid, text) to service_role;

-- 3. Audit ---------------------------------------------------------------------
create or replace function public.forward_audit_created()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  perform record_audit('forward.created', 'payment_forward', new.id::text, null,
    jsonb_build_object('payment_id', new.payment_id, 'user_id', new.user_id, 'kind', new.kind, 'network', new.network,
      'destination_id', new.destination_id, 'usdt_wallet_id', new.usdt_wallet_id,
      'forward_sat', new.forward_sat, 'amount_usd', new.amount_usd, 'status', new.status, 'reason', new.reason),
    null);
  return new;
end;
$$;
drop trigger if exists trg_payment_forwards_audit_created on public.payment_forwards;
create trigger trg_payment_forwards_audit_created after insert on public.payment_forwards
  for each row execute function public.forward_audit_created();

create or replace function public.forward_batch_audit_finish()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if old.status = 'sending' and new.status <> 'sending' then
    perform record_audit('forward.batch_' || new.status, 'forward_batch', new.id::text,
      jsonb_build_object('status', old.status),
      jsonb_build_object('status', new.status, 'user_id', new.user_id, 'network', new.network, 'route_id', new.route_id,
        'usdt_wallet_id', new.usdt_wallet_id, 'amount_sat', new.amount_sat, 'amount_usd', new.amount_usd,
        'network_fee_usd', new.network_fee_usd, 'spark_payment_id', new.spark_payment_id,
        'forwards', (select count(*) from payment_forwards f where f.batch_id = new.id)),
      left(new.last_error, 200));
  end if;
  return new;
end;
$$;
drop trigger if exists trg_forward_batches_audit_finish on public.forward_batches;
create trigger trg_forward_batches_audit_finish after update of status on public.forward_batches
  for each row execute function public.forward_batch_audit_finish();

do $$ declare f text; begin
  foreach f in array array['forward_fill_destination()', 'forward_batch_fill_destination()', 'forward_audit_created()', 'forward_batch_audit_finish()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;
