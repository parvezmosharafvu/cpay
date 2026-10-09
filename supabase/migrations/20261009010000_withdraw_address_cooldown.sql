-- ============================================================
-- P2: payout address cooldown.
--
-- A USDT payout may only go to an address the account saved at least
-- 24 hours earlier. A new address, or a changed one (by the user, by
-- PostgREST directly, or by an admin through admin_set_user_usdt_wallet()),
-- starts a new 24 hour wait. So a stolen session cannot add an address and
-- empty the balance to it at once; the owner has a day to notice
-- (the change is written to audit_log).
--
-- usable_after is set ONLY by the trigger below; a client value is ignored.
-- withdraw_destination_status() is what the payment service asks at quote
-- and again at confirm. Nothing here moves money or changes a balance.
--
-- Rollback (documented, not automatic):
--   drop trigger if exists usdt_wallets_cooldown on public.usdt_wallets;
--   drop function if exists public.usdt_wallets_cooldown();
--   drop function if exists public.withdraw_destination_status(uuid, text);
--   drop function if exists public.my_usdt_wallet_status();
--   alter table public.usdt_wallets drop column if exists usable_after;
-- ============================================================

alter table public.usdt_wallets add column if not exists usable_after timestamptz;
-- Existing addresses: 24 h after their last change (already past for any
-- address older than a day).
update public.usdt_wallets set usable_after = coalesce(updated_at, created_at, now()) + interval '24 hours'
 where usable_after is null;
alter table public.usdt_wallets alter column usable_after set default (now() + interval '24 hours');
alter table public.usdt_wallets alter column usable_after set not null;

create or replace function public.usdt_wallets_cooldown()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.usable_after := now() + interval '24 hours';
    new.updated_at := now();
  elsif new.address is distinct from old.address or new.network is distinct from old.network
        or new.user_id is distinct from old.user_id then
    new.usable_after := now() + interval '24 hours';
    new.updated_at := now();
  else
    new.usable_after := old.usable_after;
    return new;
  end if;
  perform public.record_audit(
    'payout_wallet.saved', 'profile', new.user_id::text,
    case when tg_op = 'UPDATE' then jsonb_build_object('network', old.network, 'address', old.address) end,
    jsonb_build_object('network', new.network, 'address', new.address, 'usable_after', new.usable_after),
    'Payout address saved; withdrawals to it open after 24 hours'
  );
  return new;
end;
$$;
revoke all on function public.usdt_wallets_cooldown() from public, anon, authenticated;

drop trigger if exists usdt_wallets_cooldown on public.usdt_wallets;
create trigger usdt_wallets_cooldown
  before insert or update on public.usdt_wallets
  for each row execute function public.usdt_wallets_cooldown();

-- Is p_address a saved address of p_user that is past its cooldown?
-- EVM addresses compare case-insensitively (checksum casing), others exactly.
create or replace function public.withdraw_destination_status(p_user uuid, p_address text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  a text := trim(coalesce(p_address, ''));
  v_until timestamptz;
begin
  if p_user is null or a = '' then
    return jsonb_build_object('ok', false, 'reason', 'not_saved');
  end if;
  select min(w.usable_after) into v_until
    from usdt_wallets w
   where w.user_id = p_user
     and (w.address = a or (a ~* '^0x[0-9a-f]{40}$' and lower(w.address) = lower(a)));
  if v_until is null then
    return jsonb_build_object('ok', false, 'reason', 'not_saved');
  end if;
  if v_until > now() then
    return jsonb_build_object('ok', false, 'reason', 'cooling_down', 'usable_after', v_until);
  end if;
  return jsonb_build_object('ok', true, 'usable_after', v_until);
end;
$$;
revoke all on function public.withdraw_destination_status(uuid, text) from public, anon, authenticated;
grant execute on function public.withdraw_destination_status(uuid, text) to service_role;

-- The caller's saved addresses with their cooldown, for the dashboard.
create or replace function public.my_usdt_wallet_status()
returns table (network text, address text, usable_after timestamptz, ready boolean)
language sql
stable
security definer
set search_path = public
as $$
  select w.network, w.address, w.usable_after, w.usable_after <= now()
    from usdt_wallets w
   where w.user_id = auth.uid()
   order by w.network;
$$;
revoke all on function public.my_usdt_wallet_status() from public, anon;
grant execute on function public.my_usdt_wallet_status() to authenticated, service_role;
