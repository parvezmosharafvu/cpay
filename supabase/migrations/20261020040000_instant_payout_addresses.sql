-- Payout addresses work at once (owner decision 2026-10-20). The 24-hour wait
-- on a new or changed payout address (Lightning: settlement_destinations
-- ready_at; USDT: usdt_wallets usable_after) is replaced by:
--   1. a fresh sign-in on every change (the payout step-up: a first factor
--      within 10 minutes, and aal2 when the account has an authenticator).
--      Lightning saves already go through the settlement-destination function,
--      which checks it; USDT saves (RPC or direct table write) are checked here
--      by payout_step_up_ok();
--   2. an audit entry (as before), and
--   3. a message to the user in their CPAY inbox ("Your payout address was
--      changed ..."), so a change they did not make is seen at once.
-- Re-appliable.

-- 1. The payout step-up, in SQL (mirror of supabase/functions/_shared/step-up.ts).
--    Only requests made with a member's own token are checked; the service
--    role (edge functions, which check it themselves) and maintenance are not.
create or replace function public.payout_step_up_ok(p_max_age_seconds integer default 600)
returns boolean language plpgsql stable security definer set search_path = public, auth
as $$
declare c jsonb := auth.jwt(); v_latest numeric := 0; e jsonb; t numeric;
begin
  if coalesce(c ->> 'role', '') <> 'authenticated' then return true; end if;
  if exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified')
     and coalesce(c ->> 'aal', '') <> 'aal2' then
    return false;
  end if;
  if jsonb_typeof(c -> 'amr') = 'array' then
    for e in select * from jsonb_array_elements(c -> 'amr') loop
      if e ->> 'method' in ('password', 'passkey', 'oauth', 'sso/saml') and (e ->> 'timestamp') ~ '^\d{1,12}$' then
        t := (e ->> 'timestamp')::numeric;
        if t > v_latest then v_latest := t; end if;
      end if;
    end loop;
  end if;
  return v_latest > 0 and extract(epoch from now()) - v_latest <= p_max_age_seconds
     and v_latest <= extract(epoch from now()) + 120;
end;
$$;
revoke all on function public.payout_step_up_ok(integer) from public, anon, authenticated;

-- 2. Tell the user, in their CPAY inbox.
create or replace function public.notify_payout_address_changed(p_user uuid, p_what text)
returns void language plpgsql security definer set search_path = public
as $$
begin
  insert into support_messages (user_id, sender, message, read_by_admin)
  values (p_user, 'admin',
    'Security notice: ' || left(p_what, 300) || ' at ' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI') ||
    ' UTC. Payments are sent there from now on. If you did not make this change, change your password and write to us here right away.',
    true);
end;
$$;
revoke all on function public.notify_payout_address_changed(uuid, text) from public, anon, authenticated;

-- 3. USDT payout addresses: usable at once, after a fresh sign-in.
alter table public.usdt_wallets alter column usable_after set default now();

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
  new.usable_after := now();
  new.updated_at := now();
  perform public.record_audit(
    'payout_wallet.saved', 'profile', new.user_id::text,
    case when tg_op = 'UPDATE' then jsonb_build_object('network', old.network, 'address', old.address) end,
    jsonb_build_object('network', new.network, 'address', new.address, 'usable_after', new.usable_after),
    'Payout address saved after a fresh sign-in; usable at once');
  perform notify_payout_address_changed(new.user_id,
    'your USDT payout address for ' || new.network || ' was set to ' || new.address);
  return new;
end;
$$;

-- 4. Lightning payout address: used at once (the function already needs a
--    fresh sign-in), and the user is told.
do $do$
declare src text := pg_get_functiondef('public.system_set_settlement_destination(uuid,text,text,bigint,bigint)'::regprocedure);
begin
  if src like '%notify_payout_address_changed%' then return; end if;
  if src not like '%now() + interval ''24 hours''%' then raise exception 'system_set_settlement_destination: patch point not found'; end if;
  src := replace(src, 'now() + interval ''24 hours''', 'now()');
  src := replace(src, '  return query select v_new.id, v_new.address, v_new.ready_at, false;',
    '  -- One address in use: an older one is retired the moment a new one is saved.
  update settlement_destinations d set status = ''removed'', removed_at = now()
   where d.user_id = p_user_id and d.status = ''active'' and d.id <> v_new.id;
  perform notify_payout_address_changed(p_user_id, ''your Lightning payout address was set to '' || v_new.address);
  return query select v_new.id, v_new.address, v_new.ready_at, false;');
  if src not like '%notify_payout_address_changed%' then raise exception 'system_set_settlement_destination: return not found'; end if;
  execute src;
end $do$;
