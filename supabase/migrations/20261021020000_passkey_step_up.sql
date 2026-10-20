-- CPAY — 20261021020000: passkey is the strong factor (authenticator app retired)
--
-- Owner decision 2026-10-21: sign-in is email + password (email verified) or a
-- passkey; Google sign-in and authenticator-app (TOTP) two-step sign-in are
-- switched off. Every check that asked for aal2 now asks for
-- public.strong_session(): an aal2 session (kept only for the switch-over,
-- while Supabase Auth still issues it) OR a session whose sign-in included a
-- passkey (amr method "passkey", which survives refreshes like aal does).
-- Nothing that needed two-step sign-in is weakened: an aal1 password session
-- is still refused everywhere aal2 was required. "oauth" (Google) no longer
-- counts as a fresh sign-in for payouts.
--
-- Turning admin_mfa_required on now needs every active admin to have a passkey.
-- Re-runnable (create or replace only). Rollback: re-apply the previous
-- definitions from 20261021010000 and earlier (no data is changed).

create or replace function public.strong_session()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
      or (jsonb_typeof(auth.jwt() -> 'amr') = 'array'
          and exists (select 1 from jsonb_array_elements(auth.jwt() -> 'amr') e
                      where e ->> 'method' = 'passkey'));
$$;
comment on function public.strong_session() is
  'True for a passkey sign-in session (or aal2 during the switch-over). Replaces the aal2 checks (20261021020000).';
revoke all on function public.strong_session() from public, anon;
grant execute on function public.strong_session() to authenticated;

-- Has this user registered a passkey? auth.webauthn_credentials exists only
-- where Supabase Auth passkeys are available; elsewhere the answer is false.
create or replace function public.user_has_passkey(p_user uuid)
returns boolean language plpgsql stable security definer set search_path = public, auth as $$
declare v boolean := false;
begin
  if to_regclass('auth.webauthn_credentials') is null then return false; end if;
  execute 'select exists (select 1 from auth.webauthn_credentials where user_id = $1)' into v using p_user;
  return coalesce(v, false);
end;
$$;
revoke all on function public.user_has_passkey(uuid) from public, anon, authenticated;

-- Admin lockout guard for the switch-over: which active admins still have no
-- passkey (the owner adds one before Supabase Auth TOTP is switched off).
create or replace function public.admin_passkey_status()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  return jsonb_build_object(
    'admins', (select count(*) from profiles where role = 'admin' and account_status = 'active'),
    'admins_without_passkey', (select count(*) from profiles p where p.role = 'admin' and p.account_status = 'active' and not public.user_has_passkey(p.id)),
    'me_has_passkey', public.user_has_passkey(auth.uid()));
end;
$$;
revoke all on function public.admin_passkey_status() from public, anon;
grant execute on function public.admin_passkey_status() to authenticated;

CREATE OR REPLACE FUNCTION public.admin_auto_withdraw_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if not public.strong_session() then
    raise exception 'Sign in again with your passkey first';
  end if;
  return jsonb_build_object(
    'global', payment_mode() = 'instant_forward',
    'payment_mode', payment_mode(),
    'users', coalesce((select jsonb_agg(jsonb_build_object(
        'user_id', p.id, 'override', coalesce(o.mode, 'default'),
        'auto_withdraw', payment_mode_for(p.id) = 'instant_forward',
        'has_address', exists (select 1 from receive_target_for(p.id)),
        'updated_at', o.updated_at))
      from profiles p left join auto_withdraw_overrides o on o.user_id = p.id), '[]'::jsonb));
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_forward_action(p_id uuid, p_action text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare f payment_forwards; d record; w usdt_wallets; v_to text;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if not public.strong_session() then
    raise exception 'Sign in again with your passkey first';
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
$function$;

CREATE OR REPLACE FUNCTION public.admin_forward_batch_action(p_id uuid, p_action text, p_ref text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare b forward_batches; r text;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if not public.strong_session() then
    raise exception 'Sign in again with your passkey first';
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
$function$;

CREATE OR REPLACE FUNCTION public.admin_locations(p_country text DEFAULT NULL::text, p_area text DEFAULT NULL::text, p_days integer DEFAULT 30, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_country text := geo_country(p_country);
        -- Typed text, matched literally: % and _ are not wildcards here.
        v_area text := replace(replace(replace(geo_clean(p_area), '\', '\\'), '%', '\%'), '_', '\_');
        v_since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 366));
        v_lim int := least(greatest(coalesce(p_limit, 100), 1), 500);
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if not public.strong_session() then
    raise exception 'Sign in again with your passkey first';
  end if;
  return jsonb_build_object(
    'since', v_since,
    'payments_by_area', coalesce((select jsonb_agg(to_jsonb(x) order by x.payments desc) from (
        select coalesce(customer_country, '??') as country, coalesce(customer_region, customer_city, '') as area,
               count(*) as payments, count(*) filter (where status = 'settled') as settled,
               coalesce(sum(amount_settled) filter (where status = 'settled'), 0) as settled_usd
          from payments
         where created_at >= v_since
           and (v_country is null or customer_country = v_country)
           and (v_area is null or customer_region ilike '%' || v_area || '%' or customer_city ilike '%' || v_area || '%')
         group by 1, 2 order by 3 desc limit 200) x), '[]'::jsonb),
    'users_by_area', coalesce((select jsonb_agg(to_jsonb(x) order by x.users desc) from (
        select coalesce(country, '??') as country, coalesce(division, '') as division, coalesce(district, '') as district,
               count(*) as users
          from profile_locations
         where (v_country is null or country = v_country)
           and (v_area is null or division ilike '%' || v_area || '%' or district ilike '%' || v_area || '%' or area ilike '%' || v_area || '%')
         group by 1, 2, 3 order by 4 desc limit 200) x), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc) from (
        select p.id, p.created_at, p.status, p.amount_requested, p.amount_settled, pr.email as user_email,
               l.slug as link_slug,
               p.customer_country as country, p.customer_region as region, p.customer_city as city
          from payments p left join profiles pr on pr.id = p.user_id left join payment_links l on l.id = p.payment_link_id
         where p.created_at >= v_since
           and (v_country is null or p.customer_country = v_country)
           and (v_area is null or p.customer_region ilike '%' || v_area || '%' or p.customer_city ilike '%' || v_area || '%')
         order by p.created_at desc limit v_lim) x), '[]'::jsonb),
    'users', coalesce((select jsonb_agg(to_jsonb(x) order by x.updated_at desc) from (
        select pl.user_id, pr.email, pr.display_name, pl.country, pl.division, pl.district, pl.area,
               pl.last_seen_country, pl.last_seen_at, pl.updated_at
          from profile_locations pl join profiles pr on pr.id = pl.user_id
         where (v_country is null or pl.country = v_country or pl.last_seen_country = v_country)
           and (v_area is null or pl.division ilike '%' || v_area || '%' or pl.district ilike '%' || v_area || '%' or pl.area ilike '%' || v_area || '%')
         order by pl.updated_at desc limit v_lim) x), '[]'::jsonb));
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_remove_domain(p_hostname text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d site_domains;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if not public.strong_session() then
    raise exception 'Sign in again with your passkey first';
  end if;
  select * into d from site_domains where hostname = lower(btrim(coalesce(p_hostname, '')));
  if d.id is null then raise exception 'Domain not found'; end if;
  if d.is_primary_site then raise exception 'This is the main site domain; it cannot be removed here'; end if;
  delete from site_domains where id = d.id;
  perform record_audit('settings.domain', 'site_domain', d.hostname,
    jsonb_build_object('purpose', d.purpose, 'active', d.is_active), jsonb_build_object('removed', true));
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_save_domain(p_hostname text, p_purpose text DEFAULT 'both'::text, p_active boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare h text := lower(btrim(coalesce(p_hostname, ''))); before site_domains; after site_domains;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if not public.strong_session() then
    raise exception 'Sign in again with your passkey first';
  end if;
  h := regexp_replace(regexp_replace(h, '^https?://', ''), '/.*$', '');
  if h !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' or length(h) > 253 then
    raise exception 'Enter a domain like pay.example.com (no https://, no path)';
  end if;
  if coalesce(p_purpose, '') not in ('payment', 'site', 'both') then raise exception 'Purpose must be payment, site or both'; end if;
  select * into before from site_domains where hostname = h;
  if before.id is not null and before.is_primary_site and not p_active then
    raise exception 'This is the main site domain; it cannot be turned off here';
  end if;
  insert into site_domains (hostname, purpose, is_active) values (h, p_purpose, p_active)
  on conflict (hostname) do update set purpose = excluded.purpose, is_active = excluded.is_active
  returning * into after;
  perform record_audit('settings.domain', 'site_domain', h,
    case when before.id is null then null else jsonb_build_object('purpose', before.purpose, 'active', before.is_active) end,
    jsonb_build_object('purpose', after.purpose, 'active', after.is_active));
  return jsonb_build_object('hostname', after.hostname, 'purpose', after.purpose, 'is_active', after.is_active);
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_set_auto_withdraw(p_user uuid, p_mode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_old text; v_before text; v_after text; n integer := 0;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if not public.strong_session() then
    raise exception 'Sign in again with your passkey first';
  end if;
  if p_mode is null or p_mode not in ('default', 'on', 'off') then raise exception 'Choose default, on or off'; end if;
  perform 1 from profiles where id = p_user for update;
  if not found then raise exception 'Unknown user'; end if;
  select mode into v_old from auto_withdraw_overrides where user_id = p_user;
  v_before := payment_mode_for(p_user);
  if p_mode = 'default' then
    delete from auto_withdraw_overrides where user_id = p_user;
  else
    insert into auto_withdraw_overrides(user_id, mode, set_by, updated_at) values (p_user, p_mode, auth.uid(), now())
    on conflict (user_id) do update set mode = excluded.mode, set_by = excluded.set_by, updated_at = excluded.updated_at;
  end if;
  v_after := payment_mode_for(p_user);
  if v_after = 'balance' then n := auto_withdraw_release_waiting(p_user); end if;
  perform record_audit('auto_withdraw.profile', 'profile', p_user::text,
    jsonb_build_object('override', coalesce(v_old, 'default'), 'effective', v_before),
    jsonb_build_object('override', p_mode, 'effective', v_after, 'released_forwards', n));
  return jsonb_build_object('override', p_mode, 'effective', v_after, 'auto_withdraw', v_after = 'instant_forward', 'released_forwards', n);
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_set_auto_withdraw_global(p_on boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_old text := payment_mode(); v_new text; n integer := 0; u record;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if not public.strong_session() then
    raise exception 'Sign in again with your passkey first';
  end if;
  if p_on is null then raise exception 'Choose on or off'; end if;
  v_new := case when p_on then 'instant_forward' else 'balance' end;
  perform admin_set_platform_setting('payment_mode', to_jsonb(v_new));
  if not p_on then
    for u in select distinct f.user_id from payment_forwards f
              where f.status in ('queued', 'retry', 'owed') and f.batch_id is null
                and payment_mode_for(f.user_id) = 'balance' loop
      n := n + auto_withdraw_release_waiting(u.user_id);
    end loop;
  end if;
  perform record_audit('auto_withdraw.global', 'setting', 'payment_mode',
    jsonb_build_object('mode', v_old), jsonb_build_object('mode', v_new, 'released_forwards', n));
  return jsonb_build_object('auto_withdraw', p_on, 'payment_mode', v_new, 'released_forwards', n);
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_set_feature_toggle(p_key text, p_enabled boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if p_key not in (
    'emergency_payments_stop','emergency_withdrawals_stop','manual_withdrawals_enabled',
    'auto_withdraw_enabled','public_feed_enabled','hide_small_payments_enabled',
    'admin_mfa_required','direct_settlement_enabled'
  ) then raise exception 'Unknown toggle'; end if;
  if p_key = 'admin_mfa_required' and p_enabled then
    if not public.strong_session() then
      raise exception 'Sign in again with your passkey first, then turn this on';
    end if;
    if exists (select 1 from profiles p
               where p.role = 'admin' and p.account_status = 'active'
                 and not public.user_has_passkey(p.id)) then
      raise exception 'Every active admin needs a passkey before two-step sign-in can be required';
    end if;
  end if;
  if p_key = 'direct_settlement_enabled' and p_enabled
     and not public.strong_session() then
    raise exception 'Sign in again with your passkey first, then turn direct payments on';
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

CREATE OR REPLACE FUNCTION public.admin_set_platform_setting(p_key text, p_value jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d record; old jsonb;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if not public.strong_session() then
    raise exception 'Sign in again with your passkey first, then change settings';
  end if;
  select * into d from platform_setting_defaults() x where x.key = p_key;
  if not found then raise exception 'Unknown setting'; end if;
  if p_value is null or not platform_setting_valid(d.kind, p_value) then
    raise exception 'Invalid value for %', p_key;
  end if;
  if p_key = 'legal_published' and p_value = 'true'::jsonb then
    if exists (select 1 from platform_setting_defaults() x
               where x.key like 'legal\_%' escape '\' and x.key <> 'legal_published'
                 and coalesce(platform_setting(x.key) #>> '{}', '') = '') then
      raise exception 'Fill in every legal field before publishing the legal pages';
    end if;
  end if;
  if p_key = 'wallet_link_enabled' and p_value = 'true'::jsonb
     and coalesce(platform_setting('wallet_url') #>> '{}', '') = '' then
    raise exception 'Set the CPAY Wallet address before showing the link';
  end if;
  old := platform_setting(p_key);
  insert into platform_settings(key, value, updated_at, updated_by)
  values (p_key, p_value, now(), auth.uid())
  on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  perform record_audit('settings.platform', 'setting', p_key, jsonb_build_object('value', old), jsonb_build_object('value', p_value));
  return p_value;
end;
$function$;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
select exists(select 1 from profiles where id = auth.uid() and role = 'admin' and account_status = 'active')
   and (public.strong_session()
        or (not public.admin_mfa_enforced()
            and not exists (select 1 from auth.mfa_factors f
                            where f.user_id = auth.uid() and f.status::text = 'verified')));
$function$;

CREATE OR REPLACE FUNCTION public.payout_step_up_ok(p_max_age_seconds integer DEFAULT 600)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare c jsonb := auth.jwt(); v_latest numeric := 0; e jsonb; t numeric;
begin
  if coalesce(c ->> 'role', '') <> 'authenticated' then return true; end if;
  if exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified')
     and not public.strong_session() then
    return false;
  end if;
  if jsonb_typeof(c -> 'amr') = 'array' then
    for e in select * from jsonb_array_elements(c -> 'amr') loop
      if e ->> 'method' in ('password', 'passkey', 'sso/saml') and (e ->> 'timestamp') ~ '^\d{1,12}$' then
        t := (e ->> 'timestamp')::numeric;
        if t > v_latest then v_latest := t; end if;
      end if;
    end loop;
  end if;
  return v_latest > 0 and extract(epoch from now()) - v_latest <= p_max_age_seconds
     and v_latest <= extract(epoch from now()) + 120;
end;
$function$;

-- A new or changed payout address (owner decision 2026-10-21): a signed-in
-- account may change it only in a passkey session of that same account, and
-- it is used at once. Without a passkey session the change is refused: there
-- is no 24-hour wait any more. Service-role callers (the settlement-destination
-- Edge Function, which checks the passkey session itself) get now(). An
-- active admin setting someone's address also needs a passkey session.
create or replace function public.payout_ready_at(p_user uuid)
returns timestamptz language plpgsql stable security definer set search_path = public, auth
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') = 'authenticated'
     and not ((auth.uid() = p_user or public.is_admin()) and public.strong_session()) then
    raise exception 'Confirm with your passkey to change address';
  end if;
  return now();
end;
$$;
revoke all on function public.payout_ready_at(uuid) from public, anon, authenticated;

create or replace function public.notify_payout_address_changed(p_user uuid, p_what text, p_ready_at timestamptz default null)
returns void language plpgsql security definer set search_path = public
as $$
begin
  insert into support_messages (user_id, sender, message, read_by_admin, security_notice)
  values (p_user, 'admin',
    'Security notice: ' || left(p_what, 300) || ' at ' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC. ' ||
    'Payments are sent there from now on. ' ||
    'If you did not make this change, change your password and write to us here right away.',
    true, true);
end;
$$;
revoke all on function public.notify_payout_address_changed(uuid, text, timestamptz) from public, anon, authenticated;

-- USDT address trigger: same rule, audit note without the old 24-hour text.
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
    raise exception 'reauth_required: For your security, sign in again with your passkey to change where payments are sent.';
  end if;
  -- Refuses a signed-in change without a passkey session (payout_ready_at).
  new.usable_after := payout_ready_at(new.user_id);
  new.updated_at := now();
  perform public.record_audit(
    'payout_wallet.saved', 'profile', new.user_id::text,
    case when tg_op = 'UPDATE' then jsonb_build_object('network', old.network, 'address', old.address) end,
    jsonb_build_object('network', new.network, 'address', new.address, 'usable_after', new.usable_after),
    'Payout address saved after a passkey sign-in; usable at once');
  perform notify_payout_address_changed(new.user_id,
    'your USDT payout address for ' || new.network || ' was set to ' || new.address, new.usable_after);
  return new;
end;
$$;
revoke all on function public.usdt_wallets_cooldown() from public, anon, authenticated;
