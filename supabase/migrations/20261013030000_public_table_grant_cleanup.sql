-- Audit P3: forward-only grant cleanup and production-drift codification.
--
-- 1. anon never writes a public table directly: every browser write is made
--    by a signed-in user (support messages, own payment links) and every
--    public payment action goes through SECURITY DEFINER RPCs that run as
--    their owner. Supabase's default privileges still hand anon INSERT,
--    UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER on every table; RLS
--    blocks the row writes, but TRUNCATE is not subject to RLS. Revoke them.
-- 2. authenticated keeps its RLS-gated SELECT/INSERT/UPDATE/DELETE but loses
--    TRUNCATE, REFERENCES and TRIGGER, which no client path uses.
-- 3. Production carries four CHECK constraints and a (user_id, network)
--    unique constraint that no migration created. Add them where missing so
--    a fresh replay matches production. On production this is a no-op.
-- Only schema public is touched; the breez_wallet schema is not.

do $$
declare t record;
begin
  for t in select c.oid::regclass as rel from pg_class c
           where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','f')
  loop
    execute format('revoke insert, update, delete, truncate, references, trigger on %s from anon', t.rel);
    execute format('revoke truncate, references, trigger on %s from authenticated', t.rel);
  end loop;
end $$;

-- Future tables: same rule.
alter default privileges in schema public revoke insert, update, delete, truncate, references, trigger on tables from anon;
alter default privileges in schema public revoke truncate, references, trigger on tables from authenticated;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_preferred_usdt_network_chk') then
    alter table public.profiles add constraint profiles_preferred_usdt_network_chk
      check (preferred_usdt_network is null or preferred_usdt_network = any (array['tron','bsc','ethereum','polygon','arbitrum','base','optimism','avalanche','solana']));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_withdraw_threshold_chk') then
    alter table public.profiles add constraint profiles_withdraw_threshold_chk
      check (withdraw_threshold is null or withdraw_threshold >= 5);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'usdt_wallets_address_chk') then
    alter table public.usdt_wallets add constraint usdt_wallets_address_chk
      check (length(btrim(address)) between 20 and 128);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'usdt_wallets_network_chk') then
    alter table public.usdt_wallets add constraint usdt_wallets_network_chk
      check (network = any (array['tron','bsc','ethereum','polygon','arbitrum','base','optimism','avalanche','solana']));
  end if;
  -- The fresh replay already has an equivalent unique constraint under the
  -- name usdt_wallets_user_id_network_key; do not add a duplicate.
end $$;
