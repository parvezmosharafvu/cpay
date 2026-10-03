-- CPAY merchant API: keys, scopes, idempotency, rate limiting, audit.
--
-- A merchant is an active creator or reseller profile. Keys look like
-- cpay_sk_<8 hex>_<64 hex>; only the sha256 of the whole key is stored, the
-- plaintext is returned once. The payment service (payment-service/) calls
-- the service_role functions below and keeps making invoices through its
-- existing createInvoice path.

create table if not exists public.merchant_api_keys (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 60),
  key_prefix  text not null,
  key_hash    text not null unique,
  scopes      text[] not null,
  created_at  timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at  timestamptz,
  check (scopes <> '{}' and scopes <@ array['invoices:write','invoices:read','payments:read','balance:read'])
);
create index if not exists idx_merchant_keys_user on public.merchant_api_keys(user_id, created_at desc);
alter table public.merchant_api_keys enable row level security;
revoke all on public.merchant_api_keys from public, anon, authenticated;

create table if not exists public.merchant_idempotency (
  key_id       uuid not null references public.merchant_api_keys(id) on delete cascade,
  idem_key     text not null,
  request_hash text not null,
  payment_id   uuid references public.payments(id) on delete set null,
  created_at   timestamptz not null default now(),
  primary key (key_id, idem_key)
);
alter table public.merchant_idempotency enable row level security;
revoke all on public.merchant_idempotency from public, anon, authenticated;

create table if not exists public.merchant_api_rate_limits (
  key_id uuid primary key references public.merchant_api_keys(id) on delete cascade,
  window_started_at timestamptz not null default now(),
  request_count integer not null default 0
);
alter table public.merchant_api_rate_limits enable row level security;
revoke all on public.merchant_api_rate_limits from public, anon, authenticated;

-- Merchant-created payments are tagged so they can be told apart and looked up per key.
alter table public.payments add column if not exists merchant_reference text;
alter table public.payments add column if not exists merchant_key_id uuid references public.merchant_api_keys(id) on delete set null;
create index if not exists idx_payments_merchant_ref on public.payments(user_id, merchant_reference) where merchant_reference is not null;

-- ---------- key management (the signed-in merchant, JWT) ----------
create or replace function public.merchant_create_api_key(p_name text, p_scopes text[])
returns table(id uuid, api_key text, key_prefix text, scopes text[])
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_prefix text := 'cpay_sk_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  v_secret text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_key text;
  v_id uuid;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not exists (select 1 from profiles where profiles.id = v_uid and role in ('creator','moderator') and account_status = 'active') then
    raise exception 'Only active merchant accounts can create API keys';
  end if;
  if (select count(*) from merchant_api_keys k where k.user_id = v_uid and k.revoked_at is null) >= 10 then
    raise exception 'Revoke an existing key before creating another (limit 10)';
  end if;
  v_key := v_prefix || '_' || v_secret;
  insert into merchant_api_keys(user_id, name, key_prefix, key_hash, scopes)
  values (v_uid, trim(p_name), v_prefix, encode(sha256(convert_to(v_key, 'UTF8')), 'hex'), p_scopes)
  returning merchant_api_keys.id into v_id;
  insert into audit_log(actor_id, actor_email, action, subject_type, subject_id, new_value)
  values (v_uid, (select email from profiles where profiles.id = v_uid), 'merchant_api.key_created', 'merchant_api_key', v_id::text,
          jsonb_build_object('prefix', v_prefix, 'scopes', to_jsonb(p_scopes)));
  return query select v_id, v_key, v_prefix, p_scopes;
end; $$;

create or replace function public.merchant_list_api_keys()
returns table(id uuid, name text, key_prefix text, scopes text[], created_at timestamptz, last_used_at timestamptz, revoked_at timestamptz)
language plpgsql security definer stable set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  return query select k.id, k.name, k.key_prefix, k.scopes, k.created_at, k.last_used_at, k.revoked_at
    from merchant_api_keys k where k.user_id = auth.uid() order by k.created_at desc;
end; $$;

create or replace function public.merchant_revoke_api_key(p_key_id uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  update merchant_api_keys set revoked_at = now()
   where id = p_key_id and user_id = auth.uid() and revoked_at is null;
  get diagnostics v_n = row_count;
  if v_n = 1 then
    insert into audit_log(actor_id, actor_email, action, subject_type, subject_id)
    values (auth.uid(), (select email from profiles where id = auth.uid()), 'merchant_api.key_revoked', 'merchant_api_key', p_key_id::text);
  end if;
  return v_n = 1;
end; $$;

revoke all on function public.merchant_create_api_key(text, text[]) from public, anon, service_role;
revoke all on function public.merchant_list_api_keys() from public, anon, service_role;
revoke all on function public.merchant_revoke_api_key(uuid) from public, anon, service_role;
grant execute on function public.merchant_create_api_key(text, text[]) to authenticated;
grant execute on function public.merchant_list_api_keys() to authenticated;
grant execute on function public.merchant_revoke_api_key(uuid) to authenticated;

-- ---------- request path (payment service, service_role) ----------
create or replace function public.merchant_authenticate(p_key text)
returns table(key_id uuid, user_id uuid, scopes text[])
language plpgsql security definer set search_path = public as $$
declare r merchant_api_keys%rowtype;
begin
  if p_key is null or length(p_key) > 200 then return; end if;
  select * into r from merchant_api_keys k where k.key_hash = encode(sha256(convert_to(p_key, 'UTF8')), 'hex');
  if not found or r.revoked_at is not null then return; end if;
  if not exists (select 1 from profiles p where p.id = r.user_id and p.account_status = 'active' and p.role in ('creator','moderator')) then return; end if;
  update merchant_api_keys set last_used_at = now() where id = r.id;
  return query select r.id, r.user_id, r.scopes;
end; $$;

-- true while under the limit for the current window
create or replace function public.merchant_claim_rate_limit(p_key_id uuid, p_limit integer default 60, p_window_seconds integer default 60)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  insert into merchant_api_rate_limits(key_id, window_started_at, request_count) values (p_key_id, now(), 1)
  on conflict (key_id) do update set
    window_started_at = case when now() - merchant_api_rate_limits.window_started_at >= make_interval(secs => p_window_seconds) then now() else merchant_api_rate_limits.window_started_at end,
    request_count = case when now() - merchant_api_rate_limits.window_started_at >= make_interval(secs => p_window_seconds) then 1 else merchant_api_rate_limits.request_count + 1 end
  returning request_count into v_count;
  return v_count <= p_limit;
end; $$;

create or replace function public.merchant_audit(p_key_id uuid, p_action text, p_subject_type text, p_subject_id text, p_note text default null)
returns void
language sql security definer set search_path = public as $$
  insert into audit_log(actor_id, actor_email, action, subject_type, subject_id, note)
  select k.user_id, p.email, p_action, p_subject_type, p_subject_id, p_note
    from merchant_api_keys k join profiles p on p.id = k.user_id where k.id = p_key_id;
$$;

-- Reserve the payments row for an invoice. Returns the existing row for a
-- repeated Idempotency-Key with the same body; raises 'idempotency_conflict'
-- when the same key arrives with a different body.
create or replace function public.merchant_create_payment(
  p_key_id uuid, p_amount numeric, p_reference text, p_idem_key text, p_expires_minutes integer default 60)
returns table(payment_id uuid, replayed boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid;
  v_hash text;
  v_existing merchant_idempotency%rowtype;
  v_limit numeric;
  v_id uuid;
begin
  select user_id into v_user from merchant_api_keys where id = p_key_id and revoked_at is null;
  if v_user is null then raise exception 'invalid_key'; end if;
  if p_amount is null or p_amount < 1 or p_amount > 5000 or scale(p_amount) > 2 then raise exception 'invalid_amount'; end if;
  if p_reference is not null and length(p_reference) > 100 then raise exception 'invalid_reference'; end if;
  if exists (select 1 from app_settings where key = 'emergency_payments_stop' and (value = 'true'::jsonb)) then
    raise exception 'payments_paused';
  end if;
  select coalesce(max_invoice_amount, 5000) into v_limit from profile_limits where user_id = v_user;
  if p_amount > coalesce(v_limit, 5000) then raise exception 'above_profile_limit'; end if;

  v_hash := encode(sha256(convert_to(p_amount::text || '|' || coalesce(p_reference, ''), 'UTF8')), 'hex');
  if p_idem_key is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_key_id::text || p_idem_key, 0));
    select * into v_existing from merchant_idempotency where key_id = p_key_id and idem_key = p_idem_key;
    if found then
      if v_existing.request_hash <> v_hash then raise exception 'idempotency_conflict'; end if;
      return query select v_existing.payment_id, true;
      return;
    end if;
  end if;

  insert into payments(user_id, method, buyer_amount, amount_requested, status, expires_at, merchant_reference, merchant_key_id)
  values (v_user, 'lightning', p_amount, p_amount, 'new', now() + make_interval(mins => p_expires_minutes), p_reference, p_key_id)
  returning id into v_id;
  if p_idem_key is not null then
    insert into merchant_idempotency(key_id, idem_key, request_hash, payment_id) values (p_key_id, p_idem_key, v_hash, v_id);
  end if;
  return query select v_id, false;
end; $$;

-- Every read is scoped to the key's owner; another merchant's id looks like a missing row.
create or replace function public.merchant_get_payment(p_key_id uuid, p_payment_id uuid)
returns jsonb
language sql security definer stable set search_path = public as $$
  select jsonb_build_object(
    'id', p.id, 'status', p.status, 'amount', p.amount_requested, 'amount_settled', p.amount_settled,
    'amount_sat', p.amount_sat, 'reference', p.merchant_reference, 'payment_hash', p.invoice_ref,
    'bolt11', p.lightning_invoice, 'created_at', p.created_at, 'expires_at', p.expires_at, 'settled_at', p.settled_at)
  from payments p join merchant_api_keys k on k.user_id = p.user_id
  where p.id = p_payment_id and k.id = p_key_id;
$$;

create or replace function public.merchant_list_payments(p_key_id uuid, p_limit integer default 25, p_offset integer default 0, p_status text default null)
returns jsonb
language sql security definer stable set search_path = public as $$
  with k as (select user_id from merchant_api_keys where id = p_key_id and revoked_at is null),
  f as (
    select p.* from payments p join k on k.user_id = p.user_id
    where (p_status is null or p.status = p_status) and p.lightning_invoice is not null
  ), page as (
    select * from f order by created_at desc limit least(greatest(coalesce(p_limit, 25), 1), 100) offset greatest(coalesce(p_offset, 0), 0)
  )
  select jsonb_build_object(
    'total', (select count(*) from f),
    'data', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id, 'status', status, 'amount', amount_requested, 'amount_settled', amount_settled,
      'reference', merchant_reference, 'created_at', created_at, 'settled_at', settled_at) order by created_at desc) from page), '[]'::jsonb));
$$;

create or replace function public.merchant_balance(p_key_id uuid)
returns jsonb
language sql security definer stable set search_path = public as $$
  select to_jsonb(b) from merchant_api_keys k, lateral get_balance_for(k.user_id) b where k.id = p_key_id;
$$;

revoke all on function public.merchant_authenticate(text), public.merchant_claim_rate_limit(uuid, integer, integer),
  public.merchant_audit(uuid, text, text, text, text), public.merchant_create_payment(uuid, numeric, text, text, integer),
  public.merchant_get_payment(uuid, uuid), public.merchant_list_payments(uuid, integer, integer, text),
  public.merchant_balance(uuid) from public, anon, authenticated;
grant execute on function public.merchant_authenticate(text), public.merchant_claim_rate_limit(uuid, integer, integer),
  public.merchant_audit(uuid, text, text, text, text), public.merchant_create_payment(uuid, numeric, text, text, integer),
  public.merchant_get_payment(uuid, uuid), public.merchant_list_payments(uuid, integer, integer, text),
  public.merchant_balance(uuid) to service_role;
