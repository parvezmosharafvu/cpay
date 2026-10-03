-- CPAY merchant webhooks: endpoints, signed event outbox, delivery log.
--
-- Events are written by a trigger on payments, so every path that moves a
-- payment through its states (settle_breez_payment, expiry, admin mark-settled)
-- emits them. The trigger never blocks a payment change: if it fails, the
-- payment update still commits. The payment service signs and delivers; the
-- signing secret never leaves the service_role / owner-visible-once paths.

create table if not exists public.merchant_webhook_endpoints (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  url         text not null check (url ~ '^https://[^\s]+$' and length(url) <= 500),
  secret      text not null,
  events      text[] not null check (events <> '{}' and events <@ array['payment.created','payment.pending','payment.succeeded','payment.failed','payment.expired']),
  is_active   boolean not null default true,
  consecutive_failures integer not null default 0,
  disabled_reason text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_mwe_user on public.merchant_webhook_endpoints(user_id);

create table if not exists public.merchant_webhook_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  payment_id  uuid not null references public.payments(id) on delete cascade,
  type        text not null,
  payload     jsonb not null,
  created_at  timestamptz not null default now(),
  unique (payment_id, type)
);

create table if not exists public.merchant_webhook_deliveries (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references public.merchant_webhook_events(id) on delete cascade,
  endpoint_id   uuid not null references public.merchant_webhook_endpoints(id) on delete cascade,
  status        text not null default 'pending' check (status in ('pending','succeeded','failed')),
  attempts      integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_status_code integer,
  last_error    text,
  delivered_at  timestamptz,
  created_at    timestamptz not null default now(),
  unique (event_id, endpoint_id)
);
create index if not exists idx_mwd_due on public.merchant_webhook_deliveries(next_attempt_at) where status = 'pending';

create table if not exists public.merchant_webhook_attempts (
  id           bigserial primary key,
  delivery_id  uuid not null references public.merchant_webhook_deliveries(id) on delete cascade,
  attempted_at timestamptz not null default now(),
  status_code  integer,
  error        text,
  duration_ms  integer
);
create index if not exists idx_mwa_delivery on public.merchant_webhook_attempts(delivery_id, attempted_at desc);

alter table public.merchant_webhook_endpoints enable row level security;
alter table public.merchant_webhook_events enable row level security;
alter table public.merchant_webhook_deliveries enable row level security;
alter table public.merchant_webhook_attempts enable row level security;
revoke all on public.merchant_webhook_endpoints, public.merchant_webhook_events,
  public.merchant_webhook_deliveries, public.merchant_webhook_attempts from public, anon, authenticated;

-- ---------- state machine hook ----------
create or replace function public.merchant_webhook_emit()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_type text;
  v_event uuid;
begin
  begin
    if tg_op = 'UPDATE' then
      if new.lightning_invoice is not null and old.lightning_invoice is null and new.status = 'new' then v_type := 'payment.created';
      elsif new.status is distinct from old.status then
        v_type := case new.status when 'pending' then 'payment.pending' when 'settled' then 'payment.succeeded'
                  when 'invalid' then 'payment.failed' when 'expired' then 'payment.expired' end;
      end if;
    elsif tg_op = 'INSERT' and new.lightning_invoice is not null and new.status = 'new' then
      v_type := 'payment.created';
    end if;
    if v_type is null then return null; end if;
    if not exists (select 1 from merchant_webhook_endpoints e
                    where e.user_id = new.user_id and e.is_active and v_type = any(e.events)) then
      return null;
    end if;
    insert into merchant_webhook_events(user_id, payment_id, type, payload)
    values (new.user_id, new.id, v_type, jsonb_build_object(
      'payment', jsonb_build_object('id', new.id, 'status', new.status, 'amount', new.amount_requested,
        'amount_settled', new.amount_settled, 'amount_sat', new.amount_sat, 'reference', new.merchant_reference,
        'created_at', new.created_at, 'expires_at', new.expires_at, 'settled_at', new.settled_at)))
    on conflict (payment_id, type) do nothing
    returning id into v_event;
    if v_event is not null then
      insert into merchant_webhook_deliveries(event_id, endpoint_id)
      select v_event, e.id from merchant_webhook_endpoints e
       where e.user_id = new.user_id and e.is_active and v_type = any(e.events);
    end if;
  exception when others then
    raise warning 'merchant webhook enqueue failed for payment %: %', new.id, sqlerrm;
  end;
  return null;
end; $$;
revoke all on function public.merchant_webhook_emit() from public, anon, authenticated;

drop trigger if exists merchant_webhook_emit on public.payments;
create trigger merchant_webhook_emit
after insert or update of status, lightning_invoice on public.payments
for each row execute function public.merchant_webhook_emit();

-- ---------- endpoint management (signed-in merchant, JWT) ----------
create or replace function public.merchant_create_webhook_endpoint(p_url text, p_events text[])
returns table(id uuid, secret text)
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_secret text := 'whsec_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_id uuid;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not exists (select 1 from profiles p where p.id = v_uid and p.role in ('creator','moderator') and p.account_status = 'active') then
    raise exception 'Only active merchant accounts can manage webhooks';
  end if;
  if (select count(*) from merchant_webhook_endpoints e where e.user_id = v_uid) >= 5 then
    raise exception 'Webhook endpoint limit reached (5)';
  end if;
  insert into merchant_webhook_endpoints(user_id, url, secret, events)
  values (v_uid, trim(p_url), v_secret, p_events) returning merchant_webhook_endpoints.id into v_id;
  insert into audit_log(actor_id, actor_email, action, subject_type, subject_id, new_value)
  values (v_uid, (select email from profiles where profiles.id = v_uid), 'merchant_webhook.endpoint_created', 'webhook_endpoint', v_id::text,
          jsonb_build_object('url', trim(p_url), 'events', to_jsonb(p_events)));
  return query select v_id, v_secret;
end; $$;

create or replace function public.merchant_list_webhook_endpoints()
returns table(id uuid, url text, events text[], is_active boolean, consecutive_failures integer, disabled_reason text, created_at timestamptz)
language plpgsql security definer stable set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  return query select e.id, e.url, e.events, e.is_active, e.consecutive_failures, e.disabled_reason, e.created_at
    from merchant_webhook_endpoints e where e.user_id = auth.uid() order by e.created_at desc;
end; $$;

create or replace function public.merchant_set_webhook_endpoint(p_endpoint_id uuid, p_active boolean)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  update merchant_webhook_endpoints
     set is_active = p_active, disabled_reason = case when p_active then null else 'disabled by merchant' end,
         consecutive_failures = case when p_active then 0 else consecutive_failures end
   where id = p_endpoint_id and user_id = auth.uid();
  get diagnostics v_n = row_count;
  if v_n = 1 then
    insert into audit_log(actor_id, actor_email, action, subject_type, subject_id, new_value)
    values (auth.uid(), (select email from profiles where id = auth.uid()), 'merchant_webhook.endpoint_' || case when p_active then 'enabled' else 'disabled' end,
            'webhook_endpoint', p_endpoint_id::text, null);
  end if;
  return v_n = 1;
end; $$;

create or replace function public.merchant_delete_webhook_endpoint(p_endpoint_id uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  delete from merchant_webhook_endpoints where id = p_endpoint_id and user_id = auth.uid();
  get diagnostics v_n = row_count;
  if v_n = 1 then
    insert into audit_log(actor_id, actor_email, action, subject_type, subject_id)
    values (auth.uid(), (select email from profiles where id = auth.uid()), 'merchant_webhook.endpoint_deleted', 'webhook_endpoint', p_endpoint_id::text);
  end if;
  return v_n = 1;
end; $$;

-- A new secret is returned once; the old one stops signing immediately.
create or replace function public.merchant_rotate_webhook_secret(p_endpoint_id uuid)
returns text
language plpgsql security definer set search_path = public as $$
declare v_secret text := 'whsec_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
        v_n int;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  update merchant_webhook_endpoints set secret = v_secret where id = p_endpoint_id and user_id = auth.uid();
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'Endpoint not found'; end if;
  insert into audit_log(actor_id, actor_email, action, subject_type, subject_id)
  values (auth.uid(), (select email from profiles where id = auth.uid()), 'merchant_webhook.secret_rotated', 'webhook_endpoint', p_endpoint_id::text);
  return v_secret;
end; $$;

-- Delivery log for one endpoint, newest first, paginated.
create or replace function public.merchant_list_webhook_deliveries(p_endpoint_id uuid, p_limit integer default 25, p_offset integer default 0, p_status text default null)
returns table(id uuid, event_id uuid, event_type text, payment_id uuid, status text, attempts integer, next_attempt_at timestamptz,
              last_status_code integer, last_error text, delivered_at timestamptz, created_at timestamptz, total_count bigint)
language plpgsql security definer stable set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  return query
  select d.id, d.event_id, ev.type, ev.payment_id, d.status, d.attempts, d.next_attempt_at, d.last_status_code,
         d.last_error, d.delivered_at, d.created_at, count(*) over ()
    from merchant_webhook_deliveries d
    join merchant_webhook_endpoints e on e.id = d.endpoint_id and e.user_id = auth.uid()
    join merchant_webhook_events ev on ev.id = d.event_id
   where d.endpoint_id = p_endpoint_id and (p_status is null or d.status = p_status)
   order by d.created_at desc
   limit least(greatest(coalesce(p_limit, 25), 1), 100) offset greatest(coalesce(p_offset, 0), 0);
end; $$;

revoke all on function public.merchant_create_webhook_endpoint(text, text[]), public.merchant_list_webhook_endpoints(),
  public.merchant_set_webhook_endpoint(uuid, boolean), public.merchant_delete_webhook_endpoint(uuid),
  public.merchant_rotate_webhook_secret(uuid), public.merchant_list_webhook_deliveries(uuid, integer, integer, text)
  from public, anon, service_role;
grant execute on function public.merchant_create_webhook_endpoint(text, text[]), public.merchant_list_webhook_endpoints(),
  public.merchant_set_webhook_endpoint(uuid, boolean), public.merchant_delete_webhook_endpoint(uuid),
  public.merchant_rotate_webhook_secret(uuid), public.merchant_list_webhook_deliveries(uuid, integer, integer, text)
  to authenticated;

-- ---------- delivery worker (payment service, service_role) ----------
-- Claims due deliveries with a lease so two workers never send the same one.
create or replace function public.webhook_claim_due(p_limit integer, p_lease_seconds integer default 60)
returns table(delivery_id uuid, event_id uuid, event_type text, payload jsonb, event_created_at timestamptz,
              endpoint_id uuid, url text, secret text, attempts integer)
language plpgsql security definer set search_path = public as $$
begin
  return query
  with due as (
    select d.id from merchant_webhook_deliveries d
     where d.status = 'pending' and d.next_attempt_at <= now()
     order by d.next_attempt_at limit least(greatest(p_limit, 1), 100)
     for update skip locked
  ), claimed as (
    update merchant_webhook_deliveries d set next_attempt_at = now() + make_interval(secs => p_lease_seconds)
      from due where d.id = due.id returning d.*
  )
  select c.id, ev.id, ev.type, ev.payload, ev.created_at, e.id, e.url, e.secret, c.attempts
    from claimed c join merchant_webhook_events ev on ev.id = c.event_id
    join merchant_webhook_endpoints e on e.id = c.endpoint_id and e.is_active;
end; $$;

create or replace function public.webhook_record_attempt(
  p_delivery_id uuid, p_status_code integer, p_error text, p_duration_ms integer,
  p_success boolean, p_final boolean, p_retry_in_seconds integer, p_disable_after integer default 30)
returns text
language plpgsql security definer set search_path = public as $$
declare v_endpoint uuid; v_fails integer; v_status text;
begin
  select endpoint_id into v_endpoint from merchant_webhook_deliveries where id = p_delivery_id for update;
  if v_endpoint is null then return null; end if;
  insert into merchant_webhook_attempts(delivery_id, status_code, error, duration_ms)
  values (p_delivery_id, p_status_code, left(p_error, 300), p_duration_ms);
  v_status := case when p_success then 'succeeded' when p_final then 'failed' else 'pending' end;
  update merchant_webhook_deliveries set
    status = v_status, attempts = attempts + 1, last_status_code = p_status_code, last_error = left(p_error, 300),
    delivered_at = case when p_success then now() else delivered_at end,
    next_attempt_at = case when v_status = 'pending' then now() + make_interval(secs => p_retry_in_seconds) else next_attempt_at end
   where id = p_delivery_id;
  update merchant_webhook_endpoints set
    consecutive_failures = case when p_success then 0 else consecutive_failures + 1 end
   where id = v_endpoint returning consecutive_failures into v_fails;
  if not p_success and v_fails >= p_disable_after then
    update merchant_webhook_endpoints set is_active = false, disabled_reason = 'too many consecutive failures' where id = v_endpoint;
    update merchant_webhook_deliveries set status = 'failed', last_error = 'endpoint disabled'
     where endpoint_id = v_endpoint and status = 'pending';
  end if;
  return v_status;
end; $$;

-- Pending deliveries whose endpoint was disabled or deleted-and-recreated are closed out.
create or replace function public.webhook_close_orphans()
returns integer
language sql security definer set search_path = public as $$
  with u as (
    update merchant_webhook_deliveries d set status = 'failed', last_error = 'endpoint disabled'
     from merchant_webhook_endpoints e
     where e.id = d.endpoint_id and d.status = 'pending' and not e.is_active returning 1)
  select count(*)::int from u;
$$;

revoke all on function public.webhook_claim_due(integer, integer), public.webhook_record_attempt(uuid, integer, text, integer, boolean, boolean, integer, integer),
  public.webhook_close_orphans() from public, anon, authenticated;
grant execute on function public.webhook_claim_due(integer, integer), public.webhook_record_attempt(uuid, integer, text, integer, boolean, boolean, integer, integer),
  public.webhook_close_orphans() to service_role;
