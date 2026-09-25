-- ============================================================
-- 0101: per-reseller "freelancers may withdraw themselves" switch,
--       and a three-level withdrawal fee (account → reseller → global)
-- ============================================================
-- A) SELF-WITHDRAW SWITCH
--   reseller_settings.allow_freelancer_self_withdraw, one row per reseller
--   (profiles.role = 'moderator'). It is a boolean, NOT NULL, DEFAULT FALSE,
--   so the switch is OFF unless someone turns it on. This migration also
--   writes a FALSE row for every reseller that already exists, so existing
--   resellers are OFF too. A reseller without a row counts as OFF.
--
--   When OFF, a freelancer on that reseller's team (profiles.referred_by or
--   moderator_assignments, the same link my_reseller_id() uses) still sees
--   their balance but cannot start a withdrawal. The reseller's
--   reseller_request_withdrawal_for() (team cash-out, gated globally by the
--   feature_reseller_team_withdraw app setting) keeps working either way,
--   and so does an admin filing one for them.
--   When ON, the freelancer withdraws from their own dashboard as before.
--   Freelancers with no reseller, resellers and admins are not affected:
--   they can always withdraw from their own account.
--
--   Enforced here, not only in the browser:
--     * request_withdrawal(), reserve_stablecoin_withdrawal() refuse with
--       SELF_WITHDRAW_OFF_MESSAGE before touching the ledger;
--     * system_queue_withdrawal() (auto-withdraw) queues nothing;
--     * a BEFORE INSERT trigger on withdrawals refuses a signed-in
--       freelancer inserting a row for themselves by any other route
--       (there is no client INSERT policy on withdrawals either);
--     * the user-withdraw edge function and the payment service check
--       self_withdraw_allowed() before quoting.
--   Who can change it: the reseller (reseller_set_self_withdraw) for their
--   own team, and an admin for any reseller (admin_set_reseller_self_withdraw).
--   reseller_settings has RLS with a read policy only; every write goes
--   through those audited SECURITY DEFINER functions.
--
-- B) WITHDRAWAL FEE HIERARCHY
--   The platform withdrawal fee for an account is, in order:
--     1. profiles.withdrawal_fee_percent, the account's own override, if set;
--     2. reseller_settings.team_withdrawal_fee_percent of the freelancer's
--        reseller, if set (applies to freelancers only, not to the
--        reseller's own account);
--     3. app_settings.default_withdrawal_fee_percent (0 since 0100);
--     4. 0.
--   withdrawal_fee_resolution() is the one place this is worked out; every
--   withdrawal path (manual request, auto-queue, reseller team cash-out,
--   stablecoin reserve, and the payment service quote) calls it through
--   resolve_withdrawal_fee().
--
--   profiles.withdrawal_fee_percent now means "override": NULL = inherit.
--   Its default becomes NULL and handle_new_user() stops copying the
--   global default onto new accounts. Existing rows whose fee equals the
--   global default at the time this runs are set to NULL, so nobody's fee
--   changes today; any other value stays as that account's override.
--   admin_update_creator_fee() accepts NULL to clear an override.
--
-- Safe to re-run.
-- ============================================================

-- ---------- table ----------
create table if not exists public.reseller_settings (
  reseller_id uuid primary key references public.profiles(id) on delete cascade,
  allow_freelancer_self_withdraw boolean not null default false,
  team_withdrawal_fee_percent numeric(5,2)
    check (team_withdrawal_fee_percent is null or (team_withdrawal_fee_percent >= 0 and team_withdrawal_fee_percent <= 100)),
  updated_at timestamptz not null default now(),
  updated_by uuid
);
comment on table public.reseller_settings is
  'Per-reseller settings. allow_freelancer_self_withdraw defaults to FALSE (freelancers on the team cannot withdraw themselves). team_withdrawal_fee_percent NULL = use the global default.';

alter table public.reseller_settings enable row level security;
drop policy if exists "reseller settings read own or admin" on public.reseller_settings;
create policy "reseller settings read own or admin" on public.reseller_settings
  for select using (reseller_id = auth.uid() or is_admin());
revoke all on public.reseller_settings from anon;
revoke insert, update, delete, truncate on public.reseller_settings from authenticated;
grant select on public.reseller_settings to authenticated;
grant all on public.reseller_settings to service_role;

-- Every existing reseller starts OFF.
insert into public.reseller_settings (reseller_id, allow_freelancer_self_withdraw)
select id, false from public.profiles where role = 'moderator'
on conflict (reseller_id) do nothing;

-- ---------- per-account fee becomes an optional override ----------
update public.profiles
   set withdrawal_fee_percent = null
 where withdrawal_fee_percent is not null
   and withdrawal_fee_percent = coalesce(
     (select (value->>'percent')::numeric from public.app_settings where key = 'default_withdrawal_fee_percent'), 0);
alter table public.profiles alter column withdrawal_fee_percent drop default;
comment on column public.profiles.withdrawal_fee_percent is
  'Withdrawal platform fee override for this account. NULL = inherit (reseller team fee, then the global default).';

-- ---------- resolution helpers ----------
create or replace function public.reseller_of(p_user_id uuid)
returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select referred_by from profiles where id = p_user_id),
    (select moderator_id from moderator_assignments where creator_id = p_user_id limit 1)
  );
$$;

-- The one fee resolver. source is 'account', 'reseller', 'global' or 'none'.
create or replace function public.withdrawal_fee_resolution(p_user_id uuid)
returns table (fee_percent numeric, source text)
language plpgsql stable security definer set search_path = public as $$
declare v_own numeric; v_role text; v_team numeric; v_global numeric;
begin
  select p.withdrawal_fee_percent, p.role into v_own, v_role from profiles p where p.id = p_user_id;
  if v_own is not null then
    fee_percent := v_own; source := 'account'; return next; return;
  end if;
  if v_role = 'creator' then
    select rs.team_withdrawal_fee_percent into v_team
      from reseller_settings rs where rs.reseller_id = reseller_of(p_user_id);
    if v_team is not null then
      fee_percent := v_team; source := 'reseller'; return next; return;
    end if;
  end if;
  begin
    select round((value->>'percent')::numeric, 2) into v_global
      from app_settings where key = 'default_withdrawal_fee_percent';
  exception when others then v_global := null;
  end;
  if v_global is not null and v_global >= 0 and v_global <= 100 then
    fee_percent := v_global; source := 'global';
  else
    fee_percent := 0; source := 'none';
  end if;
  return next;
end;
$$;

create or replace function public.resolve_withdrawal_fee(p_user_id uuid)
returns numeric
language sql stable security definer set search_path = public as $$
  select fee_percent from withdrawal_fee_resolution(p_user_id);
$$;

-- True unless the account is a freelancer on a reseller's team whose
-- reseller has not turned self-withdraw on.
create or replace function public.self_withdraw_allowed(p_user_id uuid)
returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v_role text; v_reseller uuid;
begin
  select role into v_role from profiles where id = p_user_id;
  if v_role is distinct from 'creator' then return true; end if;
  v_reseller := reseller_of(p_user_id);
  if v_reseller is null then return true; end if;
  return coalesce((select allow_freelancer_self_withdraw from reseller_settings where reseller_id = v_reseller), false);
end;
$$;

create or replace function public.self_withdraw_off_message()
returns text language sql immutable as $$
  select 'Your reseller handles withdrawals for your account. Ask them to withdraw for you.'::text;
$$;

revoke all on function public.reseller_of(uuid) from public, anon, authenticated;
revoke all on function public.withdrawal_fee_resolution(uuid) from public, anon, authenticated;
revoke all on function public.resolve_withdrawal_fee(uuid) from public, anon, authenticated;
revoke all on function public.self_withdraw_allowed(uuid) from public, anon, authenticated;
grant execute on function public.reseller_of(uuid) to service_role;
grant execute on function public.withdrawal_fee_resolution(uuid) to service_role;
grant execute on function public.resolve_withdrawal_fee(uuid) to service_role;
grant execute on function public.self_withdraw_allowed(uuid) to service_role;

-- ---------- what the signed-in user may see ----------
create or replace function public.my_withdraw_settings()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_role text; v_fee record; v_rs reseller_settings; v_global numeric;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  select role into v_role from profiles where id = v_uid;
  select * into v_fee from withdrawal_fee_resolution(v_uid);
  begin
    select round((value->>'percent')::numeric, 2) into v_global from app_settings where key = 'default_withdrawal_fee_percent';
  exception when others then v_global := null;
  end;
  if v_role = 'moderator' then
    select * into v_rs from reseller_settings where reseller_id = v_uid;
  end if;
  return jsonb_build_object(
    'fee_percent', v_fee.fee_percent,
    'fee_source', v_fee.source,
    'self_withdraw_allowed', self_withdraw_allowed(v_uid),
    'has_reseller', v_role = 'creator' and reseller_of(v_uid) is not null,
    'global_fee_percent', coalesce(v_global, 0),
    'team_withdraw_enabled', coalesce((select value from app_settings where key = 'feature_reseller_team_withdraw'), 'true'::jsonb) <> 'false'::jsonb,
    'reseller', case when v_role = 'moderator' then jsonb_build_object(
      'allow_freelancer_self_withdraw', coalesce(v_rs.allow_freelancer_self_withdraw, false),
      'team_withdrawal_fee_percent', v_rs.team_withdrawal_fee_percent) end
  );
end;
$$;

-- ---------- writers ----------
create or replace function public.reseller_set_self_withdraw(p_allowed boolean)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_old boolean;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not is_reseller() then raise exception 'Not authorized'; end if;
  if p_allowed is null then raise exception 'Choose on or off'; end if;
  select allow_freelancer_self_withdraw into v_old from reseller_settings where reseller_id = auth.uid();
  insert into reseller_settings (reseller_id, allow_freelancer_self_withdraw, updated_at, updated_by)
  values (auth.uid(), p_allowed, now(), auth.uid())
  on conflict (reseller_id) do update
    set allow_freelancer_self_withdraw = excluded.allow_freelancer_self_withdraw, updated_at = now(), updated_by = auth.uid();
  perform record_audit('reseller.self_withdraw_changed', 'profile', auth.uid()::text,
    jsonb_build_object('allow_freelancer_self_withdraw', coalesce(v_old, false)),
    jsonb_build_object('allow_freelancer_self_withdraw', p_allowed));
  return p_allowed;
end;
$$;

create or replace function public.admin_set_reseller_self_withdraw(p_reseller_id uuid, p_allowed boolean)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_old boolean;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if p_allowed is null then raise exception 'Choose on or off'; end if;
  if not exists (select 1 from profiles where id = p_reseller_id and role = 'moderator') then
    raise exception 'Reseller not found';
  end if;
  select allow_freelancer_self_withdraw into v_old from reseller_settings where reseller_id = p_reseller_id;
  insert into reseller_settings (reseller_id, allow_freelancer_self_withdraw, updated_at, updated_by)
  values (p_reseller_id, p_allowed, now(), auth.uid())
  on conflict (reseller_id) do update
    set allow_freelancer_self_withdraw = excluded.allow_freelancer_self_withdraw, updated_at = now(), updated_by = auth.uid();
  perform record_audit('reseller.self_withdraw_changed', 'profile', p_reseller_id::text,
    jsonb_build_object('allow_freelancer_self_withdraw', coalesce(v_old, false)),
    jsonb_build_object('allow_freelancer_self_withdraw', p_allowed));
  return p_allowed;
end;
$$;

-- NULL clears the reseller level, so the team falls back to the global default.
create or replace function public.admin_set_reseller_withdrawal_fee(p_reseller_id uuid, p_fee_percent numeric)
returns numeric
language plpgsql security definer set search_path = public as $$
declare v_old numeric;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if p_fee_percent is not null and (p_fee_percent < 0 or p_fee_percent > 100) then
    raise exception 'Fee must be between 0 and 100';
  end if;
  if not exists (select 1 from profiles where id = p_reseller_id and role = 'moderator') then
    raise exception 'Reseller not found';
  end if;
  select team_withdrawal_fee_percent into v_old from reseller_settings where reseller_id = p_reseller_id;
  insert into reseller_settings (reseller_id, team_withdrawal_fee_percent, updated_at, updated_by)
  values (p_reseller_id, round(p_fee_percent, 2), now(), auth.uid())
  on conflict (reseller_id) do update
    set team_withdrawal_fee_percent = excluded.team_withdrawal_fee_percent, updated_at = now(), updated_by = auth.uid();
  perform record_audit('reseller.withdrawal_fee_changed', 'profile', p_reseller_id::text,
    jsonb_build_object('team_withdrawal_fee_percent', v_old),
    jsonb_build_object('team_withdrawal_fee_percent', round(p_fee_percent, 2)));
  return round(p_fee_percent, 2);
end;
$$;

create or replace function public.admin_set_default_withdrawal_fee(p_percent numeric)
returns numeric
language plpgsql security definer set search_path = public as $$
declare v_old jsonb;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if p_percent is null or p_percent < 0 or p_percent > 100 then raise exception 'Fee must be between 0 and 100'; end if;
  select value into v_old from app_settings where key = 'default_withdrawal_fee_percent';
  insert into app_settings (key, value, updated_at)
  values ('default_withdrawal_fee_percent', jsonb_build_object('percent', round(p_percent, 2)), now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
  perform record_audit('settings.default_withdrawal_fee', 'setting', 'default_withdrawal_fee_percent',
    v_old, jsonb_build_object('percent', round(p_percent, 2)));
  return round(p_percent, 2);
end;
$$;

-- Same signature as before; NULL now clears the override (inherit).
create or replace function public.admin_update_creator_fee(p_creator_id uuid, p_fee_percent numeric)
returns void
language plpgsql security definer set search_path = public as $$
declare v_old numeric;
begin
  if not is_admin() then
    raise exception 'Not authorized';
  end if;
  if p_fee_percent is not null and (p_fee_percent < 0 or p_fee_percent > 100) then
    raise exception 'Fee must be between 0 and 100';
  end if;

  select withdrawal_fee_percent into v_old from profiles where id = p_creator_id;
  if not found then raise exception 'Creator not found'; end if;

  update profiles set withdrawal_fee_percent = p_fee_percent where id = p_creator_id;

  perform record_audit(
    'creator.fee_changed', 'profile', p_creator_id::text,
    jsonb_build_object('withdrawal_fee_percent', v_old),
    jsonb_build_object('withdrawal_fee_percent', p_fee_percent)
  );
end;
$$;

create or replace function public.admin_list_reseller_settings()
returns table (reseller_id uuid, display_name text, email text, allow_freelancer_self_withdraw boolean,
               team_withdrawal_fee_percent numeric, team_size integer)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  return query
  select p.id, p.display_name, p.email,
         coalesce(rs.allow_freelancer_self_withdraw, false),
         rs.team_withdrawal_fee_percent,
         (select count(*)::int from profiles c where c.role = 'creator' and reseller_of(c.id) = p.id)
    from profiles p
    left join reseller_settings rs on rs.reseller_id = p.id
   where p.role = 'moderator'
   order by coalesce(p.display_name, p.email);
end;
$$;

create or replace function public.admin_withdraw_fee_overview()
returns table (user_id uuid, own_fee_percent numeric, fee_percent numeric, source text, self_withdraw_allowed boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  return query
  select p.id, p.withdrawal_fee_percent, r.fee_percent, r.source, self_withdraw_allowed(p.id)
    from profiles p cross join lateral withdrawal_fee_resolution(p.id) r;
end;
$$;

revoke all on function public.my_withdraw_settings() from public, anon;
revoke all on function public.reseller_set_self_withdraw(boolean) from public, anon;
revoke all on function public.admin_set_reseller_self_withdraw(uuid, boolean) from public, anon;
revoke all on function public.admin_set_reseller_withdrawal_fee(uuid, numeric) from public, anon;
revoke all on function public.admin_set_default_withdrawal_fee(numeric) from public, anon;
revoke all on function public.admin_list_reseller_settings() from public, anon;
revoke all on function public.admin_withdraw_fee_overview() from public, anon;
grant execute on function public.my_withdraw_settings() to authenticated, service_role;
grant execute on function public.reseller_set_self_withdraw(boolean) to authenticated;
grant execute on function public.admin_set_reseller_self_withdraw(uuid, boolean) to authenticated;
grant execute on function public.admin_set_reseller_withdrawal_fee(uuid, numeric) to authenticated;
grant execute on function public.admin_set_default_withdrawal_fee(numeric) to authenticated;
grant execute on function public.admin_list_reseller_settings() to authenticated;
grant execute on function public.admin_withdraw_fee_overview() to authenticated;

-- ---------- new accounts inherit the fee ----------
-- Body copied from 0091; the only change is that withdrawal_fee_percent is
-- left NULL (inherit) instead of a copy of the global default.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_name text := coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''), split_part(new.email, '@', 1));
  v_requested_role text := case
    when new.raw_user_meta_data->>'requested_role' = 'reseller' then 'reseller'
    else 'freelancer'
  end;
  v_default_links int;
  v_auto boolean := cpay_auto_approval_enabled(v_requested_role);
  v_status text := case when v_auto then 'active' else 'pending' end;
  v_role text := case when v_auto and v_requested_role = 'reseller' then 'moderator' else 'creator' end;
  v_aff text := nullif(lower(trim(coalesce(new.raw_user_meta_data->>'affiliate_code',''))), '');
  v_reseller uuid;
  v_code text;
begin
  select coalesce((value->>'count')::int, 5)
    into v_default_links
  from app_settings where key = 'default_max_payment_links';

  if v_role = 'moderator' then
    v_code := cpay_make_affiliate_code(new.id);
  end if;

  insert into public.profiles
    (id, email, display_name, role, account_status,
     withdrawal_fee_percent, max_payment_links, affiliate_code)
  values
    (new.id, new.email, v_name, v_role, v_status,
     null, coalesce(v_default_links, 5), v_code)
  on conflict (id) do nothing;

  insert into public.account_applications
    (user_id, email, display_name, requested_role, status, reviewed_at)
  values
    (new.id, new.email, v_name, v_requested_role,
     case when v_auto then 'approved' else 'pending' end,
     case when v_auto then now() else null end)
  on conflict (user_id) do update
    set email = excluded.email,
        display_name = excluded.display_name,
        requested_role = excluded.requested_role,
        updated_at = now();

  if v_requested_role = 'freelancer' and v_aff is not null then
    select id into v_reseller
    from profiles
    where lower(affiliate_code) = v_aff
      and role = 'moderator'
      and account_status = 'active'
    limit 1;
    if v_reseller is not null then
      perform attach_freelancer_to_reseller(new.id, v_reseller);
    end if;
  end if;

  return new;
end;
$$;

-- ---------- withdrawal paths ----------
-- Bodies copied from 0097 (request_withdrawal, system_queue_withdrawal,
-- reserve_stablecoin_withdrawal) and 0095 (reseller_request_withdrawal_for).
-- Changes: the fee comes from resolve_withdrawal_fee(), and the three
-- self-service paths check self_withdraw_allowed() before any insert.

create or replace function public.request_withdrawal(p_amount numeric, p_method text, p_destination text)
returns public.withdrawals
language plpgsql security definer set search_path = public as $_$
declare v_uid uuid:=auth.uid(); v_fee numeric; v_available numeric; v_after numeric; v_row withdrawals; v_limit profile_limits; v_used numeric;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if coalesce((select value::text from app_settings where key='emergency_withdrawals_stop'),'false')='true' then raise exception 'Withdrawals are temporarily paused by the platform operator.'; end if;
  if coalesce((select value::text from app_settings where key='manual_withdrawals_enabled'),'true') <> 'true' then raise exception 'Withdrawal requests are temporarily paused. Please try again later.'; end if;
  perform 1 from profiles where id=v_uid for update;
  if not self_withdraw_allowed(v_uid) then raise exception '%', self_withdraw_off_message(); end if;
  if p_amount is null or p_amount < 5 then raise exception 'Minimum withdrawal is $5'; end if;
  if p_method = 'usdt_bep20' then raise exception 'USDT withdrawals are sent instantly. Choose Stablecoin (instant) instead.'; end if;
  if p_method is null or p_method not in ('bkash','nagad','binance','lightning','bank') then raise exception 'Invalid withdrawal method'; end if;
  if p_destination is null or length(trim(p_destination))=0 then raise exception 'Destination account is required'; end if;
  if length(trim(p_destination)) > 500 then raise exception 'Destination is too long'; end if;
  select * into v_limit from profile_limits where user_id=v_uid;
  if v_limit.single_withdrawal_limit is not null and p_amount > v_limit.single_withdrawal_limit then raise exception 'This amount exceeds your single-withdrawal limit of $%', v_limit.single_withdrawal_limit; end if;
  select coalesce(sum(amount_requested),0) into v_used from withdrawals where user_id=v_uid and status in ('pending','approved','processing','sending','paid') and requested_at >= business_day_start(current_business_day());
  if v_limit.daily_withdrawal_limit is not null and v_used+p_amount > v_limit.daily_withdrawal_limit then raise exception 'This request exceeds your daily withdrawal limit of $%', v_limit.daily_withdrawal_limit; end if;
  v_fee := resolve_withdrawal_fee(v_uid);
  select b.available into v_available from get_balance_for(v_uid) b;
  if p_amount > v_available then raise exception 'Insufficient balance. Available: $%', round(v_available,2); end if;
  v_after:=round(p_amount*(1-v_fee/100),2);
  insert into withdrawals(user_id,amount_requested,fee_percent,amount_after_fee,method,destination,status) values(v_uid,p_amount,v_fee,v_after,p_method,trim(p_destination),'pending') returning * into v_row;
  return v_row;
end; $_$;

create or replace function public.system_queue_withdrawal(p_user_id uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_profile profiles; v_limit profile_limits; v_available numeric; v_used numeric; v_amount numeric; v_destination text; v_method text; v_id uuid; v_fee numeric;
begin
  if coalesce((select value::text from app_settings where key='emergency_withdrawals_stop'),'false')='true' then return null; end if;
  if coalesce((select value::text from app_settings where key='manual_withdrawals_enabled'),'true') <> 'true' then return null; end if;
  select * into v_profile from profiles where id=p_user_id for update;
  if not found or v_profile.account_status <> 'active' or coalesce(v_profile.auto_withdraw_enabled,false)=false then return null; end if;
  -- Auto-withdraw is the account paying itself out, so it follows the
  -- reseller's self-withdraw switch.
  if not self_withdraw_allowed(p_user_id) then return null; end if;
  select * into v_limit from profile_limits where user_id=p_user_id;
  v_method:=v_profile.default_withdrawal_method;
  if v_method is null or v_method not in ('bkash','nagad','binance','bank') then return null; end if;
  v_destination:=coalesce(nullif(trim(coalesce(v_profile.default_withdrawal_destination,'')),''),case v_method when 'bkash' then v_profile.wallet_bkash when 'nagad' then v_profile.wallet_nagad when 'binance' then v_profile.wallet_binance_id when 'bank' then v_profile.wallet_bank end);
  if v_destination is null or length(trim(v_destination))=0 then return null; end if;
  select b.available into v_available from get_balance_for(p_user_id) b;
  if v_available is null or v_available < 5 then return null; end if;
  select coalesce(sum(amount_requested),0) into v_used from withdrawals where user_id=p_user_id and status in ('pending','approved','processing','sending','paid') and requested_at >= business_day_start(current_business_day());
  v_amount:=least(v_available,coalesce(v_limit.single_withdrawal_limit,v_available));
  if v_limit.daily_withdrawal_limit is not null then v_amount:=least(v_amount,greatest(v_limit.daily_withdrawal_limit-v_used,0)); end if;
  if v_amount < 5 then return null; end if;
  v_fee := resolve_withdrawal_fee(p_user_id);
  insert into withdrawals(user_id,amount_requested,fee_percent,amount_after_fee,method,destination,status,admin_note) values(p_user_id,v_amount,v_fee,round(v_amount*(1-v_fee/100),2),v_method,trim(v_destination),'pending','Auto-queued on settlement') returning id into v_id;
  return v_id;
end; $$;

create or replace function public.reserve_stablecoin_withdrawal(
  p_user_id uuid,
  p_quote_id text,
  p_amount numeric,
  p_fee_percent numeric,
  p_amount_after_fee numeric,
  p_coin text,
  p_chain text,
  p_destination text,
  p_quoted_fee numeric,
  p_amount_out numeric,
  p_amount_sat bigint,
  p_quote_expires_at timestamptz
) returns public.withdrawals
language plpgsql security definer set search_path = public as $$
declare v_profile profiles; v_limit profile_limits; v_used numeric; v_available numeric; v_row withdrawals;
begin
  if p_user_id is null or coalesce(p_quote_id,'') = '' then raise exception 'User and quote are required'; end if;
  select * into v_profile from profiles where id=p_user_id for update;
  if not found then raise exception 'Unknown user'; end if;

  -- Checked after the profile lock so a concurrent confirm of the same
  -- quote waits here and then sees the committed row.
  select * into v_row from withdrawals where quote_id=p_quote_id;
  if found then
    if v_row.user_id <> p_user_id then raise exception 'Quote belongs to another user'; end if;
    return v_row;
  end if;

  if coalesce((select value::text from app_settings where key='emergency_withdrawals_stop'),'false')='true' then raise exception 'Withdrawals are temporarily paused by the platform operator.'; end if;
  if v_profile.account_status <> 'active' then raise exception 'Account approval is required before requesting withdrawals'; end if;
  if not cpay_feature_enabled(p_user_id,'can_request_withdrawals') then raise exception 'Withdrawal requests are disabled for this account'; end if;
  if not self_withdraw_allowed(p_user_id) then raise exception '%', self_withdraw_off_message(); end if;
  if p_quote_expires_at is null or p_quote_expires_at <= now() then raise exception 'Quote expired'; end if;
  if p_amount is null or p_amount < 5 then raise exception 'Minimum withdrawal is $5'; end if;
  if coalesce(p_coin,'') = '' or coalesce(p_chain,'') = '' then raise exception 'Coin and chain are required'; end if;
  if p_amount_sat is null or p_amount_sat <= 0 then raise exception 'Quoted sats must be positive'; end if;
  if p_destination is null or length(trim(p_destination))=0 then raise exception 'Destination address is required'; end if;
  if length(trim(p_destination)) > 200 then raise exception 'Destination is too long'; end if;
  if p_fee_percent is distinct from resolve_withdrawal_fee(p_user_id)
     or p_amount_after_fee is distinct from round(p_amount*(1-p_fee_percent/100),2) then
    raise exception 'Withdrawal fee changed. Review the new quote.';
  end if;

  select * into v_limit from profile_limits where user_id=p_user_id;
  if v_limit.single_withdrawal_limit is not null and p_amount > v_limit.single_withdrawal_limit then raise exception 'This amount exceeds your single-withdrawal limit of $%', v_limit.single_withdrawal_limit; end if;
  select coalesce(sum(amount_requested),0) into v_used from withdrawals where user_id=p_user_id and status in ('pending','approved','processing','sending','paid') and requested_at >= business_day_start(current_business_day());
  if v_limit.daily_withdrawal_limit is not null and v_used+p_amount > v_limit.daily_withdrawal_limit then raise exception 'This request exceeds your daily withdrawal limit of $%', v_limit.daily_withdrawal_limit; end if;
  select b.available into v_available from get_balance_for(p_user_id) b;
  if p_amount > v_available then raise exception 'Insufficient balance. Available: $%', round(v_available,2); end if;

  insert into withdrawals(user_id, amount_requested, fee_percent, amount_after_fee, method, destination, status,
                          quote_id, coin, chain, amount_sat, quoted_fee, amount_out, quote_expires_at)
  values (p_user_id, p_amount, p_fee_percent, p_amount_after_fee, 'stablecoin', trim(p_destination), 'sending',
          p_quote_id, p_coin, p_chain, p_amount_sat, p_quoted_fee, p_amount_out, p_quote_expires_at)
  returning * into v_row;
  return v_row;
end; $$;

revoke all on function public.reserve_stablecoin_withdrawal(uuid,text,numeric,numeric,numeric,text,text,text,numeric,numeric,bigint,timestamptz) from public, anon, authenticated;
grant execute on function public.reserve_stablecoin_withdrawal(uuid,text,numeric,numeric,numeric,text,text,text,numeric,numeric,bigint,timestamptz) to service_role;

-- Team cash-out by the reseller (or an admin). Deliberately NOT subject to
-- the self-withdraw switch: this is how the reseller withdraws for a team
-- member when self-withdraw is off. Still gated by the global
-- feature_reseller_team_withdraw setting, as before.
create or replace function public.reseller_request_withdrawal_for(p_user_id uuid, p_amount numeric, p_method text, p_destination text)
returns public.withdrawals
language plpgsql security definer set search_path = public as $_$
declare
  v_row withdrawals;
  v_avail numeric;
  v_fee numeric;
  v_after numeric;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not is_admin() then
    if not is_reseller() then raise exception 'Not authorized'; end if;
    if p_user_id <> auth.uid() and not reseller_owns(p_user_id) then
      raise exception 'That account is not on your team';
    end if;
    if coalesce((select value from app_settings where key='feature_reseller_team_withdraw'),'true'::jsonb) = 'false'::jsonb then
      raise exception 'Team withdrawals are turned off';
    end if;
  end if;
  if coalesce((select value::text from app_settings where key='emergency_withdrawals_stop'),'false') = 'true' then
    raise exception 'Withdrawals are paused';
  end if;
  if p_amount is null or p_amount < 5 then raise exception 'Minimum withdrawal is $5'; end if;
  if p_method = 'usdt_bep20' then
    raise exception 'USDT withdrawals are sent instantly from the account''s own dashboard.';
  end if;
  if p_method not in ('bkash','nagad','binance','lightning','bank') then
    raise exception 'Invalid method';
  end if;
  if nullif(trim(p_destination),'') is null then raise exception 'Destination required'; end if;

  perform 1 from profiles where id = p_user_id for update;
  select available into v_avail from get_balance_for(p_user_id);
  if v_avail is null or v_avail < p_amount then
    raise exception 'Insufficient balance. Available: $%', coalesce(v_avail,0);
  end if;
  v_fee := resolve_withdrawal_fee(p_user_id);
  v_after := round(p_amount * (1 - v_fee / 100.0), 2);
  insert into withdrawals(user_id, amount_requested, fee_percent, amount_after_fee, method, destination, status, admin_note)
  values (p_user_id, p_amount, v_fee, v_after, p_method, trim(p_destination), 'pending',
          case when p_user_id = auth.uid() then null else 'Submitted by reseller' end)
  returning * into v_row;
  return v_row;
end;
$_$;

-- ---------- last line of defence on the table ----------
-- A signed-in freelancer creating a withdrawal row for themselves, by any
-- route, is refused while their reseller's switch is off. Rows a reseller
-- or an admin files for them (user_id <> auth.uid()) and service-role
-- writes (auth.uid() is null; they check self_withdraw_allowed() above)
-- are not affected.
create or replace function public.guard_withdrawal_self_allowed()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not is_admin() and new.user_id = auth.uid()
     and not self_withdraw_allowed(new.user_id) then
    raise exception '%', self_withdraw_off_message();
  end if;
  return new;
end;
$$;
drop trigger if exists trg_guard_withdrawal_self_allowed on public.withdrawals;
create trigger trg_guard_withdrawal_self_allowed before insert on public.withdrawals
  for each row execute function public.guard_withdrawal_self_allowed();
