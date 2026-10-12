-- Breez SDK (Spark) wallet storage + single-instance control for the
-- breez-wallet Edge Function (feature/supabase-breez-spark).
--
-- Nothing here turns the function on. control.enabled starts false, no cron
-- job is scheduled, and no secret is stored. Cutover (docs/SUPABASE_BREEZ.md):
-- stop the VM wallet, set the Edge secrets, then
--   update breez_wallet.control set enabled = true, owner = 'supabase-edge';
--   select breez_wallet.schedule_sync();
--
-- The SDK creates its own brz_* tables in this schema on first connect
-- (search_path=breez_wallet on its connection). They hold wallet state and
-- must never be reachable from the API: the schema is not exposed to
-- PostgREST and anon/authenticated have no privileges on it.

create schema if not exists breez_wallet;
revoke all on schema breez_wallet from public, anon, authenticated;
alter default privileges in schema breez_wallet revoke all on tables from public, anon, authenticated;
alter default privileges in schema breez_wallet revoke all on sequences from public, anon, authenticated;
alter default privileges in schema breez_wallet revoke all on functions from public, anon, authenticated;

-- Singleton switch. The function refuses every wallet call unless enabled,
-- so a deploy alone can never start a second copy of the wallet while the
-- VM still runs it.
create table if not exists breez_wallet.control (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  owner text not null default 'azure-vm' check (owner in ('azure-vm', 'supabase-edge')),
  note text,
  updated_at timestamptz not null default now()
);
insert into breez_wallet.control (id) values (true) on conflict do nothing;
alter table breez_wallet.control enable row level security;

-- Signed-request nonces, shared by every isolate (the in-memory set in
-- auth.mjs only covers one process; Edge isolates are many and short-lived).
create table if not exists breez_wallet.request_nonces (
  nonce text primary key check (nonce ~ '^[A-Za-z0-9_-]{16,128}$'),
  expires_at timestamptz not null
);
create index if not exists request_nonces_expires_idx on breez_wallet.request_nonces (expires_at);
alter table breez_wallet.request_nonces enable row level security;

-- Who held the wallet lease and when (no balances, ids or secrets).
create table if not exists breez_wallet.lease_log (
  id bigint generated always as identity primary key,
  holder text not null,
  acquired_at timestamptz not null default now(),
  released_at timestamptz,
  requests int not null default 0,
  outcome text
);
alter table breez_wallet.lease_log enable row level security;

-- true when the nonce is new (and records it), false on a replay.
create or replace function breez_wallet.claim_nonce(p_nonce text, p_expires_at timestamptz)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare inserted int;
begin
  delete from breez_wallet.request_nonces where expires_at < now() - interval '1 minute';
  insert into breez_wallet.request_nonces (nonce, expires_at) values (p_nonce, p_expires_at)
    on conflict (nonce) do nothing;
  get diagnostics inserted = row_count;
  return inserted = 1;
end $$;

-- Advisory lock key shared by every instance that may touch the wallet.
create or replace function breez_wallet.lock_key() returns bigint
language sql immutable set search_path = '' as $$ select hashtextextended('cpay:breez-wallet:spark', 0) $$;

-- Owner-run at cutover only: the incoming-payment sync every minute.
create or replace function breez_wallet.schedule_sync() returns text
language plpgsql security definer set search_path = '' as $$
begin
  if not (select enabled from breez_wallet.control) then
    raise exception 'breez_wallet.control.enabled is false; enable it after stopping the VM wallet';
  end if;
  if (select count(*) from vault.decrypted_secrets where name in ('cpay_functions_url', 'cpay_cron_secret')) < 2 then
    raise exception 'Vault secrets cpay_functions_url/cpay_cron_secret are missing';
  end if;
  perform cron.schedule('breez-wallet-sync', '* * * * *', $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'cpay_functions_url') || '/functions/v1/breez-wallet/cron/sync',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cpay_cron_secret')),
      timeout_milliseconds := 120000)
  $job$);
  return 'scheduled breez-wallet-sync';
end $$;

create or replace function breez_wallet.unschedule_sync() returns text
language plpgsql security definer set search_path = '' as $$
begin
  perform cron.unschedule('breez-wallet-sync');
  return 'unscheduled breez-wallet-sync';
exception when others then
  return 'breez-wallet-sync was not scheduled';
end $$;

revoke all on all tables in schema breez_wallet from public, anon, authenticated;
revoke all on all functions in schema breez_wallet from public, anon, authenticated;
