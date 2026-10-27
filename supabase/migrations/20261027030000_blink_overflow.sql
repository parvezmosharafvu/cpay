-- CPAY — 20261027030000: Blink sweep overflow (docs/BLINK-SWEEP.md).
-- BTCPay pays into one Blink account. When that account hits Blink's
-- 24-hour withdrawal limit, blink-sweep can send its USD to another of the
-- owner's Blink accounts that still has withdrawal limit left
-- (Blink-to-Blink, a separate Blink limit); that account then moves it to
-- the CPAY wallet. Off by default. Builds on 20261027020000.
--
-- Adds: setting blink_sweep_overflow_enabled, the blink_overflows log,
-- service-role functions for it, 'overflow' in system_blink_sweep_config()
-- and 'overflows' in admin_blink_sweeps().
-- Rollback: drop blink_overflows and the two functions, re-run
-- 20261027020000 §4 and 20261027010000 §3 (system_blink_sweep_config),
-- re-run 20261021080000's patch without the blink_sweep_overflow row.

-- 1. Setting --------------------------------------------------------------------
do $do$
declare src text := pg_get_functiondef('public.platform_setting_defaults()'::regprocedure);
begin
  if src like '%blink_sweep_overflow_enabled%' then return; end if;
  if src not like '%Blink sweep: largest move each time (USD)'')%' then
    raise exception 'platform_setting_defaults: patch point not found';
  end if;
  src := replace(src, $r$Blink sweep: largest move each time (USD)')$r$,
    $r$Blink sweep: largest move each time (USD)'),
  ('blink_sweep_overflow_enabled',  'false'::jsonb, 'boolean', true,  'Blink sweep: when a Blink account reaches its daily withdrawal limit, send its USD to another Blink account with limit left')$r$);
  execute src;
end $do$;
revoke all on function public.platform_setting_defaults() from public, anon;
grant execute on function public.platform_setting_defaults() to authenticated, service_role;

-- 2. The log ---------------------------------------------------------------------
create table if not exists public.blink_overflows (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  from_account text not null check (from_account ~ '^[1-9][0-9]?$'),
  to_account text not null check (to_account ~ '^[1-9][0-9]?$'),
  amount_cents integer not null check (amount_cents > 0),
  status text not null default 'sending' check (status in ('sending', 'sent', 'failed', 'unknown')),
  error text,
  check (from_account <> to_account)
);
create index if not exists blink_overflows_from_created on public.blink_overflows (from_account, created_at desc);
alter table public.blink_overflows enable row level security;
revoke all on public.blink_overflows from public, anon, authenticated;

-- 3. For the Edge Function (service_role only) --------------------------------
-- begin refuses (null) while a transfer from the same account was recorded
-- in the last 5 minutes, so two overlapping runs cannot both send.
create or replace function public.system_blink_overflow_begin(p_from text, p_to text, p_amount_cents integer)
returns uuid language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('blink_overflow:' || coalesce(p_from, '')));
  if exists (select 1 from public.blink_overflows where from_account = p_from and created_at > now() - interval '5 minutes') then
    return null;
  end if;
  insert into public.blink_overflows (from_account, to_account, amount_cents)
  values (p_from, p_to, p_amount_cents)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.system_blink_overflow_finish(p_id uuid, p_status text, p_error text)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if p_status not in ('sent', 'failed', 'unknown') then raise exception 'bad status %', p_status; end if;
  update public.blink_overflows
     set status = p_status, error = left(p_error, 300), updated_at = now()
   where id = p_id and status = 'sending';
end $$;

revoke all on function public.system_blink_overflow_begin(text, text, integer) from public, anon, authenticated;
revoke all on function public.system_blink_overflow_finish(uuid, text, text) from public, anon, authenticated;
grant execute on function public.system_blink_overflow_begin(text, text, integer) to service_role;
grant execute on function public.system_blink_overflow_finish(uuid, text, text) to service_role;

-- 4. Config: + overflow ------------------------------------------------------------
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
    'overflow', coalesce(platform_setting('blink_sweep_overflow_enabled') = 'true'::jsonb, false),
    'keep_usd', platform_setting('blink_sweep_keep_usd'),
    'min_usd', platform_setting('blink_sweep_min_usd'),
    'max_usd', platform_setting('blink_sweep_max_usd'),
    'destination', v_dest);
end $$;
revoke all on function public.system_blink_sweep_config() from public, anon, authenticated;
grant execute on function public.system_blink_sweep_config() to service_role;

-- 5. Admin read: + overflows ---------------------------------------------------------
create or replace function public.admin_blink_sweeps(p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  return jsonb_build_object(
    'destination', public.system_blink_sweep_config() ->> 'destination',
    'accounts', coalesce((
      select jsonb_agg(jsonb_build_object(
               'account', a.account, 'checked_at', a.checked_at, 'balance_cents', a.balance_cents,
               'can_send', a.can_send, 'withdraw_remaining_cents', a.withdraw_remaining_cents, 'result', a.result,
               'sent_24h_cents', (select coalesce(sum(b.amount_cents), 0) from public.blink_sweeps b
                                   where b.account = a.account and b.status in ('sent', 'sending', 'pending')
                                     and b.created_at > now() - interval '24 hours'))
             order by a.account::int)
        from public.blink_sweep_accounts a where a.checked_at > now() - interval '1 day'), '[]'::jsonb),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', b.id, 'account', b.account, 'created_at', b.created_at, 'updated_at', b.updated_at, 'status', b.status,
               'amount_cents', b.amount_cents, 'amount_sat', b.amount_sat, 'destination', b.destination,
               'payment_hash', b.payment_hash, 'error', b.error) order by b.created_at desc)
        from (select * from public.blink_sweeps order by created_at desc limit v_limit) b), '[]'::jsonb),
    'overflows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', o.id, 'created_at', o.created_at, 'from_account', o.from_account, 'to_account', o.to_account,
               'amount_cents', o.amount_cents, 'status', o.status, 'error', o.error) order by o.created_at desc)
        from (select * from public.blink_overflows order by created_at desc limit v_limit) o), '[]'::jsonb));
end $$;
revoke all on function public.admin_blink_sweeps(integer) from public, anon;
grant execute on function public.admin_blink_sweeps(integer) to authenticated, service_role;
