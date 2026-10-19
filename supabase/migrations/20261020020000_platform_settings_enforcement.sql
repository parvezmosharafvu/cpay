-- CPAY — 20261020020000: wire the platform settings into the money paths (non-custodial plan P0/P1)
--
-- Every setting defaults to today's behaviour (20261020010000), so nothing
-- changes on deploy. Enforced in the database, whatever the caller:
--
--   * direct_pilot_user_ids: direct payments for the listed accounts while
--     direct_settlement_enabled is off for everyone (pilot). The four
--     direct-payment functions ask direct_settlement_enabled_for(user).
--   * custodial_receive_enabled = false: no new custodial payment row
--     (payments insert trigger). Invoices already shown still settle.
--   * custodial_new_links_enabled = false: a new link is created direct when
--     its owner has a Lightning address in use, otherwise refused.
--   * custodial_withdraw_enabled = false: no new withdrawal row (every path
--     inserts into withdrawals).
--   * admin_send_daily_cap_usd / admin_send_allowed_destinations: checked by
--     system_admin_send_check(), which the wallet function calls before every
--     admin send (prepare and confirm). Today's total is the sum of the
--     'platform_wallet.send' audit rows of the last 24 hours.
--
-- Rollback: drop the three triggers and their functions, drop
-- direct_settlement_enabled_for(uuid), direct_settlement_available(),
-- system_admin_send_check(text, bigint); re-create the four direct-payment
-- functions and guard_link_settlement_mode() from 20261018010000.

create or replace function public.direct_settlement_enabled_for(p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select direct_settlement_enabled()
      or (p_user_id is not null and platform_setting('direct_pilot_user_ids') ? p_user_id::text)
$$;
revoke all on function public.direct_settlement_enabled_for(uuid) from public, anon, authenticated;
grant execute on function public.direct_settlement_enabled_for(uuid) to service_role;

-- For the public direct-invoice function's first check: on for everyone, or
-- a pilot exists (the link owner is then checked by system_direct_destination_for).
create or replace function public.direct_settlement_available()
returns boolean
language sql stable security definer set search_path = public
as $$ select direct_settlement_enabled() or jsonb_array_length(platform_setting('direct_pilot_user_ids')) > 0 $$;
revoke all on function public.direct_settlement_available() from public, anon, authenticated;
grant execute on function public.direct_settlement_available() to service_role;

CREATE OR REPLACE FUNCTION public.get_my_direct_settlement()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    'enabled', direct_settlement_enabled_for(v_uid),
    'blocked', coalesce((select direct_settlement_blocked from profiles where id = v_uid), false),
    'current', v_current,
    'pending', v_pending
  );
end;
$function$;
CREATE OR REPLACE FUNCTION public.set_link_settlement_mode(p_link_id uuid, p_mode text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    if not direct_settlement_enabled_for(v_uid) then raise exception 'Direct payments are not available yet'; end if;
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
$function$;
CREATE OR REPLACE FUNCTION public.system_direct_destination_for(p_user_id uuid)
 RETURNS TABLE(id uuid, address text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select d.id, d.address
    from settlement_destinations d
    join profiles p on p.id = d.user_id
   where d.user_id = p_user_id
     and d.status = 'active'
     and d.ready_at <= now()
     and p.account_status = 'active'
     and not p.direct_settlement_blocked
     and direct_settlement_enabled_for(p_user_id)
   order by d.created_at desc
   limit 1
$function$;
CREATE OR REPLACE FUNCTION public.system_set_settlement_destination(p_user_id uuid, p_address text, p_callback_host text, p_min_msat bigint, p_max_msat bigint)
 RETURNS TABLE(id uuid, address text, ready_at timestamp with time zone, unchanged boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_existing settlement_destinations;
  v_ready settlement_destinations;
  v_new settlement_destinations;
  v_cancelled integer;
begin
  if p_user_id is null then raise exception 'No account'; end if;
  if not direct_settlement_enabled_for(p_user_id) then raise exception 'Direct payments are not available yet'; end if;
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
$function$;

-- A new link may start direct only through the custodial-links gate below.
create or replace function public.guard_link_settlement_mode()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if coalesce(current_setting('cpay.settlement_mode_rpc', true), '') = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' and new.settlement_mode is distinct from 'custodial' then
    if new.settlement_mode = 'direct'
       and platform_setting('custodial_new_links_enabled') = 'false'::jsonb
       and exists (select 1 from system_direct_destination_for(new.user_id)) then
      return new;
    end if;
    raise exception 'A new link starts with CPAY balance payments; its owner can then choose direct payments';
  end if;
  if tg_op = 'UPDATE' and new.settlement_mode is distinct from old.settlement_mode then
    raise exception 'Only the link''s owner can change where its payments go (set_link_settlement_mode)';
  end if;
  return new;
end;
$$;

create or replace function public.gate_new_custodial_link()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.settlement_mode = 'custodial' and platform_setting('custodial_new_links_enabled') = 'false'::jsonb then
    if exists (select 1 from system_direct_destination_for(new.user_id)) then
      new.settlement_mode := 'direct';
    else
      raise exception 'New links are paid straight to your own wallet. Add your Lightning address first (it is used 24 hours after you save it).';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_0_gate_new_custodial_link on public.payment_links;
create trigger trg_0_gate_new_custodial_link
  before insert on public.payment_links
  for each row execute function public.gate_new_custodial_link();

create or replace function public.gate_custodial_payment()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if platform_setting('custodial_receive_enabled') = 'false'::jsonb then
    raise exception 'CPAY balance payments are turned off. This link is not taking payments right now.';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_gate_custodial_payment on public.payments;
create trigger trg_gate_custodial_payment
  before insert on public.payments
  for each row execute function public.gate_custodial_payment();

create or replace function public.gate_custodial_withdrawal()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if platform_setting('custodial_withdraw_enabled') = 'false'::jsonb then
    raise exception 'Withdrawals from CPAY balances are turned off. Contact support.';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_gate_custodial_withdrawal on public.withdrawals;
create trigger trg_gate_custodial_withdrawal
  before insert on public.withdrawals
  for each row execute function public.gate_custodial_withdrawal();

-- Admin wallet limits. Raises with a message for the admin; returns the
-- last-24-hour total in cents otherwise.
create or replace function public.system_admin_send_check(p_destination text, p_usd_cents bigint)
returns bigint
language plpgsql stable security definer set search_path = public
as $$
declare
  v_allow jsonb := platform_setting('admin_send_allowed_destinations');
  v_cap jsonb := platform_setting('admin_send_daily_cap_usd');
  v_dest text := lower(trim(coalesce(p_destination, '')));
  v_sent bigint;
begin
  if p_usd_cents is null or p_usd_cents < 0 then raise exception 'Admin send: unknown amount'; end if;
  if jsonb_array_length(v_allow) > 0
     and not exists (select 1 from jsonb_array_elements_text(v_allow) a where lower(a) = v_dest) then
    raise exception 'This destination is not on the admin-wallet allow-list (Admin → Settings)';
  end if;
  select coalesce(sum((new_value->>'usdCents')::bigint), 0) into v_sent
    from audit_log
   where action = 'platform_wallet.send' and occurred_at > now() - interval '24 hours'
     and new_value ? 'usdCents';
  if jsonb_typeof(v_cap) = 'number' and v_sent + p_usd_cents > round((v_cap#>>'{}')::numeric * 100) then
    raise exception 'This send would pass the admin-wallet daily cap of $% (sent in the last 24 hours: $%)',
      to_char((v_cap#>>'{}')::numeric, 'FM999990.00'), to_char(v_sent / 100.0, 'FM999990.00');
  end if;
  return v_sent;
end;
$$;
revoke all on function public.system_admin_send_check(text, bigint) from public, anon, authenticated;
grant execute on function public.system_admin_send_check(text, bigint) to service_role;
