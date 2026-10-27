-- CPAY — 20261027010000: Blink sweep (docs/BLINK-SWEEP.md).
-- BTCPay's Blink Lightning backend leaves payments in the owner's Blink USD
-- wallet. The blink-sweep Edge Function (pg_cron, every 10 minutes) moves
-- that balance into the primary CPAY wallet through the wallet's own
-- Lightning address. Off by default.
--
-- Adds: four settings (Admin → Settings → Blink sweep), the blink_sweeps
-- log, service-role functions for the Edge Function, an admin read RPC and
-- the cron job (skipped without pg_cron or the Vault secrets).
-- Rollback: select cron.unschedule('blink-sweep'); drop the functions and
-- table below; re-run 20261021080000's patch without the blink_sweep rows.

-- 1. Settings ------------------------------------------------------------------
do $do$
declare src text := pg_get_functiondef('public.platform_setting_defaults()'::regprocedure);
begin
  if src like '%blink_sweep_enabled%' then return; end if;
  if src not like '%Off = on-chain too'')%' then
    raise exception 'platform_setting_defaults: patch point not found';
  end if;
  src := replace(src, $r$Off = on-chain too')$r$,
    $r$Off = on-chain too'),
  ('blink_sweep_enabled',           'false'::jsonb, 'boolean', true,  'Blink sweep: move the Blink USD balance into the primary CPAY wallet every 10 minutes'),
  ('blink_sweep_keep_usd',          '0'::jsonb,     'money',   false, 'Blink sweep: USD to leave in Blink'),
  ('blink_sweep_min_usd',           '5'::jsonb,     'money',   false, 'Blink sweep: smallest move (USD)'),
  ('blink_sweep_max_usd',           '200'::jsonb,   'money',   true,  'Blink sweep: largest move each time (USD)')$r$);
  execute src;
end $do$;
revoke all on function public.platform_setting_defaults() from public, anon;
grant execute on function public.platform_setting_defaults() to authenticated, service_role;

-- 2. The log -------------------------------------------------------------------
create table if not exists public.blink_sweeps (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status text not null default 'sending' check (status in ('sending', 'pending', 'sent', 'failed', 'unknown')),
  amount_cents integer not null check (amount_cents > 0),
  amount_sat bigint not null check (amount_sat > 0),
  destination text not null,
  blink_wallet_id text not null,
  bolt11 text not null,
  payment_hash text not null,
  invoice_expires_at timestamptz not null,
  error text
);
-- At most one sweep in flight: a second run cannot start another.
create unique index if not exists blink_sweeps_one_open on public.blink_sweeps ((true)) where status in ('sending', 'pending');
create unique index if not exists blink_sweeps_payment_hash on public.blink_sweeps (payment_hash);
alter table public.blink_sweeps enable row level security;
revoke all on public.blink_sweeps from public, anon, authenticated;

-- 3. For the Edge Function (service_role only) --------------------------------
-- The destination is the primary active CPAY wallet's own Lightning address,
-- read from the Breez SDK's settings. It cannot be typed in anywhere.
create or replace function public.system_blink_sweep_config()
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare v_dest text;
begin
  if to_regclass('breez_wallet.brz_settings') is not null and to_regclass('breez_wallet.wallets') is not null then
    begin
      execute $q$
        select (s.value::jsonb) #>> '{address,lightning_address}'
          from breez_wallet.wallets w
          join breez_wallet.brz_settings s on encode(s.user_id, 'hex') = w.node_pubkey and s.key = 'lightning_address'
         where w.is_primary and w.status = 'active'
         limit 1 $q$ into v_dest;
    exception when others then v_dest := null;
    end;
  end if;
  return jsonb_build_object(
    'enabled', coalesce(platform_setting('blink_sweep_enabled') = 'true'::jsonb, false),
    'keep_usd', platform_setting('blink_sweep_keep_usd'),
    'min_usd', platform_setting('blink_sweep_min_usd'),
    'max_usd', platform_setting('blink_sweep_max_usd'),
    'destination', v_dest);
end $$;

create or replace function public.system_blink_sweep_open()
returns jsonb language sql stable security definer set search_path = public
as $$
  select to_jsonb(b) - 'error' from public.blink_sweeps b where status in ('sending', 'pending') order by created_at limit 1
$$;

create or replace function public.system_blink_sweep_begin(
  p_amount_cents integer, p_amount_sat bigint, p_destination text, p_blink_wallet_id text,
  p_bolt11 text, p_payment_hash text, p_invoice_expires_at timestamptz)
returns uuid language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  insert into public.blink_sweeps (amount_cents, amount_sat, destination, blink_wallet_id, bolt11, payment_hash, invoice_expires_at)
  values (p_amount_cents, p_amount_sat, p_destination, p_blink_wallet_id, p_bolt11, p_payment_hash, p_invoice_expires_at)
  returning id into v_id;
  return v_id;
exception when unique_violation then
  return null;
end $$;

create or replace function public.system_blink_sweep_finish(p_id uuid, p_status text, p_error text)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if p_status not in ('pending', 'sent', 'failed', 'unknown') then raise exception 'bad status %', p_status; end if;
  update public.blink_sweeps
     set status = p_status, error = left(p_error, 300), updated_at = now()
   where id = p_id and status in ('sending', 'pending');
end $$;

revoke all on function public.system_blink_sweep_config() from public, anon, authenticated;
revoke all on function public.system_blink_sweep_open() from public, anon, authenticated;
revoke all on function public.system_blink_sweep_begin(integer, bigint, text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.system_blink_sweep_finish(uuid, text, text) from public, anon, authenticated;
grant execute on function public.system_blink_sweep_config() to service_role;
grant execute on function public.system_blink_sweep_open() to service_role;
grant execute on function public.system_blink_sweep_begin(integer, bigint, text, text, text, text, timestamptz) to service_role;
grant execute on function public.system_blink_sweep_finish(uuid, text, text) to service_role;

-- 4. Admin read (Admin → Settings → Blink sweep) ------------------------------
-- {destination: the address the next sweep pays (null = none), rows: [...]}.
-- No invoices or Blink wallet ids leave the database.
create or replace function public.admin_blink_sweeps(p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  return jsonb_build_object(
    'destination', public.system_blink_sweep_config() ->> 'destination',
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', b.id, 'created_at', b.created_at, 'updated_at', b.updated_at, 'status', b.status,
               'amount_cents', b.amount_cents, 'amount_sat', b.amount_sat, 'destination', b.destination,
               'payment_hash', b.payment_hash, 'error', b.error) order by b.created_at desc)
        from (select * from public.blink_sweeps order by created_at desc
               limit least(greatest(coalesce(p_limit, 20), 1), 100)) b), '[]'::jsonb));
end $$;
revoke all on function public.admin_blink_sweeps(integer) from public, anon;
grant execute on function public.admin_blink_sweeps(integer) to authenticated, service_role;

-- 5. Every 10 minutes ----------------------------------------------------------
-- The function does nothing while blink_sweep_enabled is off or BLINK_API_KEY
-- is not set, so scheduling it is harmless.
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron not installed — skipping blink-sweep schedule.';
    return;
  end if;
  if (select count(*) from vault.decrypted_secrets where name in ('cpay_functions_url', 'cpay_cron_secret')) < 2 then
    raise notice 'Vault secrets cpay_functions_url/cpay_cron_secret missing — skipping blink-sweep schedule.';
    return;
  end if;
  perform cron.unschedule('blink-sweep') where exists (select 1 from cron.job where jobname = 'blink-sweep');
  perform cron.schedule('blink-sweep', '*/10 * * * *', $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'cpay_functions_url') || '/functions/v1/blink-sweep',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cpay_cron_secret')),
      timeout_milliseconds := 60000)
  $job$);
end $$;
