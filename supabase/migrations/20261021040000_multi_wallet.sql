-- Multiple platform wallets (feature/multi-wallet).
--
-- Before this migration the wallet function ran ONE wallet whose seed is
-- the Edge secret BREEZ_MNEMONIC. That wallet becomes the implicit legacy
-- wallet #1 (fixed id ...0001, is_legacy, seed still read from the Edge
-- secret) and stays primary, so nothing changes until the owner adds a
-- second wallet.
--
-- New wallets: the owner pastes a 12-word seed in Admin → Wallet. The
-- owner-only Edge Function `wallet-registry` validates it (BIP39 words and
-- checksum) and calls public.wallet_registry_add(), which stores it in
-- Supabase Vault (vault.create_secret) and keeps only the Vault secret id.
-- The seed is never in a plain column, never returned, never in the audit.
-- Only the wallet function reads it, through breez_wallet.wallet_seed(),
-- which is in a schema the API does not expose and is not executable by
-- anon/authenticated.
--
-- Routing (documented in docs/MULTI-WALLET.md):
--   * new invoices are made by the PRIMARY wallet;
--   * forwards and withdrawals are paid by the PRIMARY wallet;
--   * other active wallets are synced every minute receive-only: payments
--     to invoices they made earlier still settle, and their balance shows.
-- wallet_id is recorded on payments (when the invoice is attached),
-- payment_forwards and withdrawals (when they start sending). NULL on old
-- rows means wallet #1.
--
-- Every public.wallet_registry_* function is service_role only: the
-- wallet-registry Edge Function checks the owner (CPAY_OWNER_USER_ID) and
-- a passkey session before calling them, and passes the owner id as actor.

-- ---------------------------------------------------------------- tables
create table if not exists breez_wallet.wallets (
  id uuid primary key default gen_random_uuid(),
  label text not null check (char_length(btrim(label)) between 1 and 60),
  network text not null default 'mainnet' check (network in ('mainnet', 'regtest')),
  status text not null default 'active' check (status in ('active', 'standby', 'disabled', 'removed')),
  is_primary boolean not null default false,
  is_legacy boolean not null default false,
  seed_secret_id uuid,          -- vault.secrets.id; null for the legacy (Edge secret) wallet and once removed
  fingerprint text check (fingerprint is null or fingerprint ~ '^[0-9a-f]{8}$'),  -- BIP32 master key fingerprint
  node_pubkey text check (node_pubkey is null or node_pubkey ~ '^[0-9a-f]{66}$'),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  removed_at timestamptz,
  constraint wallets_seed_present check (is_legacy or status = 'removed' or seed_secret_id is not null),
  constraint wallets_primary_active check (not is_primary or status = 'active')
);
create unique index if not exists wallets_one_primary on breez_wallet.wallets (is_primary) where is_primary;
create unique index if not exists wallets_one_legacy on breez_wallet.wallets (is_legacy) where is_legacy;
create unique index if not exists wallets_fingerprint_uq on breez_wallet.wallets (fingerprint) where status <> 'removed' and fingerprint is not null;
create unique index if not exists wallets_pubkey_uq on breez_wallet.wallets (node_pubkey) where status <> 'removed' and node_pubkey is not null;
alter table breez_wallet.wallets enable row level security;

insert into breez_wallet.wallets (id, label, status, is_primary, is_legacy, network)
values ('00000000-0000-0000-0000-000000000001', 'Wallet 1', 'active', true, true, 'mainnet')
on conflict (id) do nothing;

-- Last known state per wallet, written by the wallet function after a sync.
create table if not exists breez_wallet.wallet_status (
  wallet_id uuid primary key references breez_wallet.wallets (id),
  balance_sat bigint check (balance_sat is null or balance_sat >= 0),
  synced_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 300),
  updated_at timestamptz not null default now()
);
alter table breez_wallet.wallet_status enable row level security;

-- Who did what to which wallet. Never holds a seed: detail is built only
-- from labels, statuses, fingerprints and counts inside this file.
create table if not exists breez_wallet.wallet_audit (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid,
  wallet_id uuid,
  action text not null,
  detail jsonb not null default '{}'::jsonb
);
create index if not exists wallet_audit_actor_at on breez_wallet.wallet_audit (actor, action, at);
alter table breez_wallet.wallet_audit enable row level security;

-- Leases now say which wallet and role ('primary' serves requests and pays;
-- 'receiver' is a short receive-only sync). NULL wallet_id = wallet #1.
alter table breez_wallet.lease_log add column if not exists wallet_id uuid;
alter table breez_wallet.lease_log add column if not exists role text;

-- Attribution columns. NULL = wallet #1 (rows from before this migration).
alter table public.payments add column if not exists wallet_id uuid references breez_wallet.wallets (id);
alter table public.payment_forwards add column if not exists wallet_id uuid references breez_wallet.wallets (id);
alter table public.withdrawals add column if not exists wallet_id uuid references breez_wallet.wallets (id);
create index if not exists payments_wallet_open_idx on public.payments (wallet_id) where status in ('new', 'pending');

revoke all on all tables in schema breez_wallet from public, anon, authenticated;

-- ---------------------------------------------------------------- helpers
create or replace function breez_wallet.legacy_wallet_id() returns uuid
language sql immutable set search_path = '' as $$ select '00000000-0000-0000-0000-000000000001'::uuid $$;

create or replace function breez_wallet.primary_wallet_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select coalesce((select id from breez_wallet.wallets where is_primary), breez_wallet.legacy_wallet_id())
$$;

-- The wallet function opens each wallet's pool with
-- options=-c cpay.wallet_id=<id>, so rows it writes name the wallet that
-- made them. Anything else (an RPC, a test) falls back to the primary.
create or replace function breez_wallet.acting_wallet_id() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v text := current_setting('cpay.wallet_id', true); r uuid;
begin
  if v ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select id into r from breez_wallet.wallets where id = v::uuid;
    if r is not null then return r; end if;
  end if;
  return breez_wallet.primary_wallet_id();
end $$;

-- Advisory lock key per wallet. Wallet #1 keeps the original key so an old
-- and a new deploy of the function still exclude each other.
create or replace function breez_wallet.wallet_lock_key(p_wallet uuid) returns bigint
language sql immutable set search_path = '' as $$
  select case when p_wallet = '00000000-0000-0000-0000-000000000001'::uuid
              then hashtextextended('cpay:breez-wallet:spark', 0)
              else hashtextextended('cpay:breez-wallet:spark:' || p_wallet::text, 0) end
$$;

-- SDK storage schema per wallet (wallet #1 keeps breez_wallet).
create or replace function breez_wallet.wallet_schema(p_wallet uuid) returns text
language sql immutable set search_path = '' as $$
  select case when p_wallet = '00000000-0000-0000-0000-000000000001'::uuid then 'breez_wallet'
              else 'breez_wallet_w_' || replace(p_wallet::text, '-', '') end
$$;

create or replace function breez_wallet.ensure_wallet_schema(p_wallet uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare s text := breez_wallet.wallet_schema(p_wallet); o text;
begin
  if s = 'breez_wallet' then return s; end if;
  execute format('create schema if not exists %I', s);
  execute format('revoke all on schema %I from public', s);
  if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on schema %I from anon, authenticated', s); end if;
  -- the role that owns breez_wallet is the one the wallet function connects as
  select nspowner::regrole::text into o from pg_namespace where nspname = 'breez_wallet';
  if o is not null and o <> current_user then execute format('grant usage, create on schema %I to %s', s, o); end if;
  return s;
end $$;

-- Trigger: record which wallet made an invoice / started a send.
create or replace function breez_wallet.tag_wallet() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.wallet_id is not null then return new; end if;
  if tg_table_name = 'payments' then
    if new.lightning_invoice is not null and (tg_op = 'INSERT' or old.lightning_invoice is null) then
      new.wallet_id := breez_wallet.acting_wallet_id();
    end if;
  elsif new.status = 'sending' and (tg_op = 'INSERT' or old.status is distinct from 'sending') then
    new.wallet_id := breez_wallet.acting_wallet_id();
  end if;
  return new;
end $$;

drop trigger if exists payments_tag_wallet on public.payments;
create trigger payments_tag_wallet before insert or update of lightning_invoice on public.payments
  for each row execute function breez_wallet.tag_wallet();
drop trigger if exists payment_forwards_tag_wallet on public.payment_forwards;
create trigger payment_forwards_tag_wallet before insert or update of status on public.payment_forwards
  for each row execute function breez_wallet.tag_wallet();
drop trigger if exists withdrawals_tag_wallet on public.withdrawals;
create trigger withdrawals_tag_wallet before insert or update of status on public.withdrawals
  for each row execute function breez_wallet.tag_wallet();

-- ------------------------------------------------- wallet function (DB_URL role only)
-- The seed of a Vault-backed wallet. Not in an exposed schema; execute
-- revoked from everyone but the owner role and service_role.
create or replace function breez_wallet.wallet_seed(p_wallet uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare w record; s text;
begin
  select id, status, is_legacy, seed_secret_id into w from breez_wallet.wallets where id = p_wallet;
  if w.id is null or w.is_legacy or w.status not in ('active', 'standby') or w.seed_secret_id is null then
    raise exception 'wallet seed unavailable' using errcode = 'P0002';
  end if;
  select decrypted_secret into s from vault.decrypted_secrets where id = w.seed_secret_id;
  if s is null then raise exception 'wallet seed unavailable' using errcode = 'P0002'; end if;
  return s;
end $$;

-- Wallets the function should run (never the seed).
create or replace function breez_wallet.wallets_to_run() returns table (id uuid, is_legacy boolean, is_primary boolean, status text, network text)
language sql stable security definer set search_path = '' as $$
  select id, is_legacy, is_primary, status, network from breez_wallet.wallets
   where status in ('active', 'standby') order by is_primary desc, created_at
$$;

-- After a connect/sync. Returns false (and disables the newer wallet) when
-- another wallet already has the same node key: one seed, one entry.
create or replace function breez_wallet.wallet_record_status(p_wallet uuid, p_pubkey text, p_balance_sat bigint, p_error text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare dup uuid;
begin
  if p_pubkey is not null and p_pubkey ~ '^[0-9a-f]{66}$' then
    select id into dup from breez_wallet.wallets
     where node_pubkey = p_pubkey and id <> p_wallet and status <> 'removed' limit 1;
    if dup is not null then
      update breez_wallet.wallets set status = 'disabled', updated_at = now() where id = p_wallet and not is_primary and not is_legacy;
      insert into breez_wallet.wallet_audit (wallet_id, action, detail)
        values (p_wallet, 'auto_disabled_duplicate', jsonb_build_object('same_as', dup));
      return false;
    end if;
    update breez_wallet.wallets set node_pubkey = p_pubkey where id = p_wallet and node_pubkey is distinct from p_pubkey;
  end if;
  insert into breez_wallet.wallet_status (wallet_id, balance_sat, synced_at, last_error, updated_at)
  values (p_wallet, p_balance_sat, case when p_error is null then now() end, left(p_error, 300), now())
  on conflict (wallet_id) do update set
    balance_sat = coalesce(excluded.balance_sat, breez_wallet.wallet_status.balance_sat),
    synced_at = coalesce(excluded.synced_at, breez_wallet.wallet_status.synced_at),
    last_error = excluded.last_error, updated_at = now();
  return true;
end $$;

-- ------------------------------------------------- owner RPCs (service_role only)
create or replace function public.wallet_registry_list() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'wallets', coalesce(jsonb_agg(jsonb_build_object(
      'id', w.id, 'label', w.label, 'network', w.network, 'status', w.status,
      'is_primary', w.is_primary, 'is_legacy', w.is_legacy,
      'fingerprint', w.fingerprint, 'node_pubkey', w.node_pubkey,
      'created_at', w.created_at,
      'balance_sat', s.balance_sat, 'synced_at', s.synced_at, 'last_error', s.last_error,
      'open_invoices', (select count(*) from public.payments p where p.status in ('new', 'pending')
                          and coalesce(p.wallet_id, breez_wallet.legacy_wallet_id()) = w.id and p.lightning_invoice is not null),
      'pending_sends', (select count(*) from public.payment_forwards f where f.status = 'sending'
                          and coalesce(f.wallet_id, breez_wallet.legacy_wallet_id()) = w.id)
                     + (select count(*) from public.withdrawals d where d.status in ('pending', 'approved', 'processing', 'sending')
                          and d.wallet_id = w.id)
    ) order by w.is_primary desc, w.created_at), '[]'::jsonb),
    'total_balance_sat', coalesce(sum(s.balance_sat) filter (where w.status <> 'removed'), 0)
  )
  from breez_wallet.wallets w left join breez_wallet.wallet_status s on s.wallet_id = w.id
  where w.status <> 'removed'
$$;

-- Rate limit for adds: true when the actor may try again (max 5 per hour,
-- counting failures). Records the attempt.
create or replace function public.wallet_registry_add_attempt(p_actor uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if p_actor is null then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('cpay:wallet-add:' || p_actor::text, 0));
  select count(*) into n from breez_wallet.wallet_audit
   where actor = p_actor and action = 'add_attempt' and at > now() - interval '1 hour';
  if n >= 5 then return false; end if;
  insert into breez_wallet.wallet_audit (actor, action) values (p_actor, 'add_attempt');
  return true;
end $$;

-- Stores the seed in Vault. Errors carry fixed codes only, never input.
create or replace function public.wallet_registry_add(p_actor uuid, p_label text, p_network text, p_mnemonic text, p_fingerprint text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid(); v_secret uuid; v_label text := btrim(coalesce(p_label, ''));
begin
  if p_actor is null then raise exception 'actor_required'; end if;
  if char_length(v_label) < 1 or char_length(v_label) > 60 then raise exception 'bad_label'; end if;
  if p_network not in ('mainnet', 'regtest') then raise exception 'bad_network'; end if;
  if p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{8}$' then raise exception 'bad_fingerprint'; end if;
  -- shape only (the Edge Function checked the BIP39 words and checksum)
  if p_mnemonic is null or p_mnemonic !~ '^[a-z]+( [a-z]+){11}$' then raise exception 'bad_mnemonic'; end if;
  if exists (select 1 from breez_wallet.wallets where fingerprint = p_fingerprint and status <> 'removed') then
    raise exception 'duplicate_wallet';
  end if;
  begin
    v_secret := vault.create_secret(p_mnemonic, 'cpay_wallet_seed_' || v_id::text, 'CPAY platform wallet seed');
  exception when others then
    raise exception 'vault_store_failed';  -- never re-raise the original message
  end;
  insert into breez_wallet.wallets (id, label, network, status, is_primary, seed_secret_id, fingerprint, created_by)
  values (v_id, v_label, p_network, 'active', false, v_secret, p_fingerprint, p_actor);
  perform breez_wallet.ensure_wallet_schema(v_id);
  insert into breez_wallet.wallet_audit (actor, wallet_id, action, detail)
  values (p_actor, v_id, 'add', jsonb_build_object('label', v_label, 'network', p_network, 'fingerprint', p_fingerprint));
  return jsonb_build_object('id', v_id, 'label', v_label, 'fingerprint', p_fingerprint, 'status', 'active');
end $$;

create or replace function public.wallet_registry_rename(p_actor uuid, p_wallet uuid, p_label text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_label text := btrim(coalesce(p_label, '')); v_old text;
begin
  if p_actor is null then raise exception 'actor_required'; end if;
  if char_length(v_label) < 1 or char_length(v_label) > 60 then raise exception 'bad_label'; end if;
  select label into v_old from breez_wallet.wallets where id = p_wallet and status <> 'removed' for update;
  if v_old is null then raise exception 'wallet_not_found'; end if;
  update breez_wallet.wallets set label = v_label, updated_at = now() where id = p_wallet;
  insert into breez_wallet.wallet_audit (actor, wallet_id, action, detail)
  values (p_actor, p_wallet, 'rename', jsonb_build_object('from', v_old, 'to', v_label));
  return jsonb_build_object('id', p_wallet, 'label', v_label);
end $$;

create or replace function public.wallet_registry_set_primary(p_actor uuid, p_wallet uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w record; v_old uuid;
begin
  if p_actor is null then raise exception 'actor_required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('cpay:wallet-registry', 0));
  select * into w from breez_wallet.wallets where id = p_wallet for update;
  if w.id is null or w.status = 'removed' then raise exception 'wallet_not_found'; end if;
  if w.status <> 'active' then raise exception 'wallet_not_active'; end if;
  if w.is_primary then return jsonb_build_object('id', p_wallet, 'is_primary', true); end if;
  select id into v_old from breez_wallet.wallets where is_primary for update;
  update breez_wallet.wallets set is_primary = false, updated_at = now() where is_primary;
  update breez_wallet.wallets set is_primary = true, updated_at = now() where id = p_wallet;
  -- the cached balance belonged to the old primary
  delete from breez_wallet.response_cache where key = '/admin/wallet/info';
  insert into breez_wallet.wallet_audit (actor, wallet_id, action, detail)
  values (p_actor, p_wallet, 'set_primary', jsonb_build_object('previous', v_old));
  return jsonb_build_object('id', p_wallet, 'is_primary', true);
end $$;

-- active <-> standby <-> disabled. The primary cannot leave 'active'.
create or replace function public.wallet_registry_set_status(p_actor uuid, p_wallet uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w record;
begin
  if p_actor is null then raise exception 'actor_required'; end if;
  if p_status not in ('active', 'standby', 'disabled') then raise exception 'bad_status'; end if;
  select * into w from breez_wallet.wallets where id = p_wallet for update;
  if w.id is null or w.status = 'removed' then raise exception 'wallet_not_found'; end if;
  if w.is_primary and p_status <> 'active' then raise exception 'primary_must_stay_active'; end if;
  update breez_wallet.wallets set status = p_status, updated_at = now() where id = p_wallet;
  insert into breez_wallet.wallet_audit (actor, wallet_id, action, detail)
  values (p_actor, p_wallet, 'set_status', jsonb_build_object('from', w.status, 'to', p_status));
  return jsonb_build_object('id', p_wallet, 'status', p_status);
end $$;

-- Removal: typed label must match; refused for the primary, wallet #1
-- (its seed is an Edge secret), an unknown or non-zero balance (a status
-- older than 15 minutes counts as unknown), open invoices, or sends that
-- are not finished. Deletes the Vault secret and keeps the row as 'removed'
-- so old payments still name it.
create or replace function public.wallet_registry_remove(p_actor uuid, p_wallet uuid, p_confirm text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w record; s record; n int;
begin
  if p_actor is null then raise exception 'actor_required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('cpay:wallet-registry', 0));
  select * into w from breez_wallet.wallets where id = p_wallet for update;
  if w.id is null or w.status = 'removed' then raise exception 'wallet_not_found'; end if;
  if p_confirm is distinct from w.label then raise exception 'confirmation_mismatch'; end if;
  if w.is_legacy then raise exception 'legacy_wallet_not_removable'; end if;
  if w.is_primary then raise exception 'primary_not_removable'; end if;
  select * into s from breez_wallet.wallet_status where wallet_id = p_wallet;
  if s.wallet_id is null or s.balance_sat is null or s.synced_at is null or s.synced_at < now() - interval '15 minutes' then
    raise exception 'balance_unknown';
  end if;
  if s.balance_sat > 0 then raise exception 'balance_not_zero'; end if;
  select count(*) into n from public.payments where wallet_id = p_wallet and status in ('new', 'pending') and expires_at > now() - interval '1 day';
  if n > 0 then raise exception 'open_invoices'; end if;
  select count(*) into n from public.payment_forwards where wallet_id = p_wallet and status in ('queued', 'sending', 'retry', 'owed');
  if n > 0 then raise exception 'forwards_pending'; end if;
  select count(*) into n from public.withdrawals where wallet_id = p_wallet and status in ('pending', 'approved', 'processing', 'sending');
  if n > 0 then raise exception 'withdrawals_pending'; end if;
  delete from vault.secrets where id = w.seed_secret_id;
  update breez_wallet.wallets set status = 'removed', seed_secret_id = null, removed_at = now(), updated_at = now() where id = p_wallet;
  insert into breez_wallet.wallet_audit (actor, wallet_id, action, detail)
  values (p_actor, p_wallet, 'remove', jsonb_build_object('label', w.label, 'fingerprint', w.fingerprint));
  return jsonb_build_object('id', p_wallet, 'status', 'removed');
end $$;

create or replace function public.wallet_registry_audit(p_limit int default 50) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(a) order by a.at desc), '[]'::jsonb) from (
    select at, actor, wallet_id, action, detail from breez_wallet.wallet_audit
     where action <> 'add_attempt' order by at desc limit greatest(1, least(coalesce(p_limit, 50), 200))) a
$$;

-- ---------------------------------------------------------------- grants
revoke all on function breez_wallet.legacy_wallet_id(), breez_wallet.primary_wallet_id(), breez_wallet.acting_wallet_id(),
  breez_wallet.wallet_lock_key(uuid), breez_wallet.wallet_schema(uuid), breez_wallet.ensure_wallet_schema(uuid),
  breez_wallet.tag_wallet(), breez_wallet.wallet_seed(uuid), breez_wallet.wallets_to_run(),
  breez_wallet.wallet_record_status(uuid, text, bigint, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on all functions in schema breez_wallet from anon, authenticated;
  end if;
end $$;

revoke all on function public.wallet_registry_list(), public.wallet_registry_add_attempt(uuid),
  public.wallet_registry_add(uuid, text, text, text, text), public.wallet_registry_rename(uuid, uuid, text),
  public.wallet_registry_set_primary(uuid, uuid), public.wallet_registry_set_status(uuid, uuid, text),
  public.wallet_registry_remove(uuid, uuid, text), public.wallet_registry_audit(int) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.wallet_registry_list(), public.wallet_registry_add_attempt(uuid),
      public.wallet_registry_add(uuid, text, text, text, text), public.wallet_registry_rename(uuid, uuid, text),
      public.wallet_registry_set_primary(uuid, uuid), public.wallet_registry_set_status(uuid, uuid, text),
      public.wallet_registry_remove(uuid, uuid, text), public.wallet_registry_audit(int) from anon, authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.wallet_registry_list(), public.wallet_registry_add_attempt(uuid),
      public.wallet_registry_add(uuid, text, text, text, text), public.wallet_registry_rename(uuid, uuid, text),
      public.wallet_registry_set_primary(uuid, uuid), public.wallet_registry_set_status(uuid, uuid, text),
      public.wallet_registry_remove(uuid, uuid, text), public.wallet_registry_audit(int) to service_role;
  end if;
end $$;
