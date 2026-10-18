-- CPAY — 20261018010000: direct settlement (non-custodial receive), OFF
--
-- Today every CPAY payment is custodial: the payer pays an invoice of the
-- platform wallet and the merchant's balance is a ledger entry
-- (docs/NON-CUSTODIAL-ARCHITECTURE.md). This adds a second, separate path
-- in which the payer pays the MERCHANT'S OWN wallet directly:
--
--   * the merchant registers a Lightning address of a wallet they control
--     (settlement_destinations). It takes effect 24 hours after it is
--     saved, like a payout address, so a hijacked session cannot redirect
--     the next payment;
--   * a link can be switched to settlement_mode 'direct' by its owner only
--     (set_link_settlement_mode), never by an admin or the service role,
--     and only once the address is in use;
--   * the direct-invoice Edge Function asks the merchant's wallet provider
--     for the invoice, and records it in direct_payments;
--   * a direct payment is 'paid' only with a preimage whose SHA-256 is the
--     invoice's payment hash. A CHECK constraint enforces that here, so no
--     code path can mark one paid without proof;
--   * direct_payments is NEVER part of a CPAY balance. get_balance_for(),
--     withdrawals and fees read payments only; a payments row can no longer
--     be created for a direct link (guard_payment_settlement_mode).
--
-- OFF by default: app_settings.direct_settlement_enabled = false. While it
-- is off nothing changes for anyone: no link can be made direct, the
-- function refuses, the desk hides the controls. Turning it on is an owner
-- decision (admin_set_feature_toggle, needs aal2; a direct write of the row
-- by a signed-in caller is refused by trg_guard_direct_settlement_switch).
--
-- Also: get_public_store()'s fallback name was 'CPAY creator'; it is
-- 'CPAY member' (public copy uses Freelancer / member, never the role name),
-- and its role filter no longer names the role removed in 20261005020000.
--
-- Additive only: two tables, two columns with constant defaults (no table
-- rewrite), functions and triggers. No existing row changes meaning.
--
-- Rollback (documented, not automatic), with the flag off:
--   drop trigger if exists trg_guard_payment_settlement_mode on public.payments;
--   drop trigger if exists trg_guard_link_settlement_mode on public.payment_links;
--   drop trigger if exists trg_guard_direct_settlement_switch on public.app_settings;
--   drop the functions created below; re-create get_link_preview() and
--   get_public_store() from 0093 / 20261004020000 and admin_set_feature_toggle()
--   from 20261014030000;
--   drop table public.direct_payments; drop table public.settlement_destinations;
--   alter table public.payment_links drop column settlement_mode;
--   alter table public.profiles drop column direct_settlement_blocked;
--   delete from public.app_settings where key = 'direct_settlement_enabled';
-- direct_payments rows are the only record of payments that went straight
-- to merchants: export them before dropping the table.
-- ============================================================

-- ---------- 0. The switch ----------
insert into public.app_settings(key, value) values ('direct_settlement_enabled', 'false'::jsonb)
on conflict (key) do nothing;

alter table public.app_settings drop constraint if exists app_settings_direct_settlement_boolean;
alter table public.app_settings add constraint app_settings_direct_settlement_boolean
  check (key <> 'direct_settlement_enabled' or jsonb_typeof(value) = 'boolean');

-- A signed-in caller (an admin through the "settings admin write" policy, for
-- example) can change this key only through admin_set_feature_toggle(),
-- which needs aal2 to turn it on and audits the change. No-session callers
-- (migrations, the SQL editor, the service role) are not affected.
create or replace function public.guard_direct_settlement_switch()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.key = 'direct_settlement_enabled'
     and auth.uid() is not null
     and coalesce(current_setting('cpay.feature_toggle_rpc', true), '') <> 'on' then
    raise exception 'Change direct payments in Admin → Settings (two-step sign-in needed to turn them on)';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_guard_direct_settlement_switch on public.app_settings;
create trigger trg_guard_direct_settlement_switch
  before insert or update on public.app_settings
  for each row execute function public.guard_direct_settlement_switch();

create or replace function public.direct_settlement_enabled()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((select value = 'true'::jsonb from app_settings where key = 'direct_settlement_enabled'), false)
$$;
revoke all on function public.direct_settlement_enabled() from public, anon, authenticated;
grant execute on function public.direct_settlement_enabled() to service_role;

-- ---------- 1. Columns ----------
alter table public.profiles
  add column if not exists direct_settlement_blocked boolean not null default false;
comment on column public.profiles.direct_settlement_blocked is
  'Set by an admin: this account''s direct links stop taking payments. Never redirects them anywhere.';

alter table public.payment_links
  add column if not exists settlement_mode text not null default 'custodial';
alter table public.payment_links drop constraint if exists payment_links_settlement_mode_check;
alter table public.payment_links add constraint payment_links_settlement_mode_check
  check (settlement_mode in ('custodial', 'direct'));
comment on column public.payment_links.settlement_mode is
  'custodial: payments go to the CPAY platform wallet and the owner''s CPAY balance. direct: payments go straight to the owner''s own wallet (direct_payments) and are never part of a CPAY balance. Changed only by the owner with set_link_settlement_mode().';

-- ---------- 2. Where a merchant's direct payments go ----------
create table if not exists public.settlement_destinations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null default 'lightning_address' check (kind = 'lightning_address'),
  address text not null
    check (length(address) <= 320 and address ~ '^[a-z0-9._+-]{1,64}@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'),
  callback_host text not null check (length(callback_host) between 3 and 253),
  min_sendable_msat bigint not null check (min_sendable_msat >= 1),
  max_sendable_msat bigint not null,
  checked_at timestamptz not null,
  ready_at timestamptz not null,
  status text not null default 'active' check (status in ('active', 'removed')),
  -- clock_timestamp(): "the newest address" must be well defined even for
  -- two saves in one transaction.
  created_at timestamptz not null default clock_timestamp(),
  removed_at timestamptz,
  constraint settlement_destinations_limits check (max_sendable_msat >= min_sendable_msat),
  constraint settlement_destinations_removed check ((status = 'removed') = (removed_at is not null))
);
create index if not exists settlement_destinations_user_idx
  on public.settlement_destinations (user_id, created_at desc);
comment on table public.settlement_destinations is
  'A merchant''s own Lightning address for direct payments. The newest active row whose ready_at has passed is the one used.';

-- ---------- 3. Direct payments (records only, never a balance) ----------
create table if not exists public.direct_payments (
  id uuid primary key default gen_random_uuid(),
  payment_link_id uuid not null references public.payment_links(id),
  user_id uuid not null references public.profiles(id),
  destination_id uuid not null references public.settlement_destinations(id),
  destination_address text not null,
  client_request_id uuid,
  buyer_amount numeric(12,2) not null check (buyer_amount > 0),
  amount_usd numeric(12,2) not null check (amount_usd > 0),
  amount_msat bigint not null check (amount_msat > 0 and amount_msat % 1000 = 0),
  btc_usd_rate numeric(14,2) not null check (btc_usd_rate > 0),
  rate_sources text[] not null,
  bolt11 text not null check (length(bolt11) between 20 and 7089),
  payment_hash text not null unique check (payment_hash ~ '^[0-9a-f]{64}$'),
  verify_url text not null check (verify_url ~ '^https://'),
  expires_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'paid', 'expired')),
  preimage text check (preimage ~ '^[0-9a-f]{64}$'),
  paid_observed_at timestamptz,
  last_checked_at timestamptz,
  check_count integer not null default 0,
  customer_country text,
  customer_city text,
  created_at timestamptz not null default now(),
  constraint direct_payments_paid_has_proof
    check ((status = 'paid') = (preimage is not null and paid_observed_at is not null)),
  -- The proof: the preimage hashes to the payment hash of the invoice the
  -- payer was shown.
  constraint direct_payments_preimage_matches
    check (preimage is null or encode(sha256(decode(preimage, 'hex')), 'hex') = payment_hash)
);
create unique index if not exists direct_payments_link_request_uidx
  on public.direct_payments (payment_link_id, client_request_id) where client_request_id is not null;
create index if not exists direct_payments_user_created_idx on public.direct_payments (user_id, created_at desc);
create index if not exists direct_payments_open_idx on public.direct_payments (last_checked_at nulls first) where status <> 'paid';
comment on table public.direct_payments is
  'Payments made straight to a merchant''s own wallet. CPAY never held them: they are not in any balance, cannot be withdrawn, refunded or moved by CPAY.';

-- ---------- 4. Row-level security ----------
alter table public.settlement_destinations enable row level security;
alter table public.direct_payments enable row level security;
revoke all on public.settlement_destinations from public, anon, authenticated;
revoke all on public.direct_payments from public, anon, authenticated;
grant select on public.settlement_destinations to authenticated;
grant select on public.direct_payments to authenticated;
grant all on public.settlement_destinations to service_role;
grant all on public.direct_payments to service_role;

drop policy if exists settlement_destinations_own on public.settlement_destinations;
create policy settlement_destinations_own on public.settlement_destinations
  for select to authenticated using (user_id = auth.uid());
drop policy if exists direct_payments_own on public.direct_payments;
create policy direct_payments_own on public.direct_payments
  for select to authenticated using (user_id = auth.uid());

-- ---------- 5. Guards ----------
-- Only set_link_settlement_mode() may set or change a link's mode. It sets
-- cpay.settlement_mode_rpc for its own statement; everyone else, admins
-- and the service role included, is refused.
create or replace function public.guard_link_settlement_mode()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if coalesce(current_setting('cpay.settlement_mode_rpc', true), '') = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' and new.settlement_mode is distinct from 'custodial' then
    raise exception 'A new link starts with CPAY balance payments; its owner can then choose direct payments';
  end if;
  if tg_op = 'UPDATE' and new.settlement_mode is distinct from old.settlement_mode then
    raise exception 'Only the link''s owner can change where its payments go (set_link_settlement_mode)';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_guard_link_settlement_mode on public.payment_links;
create trigger trg_guard_link_settlement_mode
  before insert or update on public.payment_links
  for each row execute function public.guard_link_settlement_mode();

-- A direct link never creates a custodial payment, whatever the caller.
create or replace function public.guard_payment_settlement_mode()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if exists (select 1 from payment_links where id = new.payment_link_id and settlement_mode = 'direct') then
    raise exception 'This link takes direct payments only';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_guard_payment_settlement_mode on public.payments;
create trigger trg_guard_payment_settlement_mode
  before insert on public.payments
  for each row execute function public.guard_payment_settlement_mode();

-- Direct payments: what was shown to the payer never changes; paid is final;
-- pending becomes expired only after expires_at; rows are never deleted.
create or replace function public.guard_direct_payment_changes()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Direct payment records are kept';
  end if;
  if (to_jsonb(new) - array['status', 'preimage', 'paid_observed_at', 'last_checked_at', 'check_count'])
     is distinct from (to_jsonb(old) - array['status', 'preimage', 'paid_observed_at', 'last_checked_at', 'check_count']) then
    raise exception 'A direct payment''s invoice details cannot change';
  end if;
  if old.status = 'paid' and (new.status <> 'paid' or new.preimage is distinct from old.preimage
                              or new.paid_observed_at is distinct from old.paid_observed_at) then
    raise exception 'A paid direct payment is final';
  end if;
  if old.status = 'expired' and new.status = 'pending' then
    raise exception 'An expired direct payment does not reopen';
  end if;
  if old.status = 'pending' and new.status = 'expired' and now() < old.expires_at then
    raise exception 'A direct payment expires only after its invoice does';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_guard_direct_payment_changes on public.direct_payments;
create trigger trg_guard_direct_payment_changes
  before update or delete on public.direct_payments
  for each row execute function public.guard_direct_payment_changes();

create or replace function public.guard_settlement_destination_changes()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Payout destinations are kept for the record; remove marks them removed';
  end if;
  if (to_jsonb(new) - array['status', 'removed_at']) is distinct from (to_jsonb(old) - array['status', 'removed_at']) then
    raise exception 'A saved Lightning address cannot be edited; save a new one';
  end if;
  if old.status = 'removed' and new.status <> 'removed' then
    raise exception 'A removed Lightning address stays removed';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_guard_settlement_destination_changes on public.settlement_destinations;
create trigger trg_guard_settlement_destination_changes
  before update or delete on public.settlement_destinations
  for each row execute function public.guard_settlement_destination_changes();

-- ---------- 6. Owner functions (signed-in Freelancer) ----------
create or replace function public.get_my_direct_settlement()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_current jsonb;
  v_pending jsonb;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  select jsonb_build_object('id', d.id, 'address', d.address, 'ready_at', d.ready_at, 'created_at', d.created_at)
    into v_current
    from settlement_destinations d
   where d.user_id = v_uid and d.status = 'active' and d.ready_at <= now()
   order by d.created_at desc limit 1;
  select jsonb_build_object('id', d.id, 'address', d.address, 'ready_at', d.ready_at, 'created_at', d.created_at)
    into v_pending
    from settlement_destinations d
   where d.user_id = v_uid and d.status = 'active' and d.ready_at > now()
   order by d.created_at desc limit 1;
  return jsonb_build_object(
    'enabled', direct_settlement_enabled(),
    'blocked', coalesce((select direct_settlement_blocked from profiles where id = v_uid), false),
    'current', v_current,
    'pending', v_pending
  );
end;
$$;
revoke all on function public.get_my_direct_settlement() from public, anon;
grant execute on function public.get_my_direct_settlement() to authenticated, service_role;

create or replace function public.set_link_settlement_mode(p_link_id uuid, p_mode text)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_link payment_links;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_mode is null or p_mode not in ('custodial', 'direct') then raise exception 'Choose direct or CPAY balance'; end if;
  select * into v_link from payment_links where id = p_link_id and deleted_at is null for update;
  -- Someone else's link and no link at all get the same answer.
  if not found or v_link.user_id is distinct from v_uid then raise exception 'Payment link not found'; end if;
  if not account_is_active(v_uid) then raise exception 'Account approval is required first'; end if;
  if p_mode = 'direct' then
    if not direct_settlement_enabled() then raise exception 'Direct payments are not available yet'; end if;
    if coalesce((select direct_settlement_blocked from profiles where id = v_uid), false) then
      raise exception 'Direct payments are turned off for this account. Contact support.';
    end if;
    if not exists (select 1 from settlement_destinations where user_id = v_uid and status = 'active') then
      raise exception 'Add your Lightning address first';
    end if;
    -- Only an address already in use: a link switched while its address
    -- still waits would take no payment at all until the wait ends.
    if not exists (select 1 from system_direct_destination_for(v_uid)) then
      raise exception 'Your Lightning address is not in use yet. Links can pay it once it is (24 hours after you saved it).';
    end if;
  end if;
  if v_link.settlement_mode = p_mode then return p_mode; end if;
  perform set_config('cpay.settlement_mode_rpc', 'on', true);
  update payment_links set settlement_mode = p_mode where id = p_link_id;
  perform set_config('cpay.settlement_mode_rpc', 'off', true);
  perform record_audit('link.settlement_mode', 'payment_link', p_link_id::text,
    jsonb_build_object('settlement_mode', v_link.settlement_mode), jsonb_build_object('settlement_mode', p_mode));
  return p_mode;
end;
$$;
revoke all on function public.set_link_settlement_mode(uuid, text) from public, anon;
grant execute on function public.set_link_settlement_mode(uuid, text) to authenticated, service_role;

-- ---------- 7. Service-role functions (Edge Functions only) ----------
-- The destination direct payments use right now, or nothing: switch on,
-- account active and not blocked, newest active address past its wait.
create or replace function public.system_direct_destination_for(p_user_id uuid)
returns table(id uuid, address text)
language sql stable security definer set search_path = public
as $$
  select d.id, d.address
    from settlement_destinations d
    join profiles p on p.id = d.user_id
   where d.user_id = p_user_id
     and d.status = 'active'
     and d.ready_at <= now()
     and p.account_status = 'active'
     and not p.direct_settlement_blocked
     and direct_settlement_enabled()
   order by d.created_at desc
   limit 1
$$;

-- Saved only after the settlement-destination function has checked the
-- address with its provider and the merchant has signed in again recently.
-- The same address as the one in use is a no-op (no new wait).
create or replace function public.system_set_settlement_destination(
  p_user_id uuid, p_address text, p_callback_host text, p_min_msat bigint, p_max_msat bigint
) returns table(id uuid, address text, ready_at timestamptz, unchanged boolean)
language plpgsql security definer set search_path = public
as $$
declare
  v_existing settlement_destinations;
  v_ready settlement_destinations;
  v_new settlement_destinations;
  v_cancelled integer;
begin
  if p_user_id is null then raise exception 'No account'; end if;
  if not direct_settlement_enabled() then raise exception 'Direct payments are not available yet'; end if;
  if not exists (select 1 from profiles where profiles.id = p_user_id and role = 'creator' and account_status = 'active') then
    raise exception 'Account approval is required first';
  end if;
  if coalesce((select direct_settlement_blocked from profiles where profiles.id = p_user_id), false) then
    raise exception 'Direct payments are turned off for this account. Contact support.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('settlement_destination:' || p_user_id::text, 0));
  select * into v_existing from settlement_destinations d
   where d.user_id = p_user_id and d.status = 'active'
   order by d.created_at desc limit 1;
  -- The newest address again (in use or waiting): nothing new, no new wait.
  if found and v_existing.address = lower(p_address) then
    return query select v_existing.id, v_existing.address, v_existing.ready_at, true;
    return;
  end if;
  -- The address already in use, while another one waits: keep the one in
  -- use and cancel the waiting one (for example one a hijacked session
  -- saved). No new wait for an address that is already live.
  select * into v_ready from settlement_destinations d
   where d.user_id = p_user_id and d.status = 'active' and d.ready_at <= now()
   order by d.created_at desc limit 1;
  if found and v_ready.address = lower(p_address) then
    update settlement_destinations d set status = 'removed', removed_at = now()
     where d.user_id = p_user_id and d.status = 'active' and d.ready_at > now();
    get diagnostics v_cancelled = row_count;
    insert into audit_log(actor_id, actor_email, action, subject_type, subject_id, old_value, new_value, note)
    values (p_user_id, (select email from profiles where profiles.id = p_user_id), 'settlement.destination_kept', 'profile', p_user_id::text,
            jsonb_build_object('waiting_cancelled', v_cancelled), jsonb_build_object('address', v_ready.address),
            'settlement-destination function, after a fresh sign-in');
    return query select v_ready.id, v_ready.address, v_ready.ready_at, true;
    return;
  end if;
  -- One waiting address at a time: a newer one replaces one still waiting.
  update settlement_destinations d set status = 'removed', removed_at = now()
   where d.user_id = p_user_id and d.status = 'active' and d.ready_at > now();
  insert into settlement_destinations(user_id, address, callback_host, min_sendable_msat, max_sendable_msat, checked_at, ready_at)
  values (p_user_id, lower(p_address), lower(p_callback_host), p_min_msat, p_max_msat, now(), now() + interval '24 hours')
  returning * into v_new;
  insert into audit_log(actor_id, actor_email, action, subject_type, subject_id, old_value, new_value, note)
  values (p_user_id, (select email from profiles where profiles.id = p_user_id), 'settlement.destination_saved', 'profile', p_user_id::text,
          case when v_existing.id is null then null else jsonb_build_object('address', v_existing.address) end,
          jsonb_build_object('address', v_new.address, 'ready_at', v_new.ready_at), 'settlement-destination function, after a fresh sign-in');
  return query select v_new.id, v_new.address, v_new.ready_at, false;
end;
$$;

create or replace function public.system_remove_settlement_destinations(p_user_id uuid)
returns integer
language plpgsql security definer set search_path = public
as $$
declare v_n integer;
begin
  update settlement_destinations set status = 'removed', removed_at = now()
   where user_id = p_user_id and status = 'active';
  get diagnostics v_n = row_count;
  if v_n > 0 then
    insert into audit_log(actor_id, actor_email, action, subject_type, subject_id, old_value, new_value, note)
    values (p_user_id, (select email from profiles where id = p_user_id), 'settlement.destination_removed', 'profile', p_user_id::text,
            null, jsonb_build_object('removed', v_n), 'settlement-destination function, after a fresh sign-in');
  end if;
  return v_n;
end;
$$;

-- Claim the right to ask the provider about one payment: at most once per
-- p_min_interval_seconds however many pages poll it, and only for a week.
create or replace function public.system_claim_direct_check(p_id uuid, p_min_interval_seconds integer)
returns setof public.direct_payments
language sql security definer set search_path = public
as $$
  update direct_payments
     set last_checked_at = now(), check_count = check_count + 1
   where id = p_id
     and status <> 'paid'
     and created_at > now() - interval '7 days'
     and (last_checked_at is null or last_checked_at < now() - make_interval(secs => greatest(p_min_interval_seconds, 1)))
  returning *
$$;

-- The next payments for the reconcile sweep, oldest check first.
create or replace function public.system_claim_direct_checks(p_limit integer, p_min_interval_seconds integer)
returns setof public.direct_payments
language sql security definer set search_path = public
as $$
  update direct_payments
     set last_checked_at = now(), check_count = check_count + 1
   where id in (
     select id from direct_payments
      where status <> 'paid'
        and created_at > now() - interval '7 days'
        -- An expired invoice can still be paid late, but rarely: every 10 min.
        and (last_checked_at is null or last_checked_at < now() - make_interval(secs =>
              case when status = 'expired' then greatest(p_min_interval_seconds, 600) else greatest(p_min_interval_seconds, 1) end))
      order by last_checked_at nulls first
      limit least(greatest(p_limit, 1), 100)
      for update skip locked)
  returning *
$$;

-- Paid, with proof. Idempotent: the same proof again is 'paid'; a
-- preimage that does not hash to the payment hash is refused by the CHECK.
create or replace function public.system_record_direct_payment_proof(p_id uuid, p_preimage text)
returns text
language plpgsql security definer set search_path = public
as $$
declare v_status text;
begin
  update direct_payments
     set status = 'paid', preimage = lower(p_preimage), paid_observed_at = now()
   where id = p_id and status <> 'paid'
  returning status into v_status;
  if v_status is null then
    select status into v_status from direct_payments where id = p_id;
  end if;
  return v_status;
end;
$$;

create or replace function public.system_expire_direct_payment(p_id uuid, p_grace_seconds integer)
returns text
language plpgsql security definer set search_path = public
as $$
declare v_status text;
begin
  update direct_payments set status = 'expired'
   where id = p_id and status = 'pending' and now() > expires_at + make_interval(secs => greatest(p_grace_seconds, 0))
  returning status into v_status;
  if v_status is null then
    select status into v_status from direct_payments where id = p_id;
  end if;
  return v_status;
end;
$$;

-- What a payer's invoice page may know about one direct payment.
create or replace function public.system_direct_payment_public(p_id uuid)
returns table(id uuid, status text, bolt11 text, amount_usd numeric, amount_sats bigint, expires_at timestamptz,
              merchant_name text, link_slug text, destination_address text, paid_at timestamptz, preimage text, payment_hash text)
language sql stable security definer set search_path = public
as $$
  select dp.id, dp.status, dp.bolt11, dp.amount_usd, dp.amount_msat / 1000, dp.expires_at,
         coalesce(pl.display_name, pl.slug), pl.slug, dp.destination_address,
         dp.paid_observed_at, dp.preimage, dp.payment_hash
    from direct_payments dp
    join payment_links pl on pl.id = dp.payment_link_id
   where dp.id = p_id
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'system_direct_destination_for(uuid)',
    'system_set_settlement_destination(uuid, text, text, bigint, bigint)',
    'system_remove_settlement_destinations(uuid)',
    'system_claim_direct_check(uuid, integer)',
    'system_claim_direct_checks(integer, integer)',
    'system_record_direct_payment_proof(uuid, text)',
    'system_expire_direct_payment(uuid, integer)',
    'system_direct_payment_public(uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- ---------- 8. Admin ----------
-- An admin can stop an account's direct links from taking payments (abuse,
-- a broken address), never point them anywhere.
create or replace function public.admin_set_direct_settlement_blocked(p_user_id uuid, p_blocked boolean)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare v_old boolean;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if p_user_id is null or p_blocked is null then raise exception 'Choose an account'; end if;
  select direct_settlement_blocked into v_old from profiles where id = p_user_id for update;
  if not found then raise exception 'Account not found'; end if;
  update profiles set direct_settlement_blocked = p_blocked where id = p_user_id;
  perform record_audit('settlement.direct_blocked', 'profile', p_user_id::text,
    jsonb_build_object('blocked', v_old), jsonb_build_object('blocked', p_blocked));
  return p_blocked;
end;
$$;
revoke all on function public.admin_set_direct_settlement_blocked(uuid, boolean) from public, anon;
grant execute on function public.admin_set_direct_settlement_blocked(uuid, boolean) to authenticated, service_role;

create or replace function public.admin_list_direct_payments(p_limit integer, p_offset integer)
returns table(id uuid, created_at timestamptz, status text, amount_usd numeric, amount_sats bigint,
              destination_address text, link_slug text, user_id uuid, display_name text, paid_at timestamptz)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  return query
    select dp.id, dp.created_at, dp.status, dp.amount_usd, dp.amount_msat / 1000, dp.destination_address,
           pl.slug, dp.user_id, pr.display_name, dp.paid_observed_at
      from direct_payments dp
      join payment_links pl on pl.id = dp.payment_link_id
      join profiles pr on pr.id = dp.user_id
     order by dp.created_at desc
     limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end;
$$;
revoke all on function public.admin_list_direct_payments(integer, integer) from public, anon;
grant execute on function public.admin_list_direct_payments(integer, integer) to authenticated, service_role;

-- The switch joins the admin toggles. Turning it ON needs aal2, like the
-- other money-routing switch (admin_mfa_required). 20261014030000 body plus
-- the new key and its check.
create or replace function public.admin_set_feature_toggle(p_key text, p_enabled boolean)
returns boolean
language plpgsql security definer set search_path to 'public'
as $function$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if p_key not in (
    'emergency_payments_stop','emergency_withdrawals_stop','manual_withdrawals_enabled',
    'auto_withdraw_enabled','public_feed_enabled','hide_small_payments_enabled',
    'admin_mfa_required','direct_settlement_enabled'
  ) then raise exception 'Unknown toggle'; end if;
  if p_key = 'admin_mfa_required' and p_enabled then
    if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
      raise exception 'Enter your authenticator code first (sign in again with two-step sign-in), then turn this on';
    end if;
    if exists (select 1 from profiles p
               where p.role = 'admin' and p.account_status = 'active'
                 and not exists (select 1 from auth.mfa_factors f where f.user_id = p.id and f.status::text = 'verified')) then
      raise exception 'Every active admin needs a verified authenticator before two-step sign-in can be required';
    end if;
  end if;
  if p_key = 'direct_settlement_enabled' and p_enabled
     and coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'Enter your authenticator code first (sign in again with two-step sign-in), then turn direct payments on';
  end if;
  perform set_config('cpay.feature_toggle_rpc', 'on', true);
  insert into app_settings(key, value) values (p_key, to_jsonb(p_enabled))
  on conflict (key) do update set value = to_jsonb(p_enabled);
  perform set_config('cpay.feature_toggle_rpc', 'off', true);
  perform record_audit('settings.feature_toggle', 'setting', p_key,
    null, jsonb_build_object('enabled', p_enabled));
  return p_enabled;
end;
$function$;

-- ---------- 9. The payment page learns a link's mode ----------
-- 0093's columns, plus settlement_mode and direct_ready (a direct link that
-- can take a payment right now). Return type changes: drop and re-create
-- with the same grants.
drop function if exists public.get_link_preview(text);
create function public.get_link_preview(p_slug text)
returns table(display_name text, is_active boolean, og_image text, cost_percent numeric,
              theme text, wallet_mode text, invoice_theme text, settlement_mode text, direct_ready boolean)
language sql
stable
security definer
set search_path to 'public'
as $$
  select
    pl.display_name,
    pl.is_active,
    pl.og_image,
    coalesce(pl.cost_percent, pr.cost_percent, 0),
    pl.theme,
    coalesce(pl.wallet_mode, pr.default_wallet_mode, 'all_wallets'),
    coalesce(pl.invoice_theme, 'default'),
    pl.settlement_mode,
    pl.settlement_mode = 'direct' and exists (select 1 from system_direct_destination_for(pl.user_id))
  from payment_links pl
  join profiles pr on pr.id = pl.user_id
  where pl.slug = p_slug
    and pl.deleted_at is null
    and pr.account_status = 'active'
  limit 1;
$$;
revoke all on function public.get_link_preview(text) from public;
grant execute on function public.get_link_preview(text) to anon, authenticated;

-- ---------- 10. Public store fallback name ----------
create or replace function public.get_public_store(p_user_id uuid)
returns table (
  display_name text,
  tagline text,
  bio text,
  avatar_url text,
  theme text,
  accent text,
  cta text,
  links jsonb
)
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(pr.display_name,'CPAY member'),
         coalesce(pr.store_tagline,''),
         coalesce(pr.store_bio,''),
         coalesce(pr.store_avatar_url,''),
         coalesce(pr.store_theme,'midnight'),
         coalesce(pr.store_accent,'#00D632'),
         coalesce(pr.store_cta,'Pay now'),
         coalesce((select jsonb_agg(jsonb_build_object(
           'slug',l.slug,
           'display_name',coalesce(l.display_name,l.slug),
           'theme',coalesce(l.theme,'keypad'),
           'og_image',l.og_image
         ) order by l.created_at desc)
         from payment_links l where l.user_id=p_user_id and l.is_active=true and l.deleted_at is null),'[]'::jsonb)
  from profiles pr
  where pr.id=p_user_id
    and pr.role = 'creator'
    and pr.account_status = 'active';
$$;
revoke all on function public.get_public_store(uuid) from public;
grant execute on function public.get_public_store(uuid) to anon, authenticated, service_role;
