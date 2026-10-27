-- CPAY — 20261027040000: BTCPay receive switch (docs/BLINK-SWEEP.md).
-- BTCPay's Lightning connection points at one Blink account, so every
-- invoice is paid into it. When that account has little of Blink's 24-hour
-- withdrawal limit left, blink-sweep can point BTCPay at the owner's Blink
-- account with the most limit left (Greenfield, separate key
-- BTCPAY_SWITCH_API_KEY). Off by default. Builds on 20261027030000.
--
-- BTCPay can miss payments to invoices that were still open on the old
-- account when the connection changed (it checks open invoices on the store's
-- current node). So for two days after a switch, blink-sweep asks the old
-- Blink account whether those invoices were paid and, when Blink shows the
-- payment, records it here exactly like the BTCPay webhook would
-- (system_settle_gateway_invoice: same dedupe, fee and auto withdraw).
--
-- Adds: settings blink_receive_switch_enabled and
-- blink_receive_switch_below_usd, blink_receive_state (which account BTCPay
-- pays into, as last read), blink_receive_switches, blink_rescues, their
-- service-role functions, 'receive_switch' / 'switch_below_usd' in
-- system_blink_sweep_config() and 'receiving' / 'switches' / 'rescues' in
-- admin_blink_sweeps().
-- Rollback: drop the three tables and the new functions, re-run
-- 20261027030000 §4 and §5, re-run 20261021080000's patch without the two
-- blink_receive_switch rows.

-- 1. Settings --------------------------------------------------------------------
do $do$
declare src text := pg_get_functiondef('public.platform_setting_defaults()'::regprocedure);
begin
  if src like '%blink_receive_switch_enabled%' then return; end if;
  if src not like '%send its USD to another Blink account with limit left'')%' then
    raise exception 'platform_setting_defaults: patch point not found';
  end if;
  src := replace(src, $r$send its USD to another Blink account with limit left')$r$,
    $r$send its USD to another Blink account with limit left'),
  ('blink_receive_switch_enabled',  'false'::jsonb, 'boolean', true,  'BTCPay receive switch: when the Blink account BTCPay pays into has little daily withdrawal limit left, point BTCPay at the Blink account with the most limit left'),
  ('blink_receive_switch_below_usd', '50'::jsonb,   'money',   false, 'BTCPay receive switch: switch when the receiving account has less than this withdrawal limit left (USD)')$r$);
  execute src;
end $do$;
revoke all on function public.platform_setting_defaults() from public, anon;
grant execute on function public.platform_setting_defaults() to authenticated, service_role;

-- 2. Tables --------------------------------------------------------------------
-- One row: the Blink account BTCPay pays into, as the last run read it.
-- key_kind 'receive' = BTCPay holds that account's BLINK_RECEIVE_KEY_N,
-- 'api' = its BLINK_API_KEY_N (can spend), null = not one of CPAY's keys.
create table if not exists public.blink_receive_state (
  id boolean primary key default true check (id),
  checked_at timestamptz not null default now(),
  account text check (account ~ '^[1-9][0-9]?$'),
  key_kind text check (key_kind in ('receive', 'api')),
  result text not null
);
alter table public.blink_receive_state enable row level security;
revoke all on public.blink_receive_state from public, anon, authenticated;

create table if not exists public.blink_receive_switches (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  from_account text check (from_account ~ '^[1-9][0-9]?$'),
  to_account text not null check (to_account ~ '^[1-9][0-9]?$'),
  status text not null default 'switching' check (status in ('switching', 'done', 'failed', 'unknown')),
  error text,
  check (from_account is null or from_account <> to_account)
);
create index if not exists blink_receive_switches_created on public.blink_receive_switches (created_at desc);
alter table public.blink_receive_switches enable row level security;
revoke all on public.blink_receive_switches from public, anon, authenticated;

-- Payments CPAY recorded itself after Blink showed them paid.
create table if not exists public.blink_rescues (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  payment_id uuid not null,
  account text not null check (account ~ '^[1-9][0-9]?$'),
  amount_usd numeric(18,8) not null,
  outcome text not null
);
alter table public.blink_rescues enable row level security;
revoke all on public.blink_rescues from public, anon, authenticated;

-- 3. For the Edge Function (service_role only) --------------------------------
create or replace function public.system_blink_receive_note(p_account text, p_key_kind text, p_result text)
returns void language sql security definer set search_path = public
as $$
  insert into public.blink_receive_state (id, checked_at, account, key_kind, result)
  values (true, now(), p_account, p_key_kind, left(coalesce(p_result, ''), 200))
  on conflict (id) do update set checked_at = excluded.checked_at, account = excluded.account,
    key_kind = excluded.key_kind, result = excluded.result
$$;

-- begin refuses (null) while any switch was recorded in the last 30 minutes,
-- so two overlapping runs cannot both switch and BTCPay never flaps.
create or replace function public.system_blink_switch_begin(p_from text, p_to text)
returns uuid language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('blink_receive_switch'));
  if exists (select 1 from public.blink_receive_switches where created_at > now() - interval '30 minutes') then
    return null;
  end if;
  insert into public.blink_receive_switches (from_account, to_account) values (p_from, p_to)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.system_blink_switch_finish(p_id uuid, p_status text, p_error text)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if p_status not in ('done', 'failed', 'unknown') then raise exception 'bad status %', p_status; end if;
  update public.blink_receive_switches
     set status = p_status, error = left(p_error, 300), updated_at = now()
   where id = p_id and status = 'switching';
end $$;

-- Open BTCPay payments made before a switch in the last three days, each with
-- the Blink account BTCPay paid into when it was made (the 'from' of the
-- first switch after it). Newest first, 50 at most.
create or replace function public.system_blink_rescue_candidates()
returns jsonb language sql stable security definer set search_path = public
as $$
  with sw as (
    select from_account, created_at from public.blink_receive_switches
     where status in ('done', 'unknown') and created_at > now() - interval '3 days'
  ), c as (
    select p.id, p.lightning_invoice, p.amount_requested, p.created_at,
           (select s.from_account from sw s where s.created_at > p.created_at order by s.created_at limit 1) as account
      from public.payments p
     where p.gateway = 'btcpay' and p.status in ('new', 'pending', 'expired')
       and p.lightning_invoice is not null
       and p.created_at > now() - interval '2 days'
       and p.created_at < (select max(created_at) from sw)
  )
  select coalesce(jsonb_agg(jsonb_build_object('payment_id', c.id, 'bolt11', c.lightning_invoice,
           'amount_usd', c.amount_requested, 'account', c.account) order by c.created_at desc), '[]'::jsonb)
    from (select * from c where account is not null order by created_at desc limit 50) c
$$;

-- Record a payment Blink showed paid: the BTCPay webhook's own settle, with
-- the amount asked (a Lightning invoice cannot be paid with less).
create or replace function public.system_blink_rescue_settle(p_payment_id uuid, p_account text, p_amount_sat bigint)
returns text language plpgsql security definer set search_path = public
as $$
declare v payments; v_out text;
begin
  select * into v from payments where id = p_payment_id;
  if not found or v.gateway is distinct from 'btcpay' or v.lightning_invoice is null then return 'unknown'; end if;
  v_out := system_settle_gateway_invoice('btcpay', v.gateway_invoice_id, v.id, v.amount_requested, p_amount_sat, 'BTC-LN');
  if v_out = 'settled' then
    insert into public.blink_rescues (payment_id, account, amount_usd, outcome) values (v.id, p_account, v.amount_requested, v_out);
  end if;
  return v_out;
end $$;

revoke all on function public.system_blink_receive_note(text, text, text) from public, anon, authenticated;
revoke all on function public.system_blink_switch_begin(text, text) from public, anon, authenticated;
revoke all on function public.system_blink_switch_finish(uuid, text, text) from public, anon, authenticated;
revoke all on function public.system_blink_rescue_candidates() from public, anon, authenticated;
revoke all on function public.system_blink_rescue_settle(uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.system_blink_receive_note(text, text, text) to service_role;
grant execute on function public.system_blink_switch_begin(text, text) to service_role;
grant execute on function public.system_blink_switch_finish(uuid, text, text) to service_role;
grant execute on function public.system_blink_rescue_candidates() to service_role;
grant execute on function public.system_blink_rescue_settle(uuid, text, bigint) to service_role;

-- 4. Config: + receive switch -------------------------------------------------------
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
    'receive_switch', coalesce(platform_setting('blink_receive_switch_enabled') = 'true'::jsonb, false),
    'switch_below_usd', platform_setting('blink_receive_switch_below_usd'),
    'keep_usd', platform_setting('blink_sweep_keep_usd'),
    'min_usd', platform_setting('blink_sweep_min_usd'),
    'max_usd', platform_setting('blink_sweep_max_usd'),
    'destination', v_dest);
end $$;
revoke all on function public.system_blink_sweep_config() from public, anon, authenticated;
grant execute on function public.system_blink_sweep_config() to service_role;

-- 5. Admin read: + receiving, switches, rescues ----------------------------------------
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
        from (select * from public.blink_overflows order by created_at desc limit v_limit) o), '[]'::jsonb),
    'receiving', (select jsonb_build_object('account', r.account, 'key_kind', r.key_kind, 'result', r.result, 'checked_at', r.checked_at)
                    from public.blink_receive_state r),
    'switches', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', s.id, 'created_at', s.created_at, 'from_account', s.from_account, 'to_account', s.to_account,
               'status', s.status, 'error', s.error) order by s.created_at desc)
        from (select * from public.blink_receive_switches order by created_at desc limit v_limit) s), '[]'::jsonb),
    'rescues', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', x.id, 'created_at', x.created_at, 'payment_id', x.payment_id, 'account', x.account,
               'amount_usd', x.amount_usd, 'outcome', x.outcome) order by x.created_at desc)
        from (select * from public.blink_rescues order by created_at desc limit v_limit) x), '[]'::jsonb));
end $$;
revoke all on function public.admin_blink_sweeps(integer) from public, anon;
grant execute on function public.admin_blink_sweeps(integer) to authenticated, service_role;
