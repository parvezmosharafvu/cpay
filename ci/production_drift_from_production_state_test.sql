-- ============================================================
-- 20261004020000 against PRODUCTION's starting state
-- ============================================================
-- CI builds from the repo, but production differs (see the PR). This
-- puts the repo-built database back into production's pre-migration shape
-- for every object the migration touches (definitions and grants taken
-- from production's catalog on 2026-10-04), applies the migration again,
-- and runs the same behaviour checks. BEGIN/ROLLBACK.
-- ============================================================
\set ON_ERROR_STOP on
begin;

-- 1. No storefront in production.
drop function if exists public.get_public_store(uuid);
alter table public.profiles
  drop column if exists store_tagline, drop column if exists store_bio,
  drop column if exists store_avatar_url, drop column if exists store_theme,
  drop column if exists store_accent, drop column if exists store_cta;

-- 2. Production's wallet policy and the un-audited admin RPC.
drop policy if exists usdt_wallets_own on public.usdt_wallets;
create policy usdt_wallets_own on public.usdt_wallets for all to authenticated
  using ((user_id = auth.uid()) or is_admin()) with check ((user_id = auth.uid()) or is_admin());

create or replace function public.admin_set_user_usdt_wallet(p_user_id uuid, p_network text, p_address text)
returns void language plpgsql security definer set search_path to 'public' as $function$
declare a text := trim(p_address);
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'Unknown account';
  end if;
  if p_network is null or p_network not in ('tron','bsc','ethereum','polygon','arbitrum','base','optimism','avalanche','solana') then
    raise exception 'Unknown USDT network';
  end if;
  if not public.usdt_address_ok(p_network, a) then
    raise exception 'That address is not valid for %', p_network;
  end if;
  insert into public.usdt_wallets (user_id, network, address)
  values (p_user_id, p_network, a)
  on conflict (user_id, network) do update
    set address = excluded.address, updated_at = now();
end;
$function$;

grant execute on function public.my_payout_book() to public, anon;
grant execute on function public.set_my_payout_prefs(numeric, text, boolean) to public, anon;
grant execute on function public.set_my_usdt_wallet(text, text) to public, anon;
grant execute on function public.delete_my_usdt_wallet(text) to public, anon;

-- 3/4. Production's narrow profile guard, and the link guard without the lock rule.
create or replace function public.guard_profile_updates()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare
  user_editable_fields text[] := array[
    'display_name',
    'bio',
    'public_slug',
    'cost_percent',
    'withdraw_threshold',
    'preferred_usdt_network',
    'auto_withdraw_enabled'
  ];
begin
  if auth.uid() is null or is_admin() then
    return new;
  end if;

  if (to_jsonb(new) - user_editable_fields)
     is distinct from
     (to_jsonb(old) - user_editable_fields) then
    raise exception 'You may only change user-editable profile fields';
  end if;

  return new;
end;
$function$;

create or replace function public.guard_link_updates()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
begin
  if auth.uid() is null or is_admin() then
    return new;
  end if;

  if new.user_id is distinct from auth.uid() then
    raise exception 'Cannot create or move a link for another user';
  end if;

  if tg_op = 'INSERT' then
    return new;
  end if;

  if new.user_id is distinct from old.user_id then
    raise exception 'Cannot change link owner';
  end if;
  if new.deleted_at is distinct from old.deleted_at then
    raise exception 'Deleted links cannot be restored from here';
  end if;
  if new.cost_percent is distinct from old.cost_percent
     and new.cost_percent is not null
     and (new.cost_percent < 0 or new.cost_percent > 1000) then
    raise exception 'Cost must be between 0 and 1000';
  end if;
  return new;
end;
$function$;

-- No lock-clear trigger in production; the account-status guard as it is there.
drop trigger if exists trg_clear_link_costs_on_lock on public.profiles;
drop function if exists public.clear_link_costs_on_lock();
create or replace function public.guard_payment_link_account_status()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
begin
  if not is_admin() and not account_is_active(new.user_id) then
    raise exception 'Account approval is required before creating payment links';
  end if;
  return new;
end;
$function$;
drop function if exists public.link_update_is_lock_clear(public.payment_links, public.payment_links, text);

-- 5. get_my_analytics() open to PUBLIC and anon in production.
grant execute on function public.get_my_analytics() to public, anon;

-- 6. telegram_context() already exists in production with these grants
--    (the migration's own definition is production's, verbatim).
revoke all on function public.telegram_context(text, integer) from public, anon, authenticated;

-- Sanity: this really is production's shape before the migration.
do $$ begin
  if to_regprocedure('public.get_public_store(uuid)') is not null
     or exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name like 'store\_%')
     or (select qual from pg_policies where tablename = 'usdt_wallets' and policyname = 'usdt_wallets_own') not like '%is_admin()%'
     or not has_function_privilege('anon', 'public.get_my_analytics()', 'execute')
     or exists (select 1 from pg_trigger where tgname = 'trg_clear_link_costs_on_lock') then
    raise exception 'production state simulation did not take';
  end if;
end $$;

\i supabase/migrations/20261004020000_production_drift_fixes.sql
-- And again: idempotent.
\i supabase/migrations/20261004020000_production_drift_fixes.sql

\ir production_drift_checks.inc.sql
rollback;
