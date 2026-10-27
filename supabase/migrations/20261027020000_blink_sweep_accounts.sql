-- CPAY — 20261027020000: Blink sweep from several Blink accounts
-- (docs/BLINK-SWEEP.md). Each Blink account has its own daily withdrawal
-- limit, so blink-sweep now reads BLINK_API_KEY, BLINK_API_KEY_2 … _10 and
-- sweeps each account. Builds on 20261027010000.
--
-- Adds: blink_sweeps.account ('1' for every existing row), one sweep in
-- flight per account instead of one in total, blink_sweep_accounts (what
-- the last run saw for each account: balance, send permission, Blink's
-- 24-hour withdrawal limit left, result), and the functions for them.
-- Rollback: drop blink_sweep_accounts and the new functions, recreate
-- blink_sweeps_one_open on ((true)), drop blink_sweeps.account.

-- 1. One in flight per account -----------------------------------------------
alter table public.blink_sweeps add column if not exists account text not null default '1';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'blink_sweeps_account_check') then
    alter table public.blink_sweeps add constraint blink_sweeps_account_check check (account ~ '^[1-9][0-9]?$');
  end if;
end $$;
drop index if exists public.blink_sweeps_one_open;
create unique index if not exists blink_sweeps_one_open_per_account on public.blink_sweeps (account) where status in ('sending', 'pending');

-- 2. What the last run saw for each account ----------------------------------
create table if not exists public.blink_sweep_accounts (
  account text primary key check (account ~ '^[1-9][0-9]?$'),
  checked_at timestamptz not null default now(),
  balance_cents integer,
  can_send boolean,
  withdraw_remaining_cents integer,
  result text not null
);
alter table public.blink_sweep_accounts enable row level security;
revoke all on public.blink_sweep_accounts from public, anon, authenticated;

-- 3. For the Edge Function (service_role only) --------------------------------
create or replace function public.system_blink_sweep_open_all()
returns jsonb language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(b) - 'error' order by b.created_at), '[]'::jsonb)
    from public.blink_sweeps b where b.status in ('sending', 'pending')
$$;

drop function if exists public.system_blink_sweep_begin(integer, bigint, text, text, text, text, timestamptz);
create or replace function public.system_blink_sweep_begin(
  p_amount_cents integer, p_amount_sat bigint, p_destination text, p_blink_wallet_id text,
  p_bolt11 text, p_payment_hash text, p_invoice_expires_at timestamptz, p_account text default '1')
returns uuid language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  insert into public.blink_sweeps (account, amount_cents, amount_sat, destination, blink_wallet_id, bolt11, payment_hash, invoice_expires_at)
  values (coalesce(p_account, '1'), p_amount_cents, p_amount_sat, p_destination, p_blink_wallet_id, p_bolt11, p_payment_hash, p_invoice_expires_at)
  returning id into v_id;
  return v_id;
exception when unique_violation then
  return null;
end $$;

create or replace function public.system_blink_sweep_note_account(
  p_account text, p_balance_cents integer, p_can_send boolean, p_withdraw_remaining_cents integer, p_result text)
returns void language sql security definer set search_path = public
as $$
  insert into public.blink_sweep_accounts (account, checked_at, balance_cents, can_send, withdraw_remaining_cents, result)
  values (p_account, now(), p_balance_cents, p_can_send, p_withdraw_remaining_cents, left(coalesce(p_result, ''), 200))
  on conflict (account) do update set checked_at = excluded.checked_at, balance_cents = excluded.balance_cents,
    can_send = excluded.can_send, withdraw_remaining_cents = excluded.withdraw_remaining_cents, result = excluded.result
$$;

revoke all on function public.system_blink_sweep_open_all() from public, anon, authenticated;
revoke all on function public.system_blink_sweep_begin(integer, bigint, text, text, text, text, timestamptz, text) from public, anon, authenticated;
revoke all on function public.system_blink_sweep_note_account(text, integer, boolean, integer, text) from public, anon, authenticated;
grant execute on function public.system_blink_sweep_open_all() to service_role;
grant execute on function public.system_blink_sweep_begin(integer, bigint, text, text, text, text, timestamptz, text) to service_role;
grant execute on function public.system_blink_sweep_note_account(text, integer, boolean, integer, text) to service_role;

-- 4. Admin read: accounts too ----------------------------------------------------
-- {destination, accounts: [...], rows: [...]}. Accounts not seen for a day
-- (key removed) are left out. No invoices, keys or Blink wallet ids.
create or replace function public.admin_blink_sweeps(p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
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
        from (select * from public.blink_sweeps order by created_at desc
               limit least(greatest(coalesce(p_limit, 20), 1), 100)) b), '[]'::jsonb));
end $$;
revoke all on function public.admin_blink_sweeps(integer) from public, anon;
grant execute on function public.admin_blink_sweeps(integer) to authenticated, service_role;
