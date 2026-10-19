-- Forward and payout-address safety (review of 20261020030000..050000).
--
-- 1. USDT batches: the quote expiry is recorded before the send. A batch whose
--    outcome is unknown (no payment in the wallet yet) is retried under a new
--    batch id only after that quote expired plus a grace period, the same rule
--    as stablecoin withdrawals. Before, it was retried after 2 minutes, so a
--    slow or lost send could be paid twice.
-- 2. Payout addresses (USDT and Lightning) are usable at once only when the
--    account has an authenticator. Without one, a new or changed address waits
--    24 hours: a stolen password alone always passes the "fresh sign-in" check.
-- 3. The security notice about a payout change cannot be hidden by the
--    account itself.
-- 4. Admin: hold queued/retry forwards (e.g. after switching payment_mode
--    off), and close a batch stuck in 'sending' for over an hour (delivered,
--    with the provider/transaction reference, or held for review).
-- 5. 'refuse' mode also accepts a USDT receive address; batches only for
--    active accounts.
-- Re-appliable.

-- 1. USDT batch quote expiry --------------------------------------------------
alter table public.forward_batches add column if not exists quote_expires_at timestamptz;

create or replace function public.system_usdt_batch_quoted(p_id uuid, p_expires_at timestamptz)
returns void language sql security definer set search_path = public
as $$ update forward_batches set quote_expires_at = p_expires_at, updated_at = now()
       where id = p_id and status = 'sending' $$;
revoke all on function public.system_usdt_batch_quoted(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.system_usdt_batch_quoted(uuid, timestamptz) to service_role;

-- Batches only for an active account (it could be suspended after its
-- payments settled).
do $do$
declare src text := pg_get_functiondef('public.system_usdt_batch_create(uuid,text,text)'::regprocedure);
begin
  if src like '%account_status = ''active''%' then return; end if;
  if src not like '%x.usable_after <= now();%' then raise exception 'system_usdt_batch_create: patch point not found'; end if;
  execute replace(src, 'x.usable_after <= now();',
    'x.usable_after <= now()
     and exists (select 1 from profiles p where p.id = p_user and p.account_status = ''active'');');
end $do$;

-- 2. When a new payout address may be used --------------------------------------
create or replace function public.payout_ready_at(p_user uuid)
returns timestamptz language sql stable security definer set search_path = public, auth
as $$
  select case when exists (select 1 from auth.mfa_factors f where f.user_id = p_user and f.status = 'verified')
              then now() else now() + interval '24 hours' end
$$;
revoke all on function public.payout_ready_at(uuid) from public, anon, authenticated;

create or replace function public.notify_payout_address_changed(p_user uuid, p_what text, p_ready_at timestamptz default null)
returns void language plpgsql security definer set search_path = public
as $$
begin
  insert into support_messages (user_id, sender, message, read_by_admin, security_notice)
  values (p_user, 'admin',
    'Security notice: ' || left(p_what, 300) || ' at ' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC. ' ||
    case when p_ready_at is not null and p_ready_at > now() + interval '1 minute'
         then 'Payments are sent there from ' || to_char(p_ready_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') ||
              ' UTC (24 hours, because this account has no authenticator). '
         else 'Payments are sent there from now on. ' end ||
    'If you did not make this change, change your password and write to us here right away.',
    true, true);
end;
$$;
revoke all on function public.notify_payout_address_changed(uuid, text, timestamptz) from public, anon, authenticated;

-- 3. Security notices stay visible -------------------------------------------
alter table public.support_messages add column if not exists security_notice boolean not null default false;

create or replace function public.support_messages_keep_security_notice()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if old.security_notice then
    new.security_notice := true;
    if new.deleted_by_creator and not coalesce(old.deleted_by_creator, false) and not is_admin() then
      new.deleted_by_creator := false;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.support_messages_keep_security_notice() from public, anon, authenticated;
drop trigger if exists trg_support_messages_keep_security_notice on public.support_messages;
create trigger trg_support_messages_keep_security_notice
  before update on public.support_messages
  for each row execute function public.support_messages_keep_security_notice();

-- USDT: the address waits 24 h without an authenticator. Only accounts write
-- these rows (no Edge Function or service code does), so the wait applies to
-- signed-in sessions, the admin's included; a write by the database owner or
-- the service role (migrations, operations) is used at once.
create or replace function public.usdt_wallets_cooldown()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.address is not distinct from old.address and new.network is not distinct from old.network
     and new.user_id is not distinct from old.user_id then
    new.usable_after := old.usable_after;
    return new;
  end if;
  if not payout_step_up_ok() then
    raise exception 'reauth_required: For your security, enter your password again to change where payments are sent.';
  end if;
  new.usable_after := case when coalesce(auth.jwt() ->> 'role', '') = 'authenticated'
                           then payout_ready_at(new.user_id) else now() end;
  new.updated_at := now();
  perform public.record_audit(
    'payout_wallet.saved', 'profile', new.user_id::text,
    case when tg_op = 'UPDATE' then jsonb_build_object('network', old.network, 'address', old.address) end,
    jsonb_build_object('network', new.network, 'address', new.address, 'usable_after', new.usable_after),
    case when new.usable_after > now() then 'Payout address saved after a fresh sign-in; usable in 24 hours (no authenticator)'
         else 'Payout address saved after a fresh sign-in; usable at once (authenticator on)' end);
  perform notify_payout_address_changed(new.user_id,
    'your USDT payout address for ' || new.network || ' was set to ' || new.address, new.usable_after);
  return new;
end;
$$;

-- Lightning: the same rule; the address in use stays until the new one is ready.
do $do$
declare src text := pg_get_functiondef('public.system_set_settlement_destination(uuid,text,text,bigint,bigint)'::regprocedure);
begin
  if src like '%payout_ready_at(p_user_id)%' then return; end if;
  if src not like '%p_max_msat, now(), now())%'
     or src not like '%and d.id <> v_new.id;%'
     or src not like '%notify_payout_address_changed(p_user_id, ''your Lightning payout address was set to '' || v_new.address);%' then
    raise exception 'system_set_settlement_destination: patch point not found';
  end if;
  src := replace(src, 'p_max_msat, now(), now())', 'p_max_msat, now(), payout_ready_at(p_user_id))');
  src := replace(src, 'and d.id <> v_new.id;', 'and d.id <> v_new.id and v_new.ready_at <= now();');
  src := replace(src, 'notify_payout_address_changed(p_user_id, ''your Lightning payout address was set to '' || v_new.address);',
                      'notify_payout_address_changed(p_user_id, ''your Lightning payout address was set to '' || v_new.address, v_new.ready_at);');
  execute src;
end $do$;

-- The old two-argument notifier is replaced by the one above (same name, a
-- defaulted third argument); remove it so calls are not ambiguous.
drop function if exists public.notify_payout_address_changed(uuid, text);

-- 4. Admin actions -------------------------------------------------------------
create or replace function public.admin_forward_action(p_id uuid, p_action text)
returns text language plpgsql security definer set search_path = public
as $$
declare f payment_forwards; d record; w usdt_wallets; v_to text;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'Enter your authenticator code first (sign in again with two-step sign-in)';
  end if;
  select * into f from payment_forwards where id = p_id for update;
  if not found then raise exception 'Forward not found'; end if;
  if p_action = 'hold' then
    -- Waiting forwards (queued/retry), e.g. after payment_mode was switched off.
    if f.status not in ('queued', 'retry') then raise exception 'Only a waiting forward can be held'; end if;
    update payment_forwards set status = 'owed', reason = 'held_by_admin', next_attempt_at = null where id = p_id;
    v_to := 'owed';
  elsif f.status <> 'owed' then
    raise exception 'Only a held forward can be changed';
  elsif p_action = 'retry' then
    if f.kind = 'usdt' then
      select * into w from usdt_wallets where user_id = f.user_id and network = f.network and usable_after <= now();
      if w.id is null then raise exception 'This user has no USDT address in use for that network'; end if;
      update payment_forwards set status = 'queued', attempts = 0, reason = null, last_error = null,
             address = w.address, next_attempt_at = now() where id = p_id;
    else
      select * into d from forward_destination_for(f.user_id);
      if d.id is null then raise exception 'This user has no Lightning address in use'; end if;
      update payment_forwards set status = 'queued', attempts = 0, reason = null, last_error = null,
             destination_id = d.id, address = d.address, next_attempt_at = now() where id = p_id;
    end if;
    v_to := 'queued';
  elsif p_action = 'release' then
    update payment_forwards set status = 'released', next_attempt_at = null where id = p_id;
    v_to := 'released';
  else
    raise exception 'Choose hold, retry or release';
  end if;
  perform record_audit('forward.' || p_action, 'payment_forward', p_id::text,
    jsonb_build_object('status', f.status), jsonb_build_object('status', v_to));
  return v_to;
end;
$$;
revoke all on function public.admin_forward_action(uuid, text) from public, anon;
grant execute on function public.admin_forward_action(uuid, text) to authenticated;

-- A USDT batch stuck in 'sending' (e.g. the provider's conversion is pending
-- or failed): the admin closes it after checking the provider and the chain.
--   delivered  needs the transaction hash or provider order id
--   hold       its forwards become 'owed' (then retry or release). Release
--              only once the provider shows the order failed or refunded,
--              otherwise the user can be paid twice.
create or replace function public.admin_forward_batch_action(p_id uuid, p_action text, p_ref text default null)
returns text language plpgsql security definer set search_path = public
as $$
declare b forward_batches; r text;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'Enter your authenticator code first (sign in again with two-step sign-in)';
  end if;
  select * into b from forward_batches where id = p_id for update;
  if not found then raise exception 'Batch not found'; end if;
  if b.status <> 'sending' then raise exception 'Only a batch that is still sending can be closed'; end if;
  if b.updated_at > now() - interval '1 hour' then raise exception 'Wait at least an hour: the wallet may still settle it'; end if;
  if p_action = 'delivered' then
    if coalesce(btrim(p_ref), '') = '' then raise exception 'Give the transaction hash or provider order id'; end if;
    r := system_usdt_batch_finish(p_id, 'forwarded', left(btrim(p_ref), 200), null, null, null);
  elsif p_action = 'hold' then
    r := system_usdt_batch_finish(p_id, 'held', null, null, null, 'stuck_admin_review');
  else
    raise exception 'Choose delivered or hold';
  end if;
  perform record_audit('forward_batch.' || p_action, 'forward_batch', p_id::text,
    jsonb_build_object('status', b.status), jsonb_build_object('status', r, 'ref', p_ref));
  return r;
end;
$$;
revoke all on function public.admin_forward_batch_action(uuid, text, text) from public, anon;
grant execute on function public.admin_forward_batch_action(uuid, text, text) to authenticated;

-- The admin list shows batches stuck in 'sending' for over an hour.
do $do$
declare src text := pg_get_functiondef('public.admin_list_forwards(text,integer)'::regprocedure);
begin
  if src like '%stuck_batches%' then return; end if;
  if src not like '%''totals'', instant_forward_invariants(),%' then raise exception 'admin_list_forwards: patch point not found'; end if;
  execute replace(src, '''totals'', instant_forward_invariants(),',
    '''totals'', instant_forward_invariants(),
    ''stuck_batches'', coalesce((select jsonb_agg(jsonb_build_object(''id'', b.id, ''user_email'', p.email, ''network'', b.network,
        ''address'', b.address, ''amount_usd'', b.amount_usd, ''amount_sat'', b.amount_sat, ''created_at'', b.created_at,
        ''updated_at'', b.updated_at, ''last_error'', b.last_error) order by b.created_at)
      from forward_batches b left join profiles p on p.id = b.user_id
     where b.status = ''sending'' and b.updated_at < now() - interval ''1 hour''), ''[]''::jsonb),');
end $do$;

-- 5. 'refuse' also counts a USDT receive address -----------------------------
create or replace function public.gate_custodial_payment()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if platform_setting('custodial_receive_enabled') = 'false'::jsonb then
    raise exception 'CPAY balance payments are turned off. This link is not taking payments right now.';
  end if;
  if payment_mode() = 'instant_forward'
     and platform_setting('instant_forward_no_address') = '"refuse"'::jsonb
     and not exists (select 1 from forward_destination_for(new.user_id))
     and not exists (select 1 from receive_settings s join usdt_wallets w
                       on w.user_id = s.user_id and w.network = s.usdt_network and w.usable_after <= now()
                      where s.user_id = new.user_id and s.method = 'usdt') then
    raise exception 'This link is not taking payments right now.';
  end if;
  return new;
end;
$$;
