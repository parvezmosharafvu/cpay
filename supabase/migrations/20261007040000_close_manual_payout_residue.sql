-- ============================================================
-- 20261007040000: close leftover manual-payout surface
-- ============================================================
-- Chat 1 audit (baseline 53bee25):
--   * request_withdrawal() already raises (20260929103557); keep it closed.
--   * Address validators lacked a pinned search_path (advisor WARN).
--   * Trigger SECURITY DEFINER helpers still had EXECUTE for anon /
--     authenticated from default privileges. PostgREST cannot call
--     trigger-returning functions, but revoke them anyway so the
--     security advisor stays quiet and a future signature change cannot
--     accidentally re-expose them as RPCs.
-- Does not change balances, fees, RLS on money tables, or idempotency.
-- Safe to re-run.
-- ============================================================

-- Pin search_path on pure address validators (advisor: function_search_path_mutable).
create or replace function public.usdt_address_ok(p_network text, p_address text)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare a text := trim(p_address);
begin
  if p_network = 'tron' then
    return a ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$';
  elsif p_network = 'solana' then
    return a ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$';
  else
    return a ~ '^0x[0-9a-fA-F]{40}$';
  end if;
end;
$$;

create or replace function public.cpay_valid_onchain_address(p_network text, p_address text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select case
    when p_network = 'bitcoin'
      then p_address ~* '^(bc1)[a-z0-9]{11,87}$'
        or p_address ~ '^[13][a-km-zA-HJ-NP-Z1-9]{24,34}$'
    when p_network = 'bitcoin_testnet'
      then p_address ~* '^(tb1)[a-z0-9]{11,87}$'
        or p_address ~ '^[2mn][a-km-zA-HJ-NP-Z1-9]{24,34}$'
    else false
  end;
$$;

-- Keep grants: authenticated may validate; anon may not.
revoke all on function public.usdt_address_ok(text, text) from public, anon;
grant execute on function public.usdt_address_ok(text, text) to authenticated, service_role;

revoke all on function public.cpay_valid_onchain_address(text, text) from public, anon;
grant execute on function public.cpay_valid_onchain_address(text, text) to authenticated, service_role;

-- request_withdrawal stays a closed stub (USDT form / payment-service only).
create or replace function public.request_withdrawal(p_amount numeric, p_method text, p_destination text)
returns withdrawals
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'Only USDT to a saved wallet address is supported. Use the USDT withdraw form.';
end;
$$;
revoke all on function public.request_withdrawal(numeric, text, text) from public, anon;
grant execute on function public.request_withdrawal(numeric, text, text) to authenticated;

-- Hygiene: trigger helpers are not RPCs. Revoke browser roles.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prorettype = 'trigger'::regtype
       and p.prosecdef
       and p.proname in (
         'audit_withdrawal_change',
         'cpay_guard_link_feature',
         'cpay_guard_withdrawal_feature',
         'cpay_validate_domain_owner',
         'enforce_link_limit',
         'guard_link_updates',
         'guard_message_updates',
         'guard_payment_link_account_status',
         'guard_profile_updates',
         'guard_withdrawal_account_status',
         'guard_withdrawal_updates',
         'handle_new_user',
         'validate_link_slug'
       )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
  end loop;
end $$;
