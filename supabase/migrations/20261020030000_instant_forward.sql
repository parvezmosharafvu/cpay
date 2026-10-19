-- Instant forward (docs/INSTANT-FORWARD.md): in payment mode
-- 'instant_forward' each settled payment gets one payment_forwards row
-- (unique payment_id): the platform fee stays, the rest is forwarded by the
-- wallet function to the user's saved Lightning address. Forward rows that
-- are not 'released' are left out of the CPAY balance.
--
-- New settings (all default to today's behaviour; payment_mode = 'balance'):
--   payment_mode                       balance | instant_forward | direct
--   instant_forward_no_address         balance | refuse
--   instant_forward_min_sat            sats, default 100
--   instant_forward_max_usd            USD or null (no per-forward max)
--   instant_forward_max_fee_pct        max routing fee, % of the forward (1)
--   instant_forward_max_attempts       attempts before 'owed' (6)
-- 'direct' mode turns direct payments on for everyone (no fee).

-- 1. Settings catalogue and kinds ------------------------------------------
create or replace function public.platform_setting_defaults()
returns table(key text, default_value jsonb, kind text, dangerous boolean, label text)
language sql immutable set search_path = public
as $$ values
  ('payment_mode',                  '"balance"'::jsonb, 'payment_mode', true, 'Payment mode'),
  ('instant_forward_no_address',    '"balance"'::jsonb, 'no_address_policy', true, 'Instant forward: users without a Lightning address'),
  ('instant_forward_min_sat',       '100'::jsonb,   'sats',    false, 'Instant forward: smallest forward (sats); smaller ones wait for the admin'),
  ('instant_forward_max_usd',       'null'::jsonb,  'money_or_null', true, 'Instant forward: largest forward without admin approval (USD, empty = no limit)'),
  ('instant_forward_max_fee_pct',   '1'::jsonb,     'percent', false, 'Instant forward: highest network fee, % of the forward'),
  ('instant_forward_max_attempts',  '6'::jsonb,     'attempts', false, 'Instant forward: tries before it waits for the admin'),
  ('custodial_receive_enabled',     'true'::jsonb,  'boolean', true,  'Custodial receive: payments into the CPAY wallet and CPAY balances'),
  ('custodial_new_links_enabled',   'true'::jsonb,  'boolean', true,  'New links may use the CPAY balance (custodial)'),
  ('custodial_withdraw_enabled',    'true'::jsonb,  'boolean', true,  'Withdrawals from CPAY balances'),
  ('fee_billing_enabled',           'false'::jsonb, 'boolean', true,  'Bill CPAY fees to merchants (subscription)'),
  ('fee_pilot_no_fee',              'true'::jsonb,  'boolean', false, 'Pilot: no CPAY fee on direct payments'),
  ('fee_subscription_price_usd',    '0'::jsonb,     'money',   false, 'Subscription price per month (USD)'),
  ('fee_free_tier_usd',             '0'::jsonb,     'money',   false, 'Free tier: direct volume per month before the subscription applies (USD)'),
  ('fee_grace_days',                '7'::jsonb,     'days',    false, 'Grace days before unpaid billing pauses links'),
  ('direct_provider_hosts',         '[]'::jsonb,    'hosts',   true,  'Allowed receiving-wallet provider hosts (empty = any public provider)'),
  ('direct_pilot_user_ids',         '[]'::jsonb,    'uuids',   true,  'Direct-payment pilot accounts (allowed while direct payments are off for everyone)'),
  ('admin_send_daily_cap_usd',      'null'::jsonb,  'money_or_null', true, 'Admin wallet: daily send cap (USD, empty = no cap)'),
  ('admin_send_allowed_destinations','[]'::jsonb,   'strings', true,  'Admin wallet: allowed destinations (empty = any)'),
  ('legal_entity_name',             '""'::jsonb,    'text',    false, 'Legal entity name'),
  ('legal_address',                 '""'::jsonb,    'text',    false, 'Registered address'),
  ('legal_effective_date',          '""'::jsonb,    'date_or_empty', false, 'Legal pages effective date'),
  ('legal_jurisdiction',            '""'::jsonb,    'text',    false, 'Governing law jurisdiction'),
  ('legal_courts',                  '""'::jsonb,    'text',    false, 'Courts with jurisdiction'),
  ('legal_privacy_email',           '""'::jsonb,    'email_or_empty', false, 'Privacy contact email'),
  ('legal_support_email',           '""'::jsonb,    'email_or_empty', false, 'Support email'),
  ('legal_published',               'false'::jsonb, 'boolean', true,  'Publish legal pages (indexed and linked; needs every legal field)'),
  ('wallet_link_enabled',           'false'::jsonb, 'boolean', true,  'Show the CPAY Wallet download link on the website'),
  ('wallet_url',                    '""'::jsonb,    'https_or_empty', false, 'CPAY Wallet address (https)')
$$;

do $do$
declare src text := pg_get_functiondef('public.platform_setting_valid(text,jsonb)'::regprocedure);
begin
  src := replace(src, $r$  else return false;
  end case;$r$, $r$  when 'payment_mode' then return v in ('"balance"'::jsonb, '"instant_forward"'::jsonb, '"direct"'::jsonb);
  when 'no_address_policy' then return v in ('"balance"'::jsonb, '"refuse"'::jsonb);
  when 'sats' then return jsonb_typeof(v) = 'number' and (v#>>'{}')::numeric between 1 and 100000000
                          and (v#>>'{}')::numeric = trunc((v#>>'{}')::numeric);
  when 'percent' then return jsonb_typeof(v) = 'number' and (v#>>'{}')::numeric between 0 and 10;
  when 'attempts' then return jsonb_typeof(v) = 'number' and (v#>>'{}')::numeric between 1 and 50
                          and (v#>>'{}')::numeric = trunc((v#>>'{}')::numeric);
  else return false;
  end case;$r$);
  if src not like '%payment_mode%' then raise exception 'platform_setting_valid: patch point not found'; end if;
  execute src;
end $do$;

create or replace function public.payment_mode()
returns text language sql stable security definer set search_path = public
as $$ select coalesce(platform_setting('payment_mode') #>> '{}', 'balance') $$;
revoke all on function public.payment_mode() from public, anon, authenticated;
grant execute on function public.payment_mode() to service_role;

-- 2. Direct mode = direct payments for everyone ------------------------------
create or replace function public.direct_settlement_enabled_for(p_user_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select direct_settlement_enabled() or payment_mode() = 'direct'
      or (p_user_id is not null and platform_setting('direct_pilot_user_ids') ? p_user_id::text)
$$;
create or replace function public.direct_settlement_available()
returns boolean language sql stable security definer set search_path = public
as $$ select direct_settlement_enabled() or payment_mode() = 'direct'
          or jsonb_array_length(platform_setting('direct_pilot_user_ids')) > 0 $$;

-- 3. Saving a Lightning address is allowed for direct and instant forward ---
create or replace function public.settlement_address_allowed_for(p_user_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select direct_settlement_enabled_for(p_user_id) or payment_mode() = 'instant_forward' $$;
revoke all on function public.settlement_address_allowed_for(uuid) from public, anon, authenticated;
grant execute on function public.settlement_address_allowed_for(uuid) to service_role;

do $do$
declare src text;
begin
  src := pg_get_functiondef('public.system_set_settlement_destination(uuid,text,text,bigint,bigint)'::regprocedure);
  if src not like '%if not direct_settlement_enabled_for(p_user_id) then raise exception ''Direct payments are not available yet''; end if;%' then
    raise exception 'system_set_settlement_destination: patch point not found';
  end if;
  execute replace(src, 'if not direct_settlement_enabled_for(p_user_id) then raise exception ''Direct payments are not available yet''; end if;',
    'if not settlement_address_allowed_for(p_user_id) then raise exception ''Direct payments are not available yet''; end if;');

  src := pg_get_functiondef('public.get_my_direct_settlement()'::regprocedure);
  if src not like '%''enabled'', direct_settlement_enabled_for(v_uid),%' then
    raise exception 'get_my_direct_settlement: patch point not found';
  end if;
  -- 'enabled' keeps meaning "direct links allowed"; 'address_enabled' says
  -- the address form is usable; 'instant_forward' tells the desk the mode.
  execute replace(src, '''enabled'', direct_settlement_enabled_for(v_uid),',
    '''enabled'', direct_settlement_enabled_for(v_uid), ''address_enabled'', settlement_address_allowed_for(v_uid), ''instant_forward'', payment_mode() = ''instant_forward'',');
end $do$;

-- 4. Forwards table and state machine ---------------------------------------
create table public.payment_forwards (
  id               uuid primary key default gen_random_uuid(),
  payment_id       uuid not null unique references public.payments(id),
  user_id          uuid not null references public.profiles(id),
  destination_id   uuid references public.settlement_destinations(id),
  address          text,
  gross_sat        bigint not null check (gross_sat >= 0),
  fee_sat          bigint not null check (fee_sat >= 0),
  forward_sat      bigint not null check (forward_sat >= 0),
  sent_sat         bigint check (sent_sat >= 0),
  routing_fee_sat  bigint check (routing_fee_sat >= 0),
  remainder_sat    bigint check (remainder_sat >= 0),
  fee_usd          numeric(12,2) not null default 0,
  amount_usd       numeric(18,8) not null default 0,
  status           text not null check (status in ('queued','sending','retry','owed','forwarded','released')),
  reason           text,
  attempts         integer not null default 0 check (attempts >= 0),
  next_attempt_at  timestamptz,
  payment_ref      text,
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  forwarded_at     timestamptz,
  constraint payment_forwards_split check (gross_sat = fee_sat + forward_sat),
  constraint payment_forwards_sent check (status <> 'forwarded' or
    (sent_sat is not null and routing_fee_sat is not null and remainder_sat is not null
     and forward_sat = sent_sat + routing_fee_sat + remainder_sat and payment_ref is not null))
);
comment on table public.payment_forwards is
  'Instant forward (docs/INSTANT-FORWARD.md): one row per settled payment; written only by triggers and SECURITY DEFINER functions.';
create index payment_forwards_due_idx on public.payment_forwards (status, next_attempt_at, created_at)
  where status in ('queued','sending','retry');
create index payment_forwards_user_idx on public.payment_forwards (user_id, created_at desc);
alter table public.payment_forwards enable row level security;
revoke all on public.payment_forwards from public, anon, authenticated;
grant select on public.payment_forwards to authenticated;
create policy payment_forwards_owner_read on public.payment_forwards
  for select to authenticated using (user_id = auth.uid() or is_admin());

create or replace function public.payment_forwards_guard()
returns trigger language plpgsql set search_path = public
as $$
begin
  if (new.payment_id, new.user_id, new.gross_sat, new.fee_sat, new.forward_sat, new.created_at)
     is distinct from (old.payment_id, old.user_id, old.gross_sat, old.fee_sat, old.forward_sat, old.created_at) then
    raise exception 'payment_forwards: amounts and payment are fixed';
  end if;
  if new.status <> old.status and not (
       (old.status = 'queued'  and new.status in ('sending','owed'))
    or (old.status = 'sending' and new.status in ('forwarded','retry','owed'))
    or (old.status = 'retry'   and new.status in ('sending','owed'))
    or (old.status = 'owed'    and new.status in ('queued','released'))
  ) then
    raise exception 'payment_forwards: % -> % is not allowed', old.status, new.status;
  end if;
  if old.status in ('forwarded','released') then
    raise exception 'payment_forwards: % is final', old.status;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger trg_payment_forwards_guard before update on public.payment_forwards
  for each row execute function public.payment_forwards_guard();
create or replace function public.payment_forwards_no_delete()
returns trigger language plpgsql as $$ begin raise exception 'payment_forwards rows are never deleted'; end $$;
create trigger trg_payment_forwards_no_delete before delete on public.payment_forwards
  for each row execute function public.payment_forwards_no_delete();

-- The address a forward goes to: the newest active, ready address of an
-- active, not blocked account.
create or replace function public.forward_destination_for(p_user_id uuid)
returns table(id uuid, address text) language sql stable security definer set search_path = public
as $$
  select d.id, d.address
    from settlement_destinations d join profiles p on p.id = d.user_id
   where d.user_id = p_user_id and d.status = 'active' and d.ready_at <= now()
     and p.account_status = 'active' and not p.direct_settlement_blocked
   order by d.created_at desc limit 1
$$;
revoke all on function public.forward_destination_for(uuid) from public, anon, authenticated;
grant execute on function public.forward_destination_for(uuid) to service_role;

-- 5. Enqueue at settlement (runs after the fee is stamped) -------------------
create or replace function public.instant_forward_enqueue()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  d record; v_fee bigint; v_fwd bigint; v_status text := 'queued'; v_reason text;
  v_max jsonb := platform_setting('instant_forward_max_usd');
begin
  if payment_mode() <> 'instant_forward' then return new; end if;
  select * into d from forward_destination_for(new.user_id);
  if d.id is null and coalesce(platform_setting('instant_forward_no_address') #>> '{}', 'balance') = 'balance' then
    return new;  -- stays in the CPAY balance, as before
  end if;
  if coalesce(new.amount_sat, 0) <= 0 or coalesce(new.amount_settled, 0) <= 0 then
    v_fee := 0; v_fwd := greatest(coalesce(new.amount_sat, 0), 0); v_status := 'owed'; v_reason := 'no_amount';
  else
    v_fee := least(new.amount_sat, greatest(0, round(new.amount_sat * coalesce(new.platform_fee_amount, 0) / new.amount_settled)::bigint));
    v_fwd := new.amount_sat - v_fee;
  end if;
  if v_reason is null and d.id is null then v_status := 'owed'; v_reason := 'no_address';
  elsif v_reason is null and v_fwd < coalesce((platform_setting('instant_forward_min_sat') #>> '{}')::bigint, 100) then
    v_status := 'owed'; v_reason := 'below_minimum';
  elsif v_reason is null and jsonb_typeof(v_max) = 'number'
        and new.amount_settled - coalesce(new.platform_fee_amount, 0) > (v_max #>> '{}')::numeric then
    v_status := 'owed'; v_reason := 'over_limit';
  end if;
  insert into payment_forwards (payment_id, user_id, destination_id, address, gross_sat, fee_sat, forward_sat,
                                fee_usd, amount_usd, status, reason, next_attempt_at)
  values (new.id, new.user_id, d.id, d.address, greatest(coalesce(new.amount_sat, 0), 0), v_fee, v_fwd,
          coalesce(new.platform_fee_amount, 0), coalesce(new.amount_settled, 0) - coalesce(new.platform_fee_amount, 0),
          v_status, v_reason, case when v_status = 'queued' then now() end)
  on conflict (payment_id) do nothing;
  return new;
end;
$$;
revoke all on function public.instant_forward_enqueue() from public, anon, authenticated;
create trigger trg_instant_forward_enqueue after update of status on public.payments
  for each row when (new.status = 'settled' and old.status is distinct from 'settled')
  execute function public.instant_forward_enqueue();

-- 'refuse': no new payment for an account without a ready address.
create or replace function public.gate_custodial_payment()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if platform_setting('custodial_receive_enabled') = 'false'::jsonb then
    raise exception 'CPAY balance payments are turned off. This link is not taking payments right now.';
  end if;
  if payment_mode() = 'instant_forward'
     and platform_setting('instant_forward_no_address') = '"refuse"'::jsonb
     and not exists (select 1 from forward_destination_for(new.user_id)) then
    raise exception 'This link is not taking payments right now.';
  end if;
  return new;
end;
$$;

-- 6. Balance leaves out forwarded / in-flight / owed payments ----------------
create or replace function public.get_balance_for(p_user_id uuid)
returns table(earned numeric, queued numeric, withdrawn numeric, available numeric)
language sql stable security definer set search_path = public
as $$
  select e.earned, q.queued, w.withdrawn, round(e.earned - q.queued, 8) as available
  from
    (select coalesce((
        select sum(amount_settled - coalesce(platform_fee_amount, 0))
        from payments
        where user_id = p_user_id
          and status = 'settled'
          and amount_settled >= hide_threshold_for(p_user_id)
          and not exists (select 1 from payment_forwards f
                           where f.payment_id = payments.id and f.status <> 'released')
      ), 0) as earned) e,
    (select coalesce(sum(amount_requested), 0) as queued
     from withdrawals where user_id = p_user_id and status not in ('rejected', 'failed')) q,
    (select coalesce(sum(amount_after_fee), 0) as withdrawn
     from withdrawals where user_id = p_user_id and status = 'paid') w;
$$;

-- What the wallet still owes on forwards (not yet sent, not released), USD.
create or replace function public.forwards_owed_usd()
returns numeric language sql stable security definer set search_path = public
as $$ select coalesce(sum(amount_usd), 0) from payment_forwards where status in ('queued','sending','retry','owed') $$;
revoke all on function public.forwards_owed_usd() from public, anon, authenticated;
grant execute on function public.forwards_owed_usd() to service_role;

-- 7. Worker functions (service_role; the wallet function, under its lease) ---
create or replace function public.system_forward_claim(p_limit integer default 10)
returns setof public.payment_forwards language plpgsql security definer set search_path = public
as $$
begin
  if payment_mode() <> 'instant_forward' then return; end if;
  return query
  update payment_forwards f set status = 'sending', attempts = f.attempts + 1, last_error = null
   where f.id in (select x.id from payment_forwards x
                   where x.status = 'queued' or (x.status = 'retry' and x.next_attempt_at <= now())
                   order by x.created_at limit greatest(1, least(coalesce(p_limit, 10), 50))
                   for update skip locked)
  returning f.*;
end;
$$;

-- Rows left in 'sending' longer than p_secs (a crash or a lost reply).
create or replace function public.system_forward_stuck(p_secs integer default 120)
returns setof public.payment_forwards language sql stable security definer set search_path = public
as $$ select * from payment_forwards where status = 'sending'
         and updated_at < now() - make_interval(secs => greatest(p_secs, 0)) order by created_at limit 50 $$;

create or replace function public.system_forward_finish(
  p_id uuid, p_outcome text, p_sent_sat bigint default null, p_routing_fee_sat bigint default null,
  p_payment_ref text default null, p_error text default null)
returns text language plpgsql security definer set search_path = public
as $$
declare f payment_forwards; v_max int := coalesce((platform_setting('instant_forward_max_attempts') #>> '{}')::int, 6);
begin
  select * into f from payment_forwards where id = p_id for update;
  if not found then raise exception 'Forward not found'; end if;
  if f.status <> 'sending' then return f.status; end if;   -- already finished: idempotent
  if p_outcome = 'forwarded' then
    if p_sent_sat is null or p_routing_fee_sat is null or p_payment_ref is null
       or p_sent_sat < 0 or p_routing_fee_sat < 0 or p_sent_sat + p_routing_fee_sat > f.forward_sat then
      raise exception 'Forward amounts do not add up';
    end if;
    update payment_forwards set status = 'forwarded', sent_sat = p_sent_sat, routing_fee_sat = p_routing_fee_sat,
           remainder_sat = f.forward_sat - p_sent_sat - p_routing_fee_sat, payment_ref = p_payment_ref,
           forwarded_at = now(), last_error = null, next_attempt_at = null
     where id = p_id;
    return 'forwarded';
  elsif p_outcome = 'retry' then
    if f.attempts >= v_max then
      update payment_forwards set status = 'owed', reason = 'failed', last_error = left(p_error, 500), next_attempt_at = null where id = p_id;
      return 'owed';
    end if;
    update payment_forwards set status = 'retry', last_error = left(p_error, 500),
           next_attempt_at = now() + make_interval(secs => least(3600, 60 * power(2, greatest(f.attempts - 1, 0))::int))
     where id = p_id;
    return 'retry';
  elsif p_outcome = 'owed' then
    update payment_forwards set status = 'owed', reason = coalesce(left(p_error, 100), 'held'), last_error = left(p_error, 500), next_attempt_at = null where id = p_id;
    return 'owed';
  end if;
  raise exception 'Unknown outcome';
end;
$$;
revoke all on function public.system_forward_claim(integer) from public, anon, authenticated;
revoke all on function public.system_forward_stuck(integer) from public, anon, authenticated;
revoke all on function public.system_forward_finish(uuid, text, bigint, bigint, text, text) from public, anon, authenticated;
grant execute on function public.system_forward_claim(integer) to service_role;
grant execute on function public.system_forward_stuck(integer) to service_role;
grant execute on function public.system_forward_finish(uuid, text, bigint, bigint, text, text) to service_role;

-- 8. Invariants: received = fees + forwarded (+ network fee + remainder) + owed/in flight + released
create or replace function public.instant_forward_invariants()
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare r jsonb;
begin
  select jsonb_build_object(
    'received_sat',   coalesce(sum(gross_sat), 0),
    'fee_sat',        coalesce(sum(fee_sat), 0),
    'sent_sat',       coalesce(sum(sent_sat) filter (where status = 'forwarded'), 0),
    'network_fee_sat',coalesce(sum(routing_fee_sat) filter (where status = 'forwarded'), 0),
    'remainder_sat',  coalesce(sum(remainder_sat) filter (where status = 'forwarded'), 0),
    'owed_sat',       coalesce(sum(forward_sat) filter (where status = 'owed'), 0),
    'in_flight_sat',  coalesce(sum(forward_sat) filter (where status in ('queued','sending','retry')), 0),
    'released_sat',   coalesce(sum(forward_sat) filter (where status = 'released'), 0),
    'bad_rows',       count(*) filter (where gross_sat <> fee_sat + forward_sat
                        or (status = 'forwarded' and forward_sat <> sent_sat + routing_fee_sat + remainder_sat)))
    into r from payment_forwards;
  return r || jsonb_build_object('ok', (r->>'bad_rows')::int = 0 and
    (r->>'received_sat')::bigint = (r->>'fee_sat')::bigint + (r->>'sent_sat')::bigint + (r->>'network_fee_sat')::bigint
      + (r->>'remainder_sat')::bigint + (r->>'owed_sat')::bigint + (r->>'in_flight_sat')::bigint + (r->>'released_sat')::bigint);
end;
$$;
revoke all on function public.instant_forward_invariants() from public, anon, authenticated;
grant execute on function public.instant_forward_invariants() to service_role;

-- 9. Admin: list and act --------------------------------------------------
create or replace function public.admin_list_forwards(p_status text default null, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  return jsonb_build_object(
    'mode', payment_mode(),
    'counts', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) n from payment_forwards group by status) c),
    'totals', instant_forward_invariants(),
    'rows', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc) from (
        select f.id, f.payment_id, f.user_id, p.email as user_email, f.address, f.gross_sat, f.fee_sat, f.forward_sat,
               f.sent_sat, f.routing_fee_sat, f.amount_usd, f.status, f.reason, f.attempts, f.next_attempt_at,
               f.last_error, f.created_at, f.forwarded_at
          from payment_forwards f left join profiles p on p.id = f.user_id
         where p_status is null or f.status = p_status
         order by f.created_at desc limit greatest(1, least(coalesce(p_limit, 100), 500))) x), '[]'::jsonb));
end;
$$;

create or replace function public.admin_forward_action(p_id uuid, p_action text)
returns text language plpgsql security definer set search_path = public
as $$
declare f payment_forwards; d record;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'Enter your authenticator code first (sign in again with two-step sign-in)';
  end if;
  select * into f from payment_forwards where id = p_id for update;
  if not found then raise exception 'Forward not found'; end if;
  if f.status <> 'owed' then raise exception 'Only a held forward can be changed'; end if;
  if p_action = 'retry' then
    select * into d from forward_destination_for(f.user_id);
    if d.id is null then raise exception 'This user has no Lightning address in use'; end if;
    update payment_forwards set status = 'queued', attempts = 0, reason = null, last_error = null,
           destination_id = d.id, address = d.address, next_attempt_at = now() where id = p_id;
  elsif p_action = 'release' then
    update payment_forwards set status = 'released', next_attempt_at = null where id = p_id;
  else
    raise exception 'Choose retry or release';
  end if;
  perform record_audit('forward.' || p_action, 'payment_forward', p_id::text,
    jsonb_build_object('status', f.status), jsonb_build_object('status', case when p_action = 'retry' then 'queued' else 'released' end));
  return case when p_action = 'retry' then 'queued' else 'released' end;
end;
$$;
revoke all on function public.admin_list_forwards(text, integer) from public, anon;
revoke all on function public.admin_forward_action(uuid, text) from public, anon;
grant execute on function public.admin_list_forwards(text, integer) to authenticated;
grant execute on function public.admin_forward_action(uuid, text) to authenticated;

-- 10. Alert: held forwards ------------------------------------------------
do $do$
declare src text := pg_get_functiondef('public.admin_system_alerts()'::regprocedure);
begin
  if src not like '%return jsonb_build_object(''checked_at''%' then raise exception 'admin_system_alerts: patch point not found'; end if;
  execute replace(src, ' return jsonb_build_object(''checked_at''',
    ' if exists (select 1 from payment_forwards where status = ''owed'') then a:=a||jsonb_build_array(jsonb_build_object(''code'',''forward_owed'',''severity'',''warning'',''title'',''Instant forwards are waiting'',''detail'',(select count(*) from payment_forwards where status=''owed'')||'' held; see Payouts → Instant forwards.'')); end if;
 if exists (select 1 from payment_forwards where status in (''queued'',''retry'',''sending'') and created_at < now() - interval ''1 hour'') then a:=a||jsonb_build_array(jsonb_build_object(''code'',''forward_stale'',''severity'',''warning'',''title'',''Instant forwards are slow'',''detail'',''Some forwards are over an hour old.'')); end if;
 return jsonb_build_object(''checked_at''');
end $do$;
