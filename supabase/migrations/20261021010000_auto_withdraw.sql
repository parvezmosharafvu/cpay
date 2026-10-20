-- Auto withdraw switch (docs/AUTO-WITHDRAW.md).
--
-- "Auto withdraw" is the plain name for the existing payment modes:
--   ON  = payment_mode 'instant_forward': after the platform fee, each
--         settled payment is forwarded to the user's saved receive address
--         (Lightning address, or USDT on a network the wallet swap supports).
--   OFF = payment_mode 'balance': the amount is credited to the user's
--         balance; the user withdraws by hand (Withdraw page).
-- The global switch is the payment_mode setting. A per-profile override
-- (Default / On / Off) lives in auto_withdraw_overrides and is set only by
-- an active admin at aal2 through admin_set_auto_withdraw() (audited).
-- payment_mode_for(user) is the one place that decides per user; the
-- forward trigger, the payment gate, the forward workers and the desk read it.
-- Turning a user OFF releases their waiting forwards into their balance.
-- Manual Lightning withdrawals (reserve_lightning_withdrawal) reuse the
-- withdrawals table, limits and row lock of the USDT path. Re-appliable.

-- 1. Per-profile override ----------------------------------------------------
create table if not exists public.auto_withdraw_overrides (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  mode       text not null check (mode in ('on', 'off')),
  set_by     uuid,
  updated_at timestamptz not null default now()
);
comment on table public.auto_withdraw_overrides is
  'Auto withdraw per profile: on/off overrides the global payment_mode; no row = follow the global switch. Written only by admin_set_auto_withdraw().';
alter table public.auto_withdraw_overrides enable row level security;
revoke all on public.auto_withdraw_overrides from public, anon, authenticated;

-- 2. Effective mode per user -------------------------------------------------
create or replace function public.payment_mode_for(p_user uuid)
returns text language sql stable security definer set search_path = public
as $$
  select case
    when payment_mode() = 'direct' then 'direct'
    when o.mode = 'on' then 'instant_forward'
    when o.mode = 'off' then 'balance'
    else payment_mode() end
  from (select 1) one left join auto_withdraw_overrides o on o.user_id = p_user
$$;
revoke all on function public.payment_mode_for(uuid) from public, anon, authenticated;
grant execute on function public.payment_mode_for(uuid) to service_role;

-- A Lightning address can be saved when auto withdraw is on for the user
-- (globally or by override). Direct links stay gated separately
-- (direct_settlement_enabled_for / system_direct_destination_for).
create or replace function public.settlement_address_allowed_for(p_user_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select direct_settlement_enabled_for(p_user_id) or payment_mode() = 'instant_forward'
          or payment_mode_for(p_user_id) = 'instant_forward' $$;
revoke all on function public.settlement_address_allowed_for(uuid) from public, anon, authenticated;
grant execute on function public.settlement_address_allowed_for(uuid) to service_role;

do $do$
declare src text := pg_get_functiondef('public.get_my_direct_settlement()'::regprocedure);
begin
  if src like '%payment_mode_for(v_uid)%' then return; end if;
  if src not like '%''instant_forward'', payment_mode() = ''instant_forward'',%' then
    raise exception 'get_my_direct_settlement: patch point not found';
  end if;
  execute replace(src, '''instant_forward'', payment_mode() = ''instant_forward'',',
                       '''instant_forward'', payment_mode_for(v_uid) = ''instant_forward'',');
end $do$;

-- 3. Forward trigger and payment gate use the user's effective mode ---------
create or replace function public.instant_forward_enqueue()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  t record; v_kind text := 'lightning'; v_dest uuid; v_addr text; v_net text;
  v_fee bigint; v_fwd bigint; v_status text := 'queued'; v_reason text;
  v_max jsonb := platform_setting('instant_forward_max_usd');
begin
  if payment_mode_for(new.user_id) <> 'instant_forward' then return new; end if;
  select * into t from receive_target_for(new.user_id);
  if t.kind is not null then v_kind := t.kind; v_dest := t.destination_id; v_addr := t.address; v_net := t.network; end if;
  if v_addr is null and coalesce(platform_setting('instant_forward_no_address') #>> '{}', 'balance') = 'balance' then
    return new;  -- stays in the balance, as before
  end if;
  if coalesce(new.amount_sat, 0) <= 0 or coalesce(new.amount_settled, 0) <= 0 then
    v_fee := 0; v_fwd := greatest(coalesce(new.amount_sat, 0), 0); v_status := 'owed'; v_reason := 'no_amount';
  else
    v_fee := least(new.amount_sat, greatest(0, round(new.amount_sat * coalesce(new.platform_fee_amount, 0) / new.amount_settled)::bigint));
    v_fwd := new.amount_sat - v_fee;
  end if;
  if v_reason is null and v_addr is null then v_status := 'owed'; v_reason := 'no_address';
  elsif v_reason is null and v_kind = 'lightning'
        and v_fwd < coalesce((platform_setting('instant_forward_min_sat') #>> '{}')::bigint, 100) then
    v_status := 'owed'; v_reason := 'below_minimum';
  elsif v_reason is null and jsonb_typeof(v_max) = 'number'
        and new.amount_settled - coalesce(new.platform_fee_amount, 0) > (v_max #>> '{}')::numeric then
    v_status := 'owed'; v_reason := 'over_limit';
  end if;
  insert into payment_forwards (payment_id, user_id, destination_id, address, kind, network, gross_sat, fee_sat, forward_sat,
                                fee_usd, amount_usd, status, reason, next_attempt_at)
  values (new.id, new.user_id, v_dest, v_addr, v_kind, v_net, greatest(coalesce(new.amount_sat, 0), 0), v_fee, v_fwd,
          coalesce(new.platform_fee_amount, 0), coalesce(new.amount_settled, 0) - coalesce(new.platform_fee_amount, 0),
          v_status, v_reason, case when v_status = 'queued' then now() end)
  on conflict (payment_id) do nothing;
  return new;
end;
$$;

create or replace function public.gate_custodial_payment()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if platform_setting('custodial_receive_enabled') = 'false'::jsonb then
    raise exception 'CPAY balance payments are turned off. This link is not taking payments right now.';
  end if;
  if payment_mode_for(new.user_id) = 'instant_forward'
     and platform_setting('instant_forward_no_address') = '"refuse"'::jsonb
     and not exists (select 1 from receive_target_for(new.user_id)) then
    raise exception 'This link is not taking payments right now.';
  end if;
  return new;
end;
$$;

-- 4. Workers send only for users whose auto withdraw is on ------------------
create or replace function public.system_forward_claim(p_limit integer default 10)
returns setof public.payment_forwards language plpgsql security definer set search_path = public
as $$
begin
  return query
  update payment_forwards f set status = 'sending', attempts = f.attempts + 1, last_error = null
   where f.id in (select x.id from payment_forwards x
                   where x.kind = 'lightning'
                     and (x.status = 'queued' or (x.status = 'retry' and x.next_attempt_at <= now()))
                     and payment_mode_for(x.user_id) = 'instant_forward'
                   order by x.created_at limit greatest(1, least(coalesce(p_limit, 10), 50))
                   for update skip locked)
  returning f.*;
end;
$$;

create or replace function public.system_usdt_due()
returns table(user_id uuid, network text, address text, total_usd numeric, total_sat bigint, n integer, oldest timestamptz)
language sql stable security definer set search_path = public
as $$
  select f.user_id, f.network, w.address, sum(f.amount_usd), sum(f.forward_sat)::bigint, count(*)::int, min(f.created_at)
    from payment_forwards f
    join usdt_wallets w on w.user_id = f.user_id and w.network = f.network and w.usable_after <= now()
   where payment_mode_for(f.user_id) = 'instant_forward' and f.kind = 'usdt'
     and (f.status = 'queued' or (f.status = 'retry' and f.next_attempt_at <= now()))
     and not exists (select 1 from forward_batches b where b.user_id = f.user_id and b.network = f.network and b.status = 'sending')
   group by f.user_id, f.network, w.address
   order by min(f.created_at)
   limit 50
$$;

do $do$
declare src text := pg_get_functiondef('public.system_usdt_batch_create(uuid,text,text)'::regprocedure);
begin
  if src like '%payment_mode_for(p_user)%' then return; end if;
  if src not like '%if payment_mode() <> ''instant_forward'' then return; end if;%' then
    raise exception 'system_usdt_batch_create: patch point not found';
  end if;
  execute replace(src, 'if payment_mode() <> ''instant_forward'' then return; end if;',
                       'if payment_mode_for(p_user) <> ''instant_forward'' then return; end if;');
end $do$;

-- 5. Turning auto withdraw off: waiting forwards go to the balance ----------
-- Only rows not yet handed to the wallet (queued, retry, owed). A forward in
-- 'sending' finishes as it is. Internal.
create or replace function public.auto_withdraw_release_waiting(p_user uuid)
returns integer language plpgsql security definer set search_path = public
as $$
declare n integer;
begin
  update payment_forwards set status = 'owed', reason = 'auto_withdraw_off', next_attempt_at = null
   where user_id = p_user and status in ('queued', 'retry') and batch_id is null;
  update payment_forwards set status = 'released', next_attempt_at = null
   where user_id = p_user and status = 'owed' and batch_id is null;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.auto_withdraw_release_waiting(uuid) from public, anon, authenticated;

-- 6. Admin: global switch and per-profile override (aal2, audited) ----------

create or replace function public.admin_set_auto_withdraw_global(p_on boolean)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_old text := payment_mode(); v_new text; n integer := 0; u record;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'Enter your authenticator code first (sign in again with two-step sign-in)';
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
$$;
revoke all on function public.admin_set_auto_withdraw_global(boolean) from public, anon;
grant execute on function public.admin_set_auto_withdraw_global(boolean) to authenticated;

create or replace function public.admin_set_auto_withdraw(p_user uuid, p_mode text)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_old text; v_before text; v_after text; n integer := 0;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'Enter your authenticator code first (sign in again with two-step sign-in)';
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
$$;
revoke all on function public.admin_set_auto_withdraw(uuid, text) from public, anon;
grant execute on function public.admin_set_auto_withdraw(uuid, text) to authenticated;

-- Everyone's override and effective state, for Admin > Manage users.
create or replace function public.admin_auto_withdraw_overview()
returns jsonb language plpgsql stable security definer set search_path = public
as $$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'Enter your authenticator code first (sign in again with two-step sign-in)';
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
$$;
revoke all on function public.admin_auto_withdraw_overview() from public, anon;
grant execute on function public.admin_auto_withdraw_overview() to authenticated;

-- 7. What the desk shows ----------------------------------------------------
create or replace function public.my_receive_settings()
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare v_uid uuid := auth.uid(); t record; ln record; v_mode text;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  v_mode := payment_mode_for(v_uid);
  select * into t from receive_target_for(v_uid);
  select d.address into ln from settlement_destinations d
   where d.user_id = v_uid and d.status = 'active' and d.ready_at <= now() order by d.created_at desc limit 1;
  return jsonb_build_object(
    'method', coalesce(t.kind, 'none'),
    'usdt_network', t.network,
    'usdt_address', case when t.kind = 'usdt' then t.address end,
    'lightning_address', ln.address,
    'target_address', t.address,
    'payment_mode', v_mode,
    'auto_withdraw', v_mode = 'instant_forward',
    'auto_withdraw_source', case when exists (select 1 from auto_withdraw_overrides o where o.user_id = v_uid) then 'account' else 'platform' end);
end;
$$;
revoke all on function public.my_receive_settings() from public, anon;
grant execute on function public.my_receive_settings() to authenticated;

-- 8. Manual Lightning withdrawal (service role, from the wallet function) ---
-- Same checks, lock and limits as reserve_stablecoin_withdrawal(): the
-- profile row is locked, so two confirms cannot both spend one balance.
-- Destination: the user's saved Lightning address, or a BOLT11 invoice.
create or replace function public.lightning_withdraw_destination_ok(p_user uuid, p_address text)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (select 1 from settlement_destinations d
                  where d.user_id = p_user and d.status = 'active' and d.ready_at <= now()
                    and d.address = lower(trim(coalesce(p_address, ''))))
$$;
revoke all on function public.lightning_withdraw_destination_ok(uuid, text) from public, anon, authenticated;
grant execute on function public.lightning_withdraw_destination_ok(uuid, text) to service_role;

create or replace function public.reserve_lightning_withdrawal(p_user_id uuid, p_quote_id text, p_amount numeric,
  p_fee_percent numeric, p_amount_after_fee numeric, p_destination text, p_amount_sat bigint,
  p_routing_fee_sat bigint, p_quote_expires_at timestamptz)
returns withdrawals
language plpgsql security definer set search_path = public
as $$
declare v_profile profiles; v_limit profile_limits; v_used numeric; v_available numeric; v_row withdrawals;
        v_dest text := trim(coalesce(p_destination, ''));
begin
  if p_user_id is null or coalesce(p_quote_id, '') = '' then raise exception 'User and quote are required'; end if;
  select * into v_profile from profiles where id = p_user_id for update;
  if not found then raise exception 'Unknown user'; end if;
  select * into v_row from withdrawals where quote_id = p_quote_id;
  if found then
    if v_row.user_id <> p_user_id then raise exception 'Quote belongs to another user'; end if;
    return v_row;
  end if;
  if coalesce((select value::text from app_settings where key = 'emergency_withdrawals_stop'), 'false') = 'true' then
    raise exception 'Withdrawals are temporarily paused by the platform operator.';
  end if;
  if v_profile.account_status <> 'active' then raise exception 'Account approval is required before requesting withdrawals'; end if;
  if not cpay_feature_enabled(p_user_id, 'can_request_withdrawals') then raise exception 'Withdrawal requests are disabled for this account'; end if;
  if p_quote_expires_at is null or p_quote_expires_at <= now() then raise exception 'Quote expired'; end if;
  if p_amount is null or p_amount < 1 then raise exception 'Minimum Lightning withdrawal is $1'; end if;
  if p_amount_sat is null or p_amount_sat <= 0 then raise exception 'Quoted sats must be positive'; end if;
  if p_routing_fee_sat is null or p_routing_fee_sat < 0 then raise exception 'Routing fee must not be negative'; end if;
  if v_dest = '' then raise exception 'Destination is required'; end if;
  if length(v_dest) > 2000 then raise exception 'Destination is too long'; end if;
  if v_dest !~* '^ln(bc|tb|bcrt)[0-9a-z]+$' and not lightning_withdraw_destination_ok(p_user_id, v_dest) then
    raise exception 'Save this Lightning address in Profile first, or paste a Lightning invoice.';
  end if;
  if p_fee_percent is distinct from resolve_withdrawal_fee(p_user_id)
     or p_amount_after_fee is distinct from round(p_amount * (1 - p_fee_percent / 100), 2) then
    raise exception 'Withdrawal fee changed. Review the new quote.';
  end if;
  select * into v_limit from profile_limits where user_id = p_user_id;
  if v_limit.single_withdrawal_limit is not null and p_amount > v_limit.single_withdrawal_limit then
    raise exception 'This amount exceeds your single-withdrawal limit of $%', v_limit.single_withdrawal_limit;
  end if;
  select coalesce(sum(amount_requested), 0) into v_used from withdrawals
   where user_id = p_user_id and status in ('pending', 'approved', 'processing', 'sending', 'paid')
     and requested_at >= business_day_start(current_business_day());
  if v_limit.daily_withdrawal_limit is not null and v_used + p_amount > v_limit.daily_withdrawal_limit then
    raise exception 'This request exceeds your daily withdrawal limit of $%', v_limit.daily_withdrawal_limit;
  end if;
  select b.available into v_available from get_balance_for(p_user_id) b;
  if p_amount > v_available then raise exception 'Insufficient balance. Available: $%', round(v_available, 2); end if;
  insert into withdrawals(user_id, amount_requested, fee_percent, amount_after_fee, method, destination, status,
                          quote_id, coin, chain, amount_sat, quoted_fee, amount_out, quote_expires_at)
  values (p_user_id, p_amount, p_fee_percent, p_amount_after_fee, 'lightning', v_dest, 'sending',
          p_quote_id, 'BTC', 'lightning', p_amount_sat, 0, p_amount_sat, p_quote_expires_at)
  returning * into v_row;
  perform record_audit('withdrawal.lightning_reserved', 'withdrawal', v_row.id::text, null,
    jsonb_build_object('amount', p_amount, 'amount_sat', p_amount_sat, 'routing_fee_sat', p_routing_fee_sat));
  return v_row;
end;
$$;
revoke all on function public.reserve_lightning_withdrawal(uuid, text, numeric, numeric, numeric, text, bigint, bigint, timestamptz) from public, anon, authenticated;
grant execute on function public.reserve_lightning_withdrawal(uuid, text, numeric, numeric, numeric, text, bigint, bigint, timestamptz) to service_role;

-- Lightning rows finish through the same function as stablecoin rows.
create or replace function public.finalize_stablecoin_withdrawal(
  p_id uuid, p_outcome text, p_payout_ref text default null, p_amount_out numeric default null, p_note text default null
) returns text
language plpgsql security definer set search_path = public as $$
declare v_status text;
begin
  if p_outcome not in ('paid', 'failed') then raise exception 'Outcome must be paid or failed'; end if;
  update withdrawals
     set status = p_outcome,
         payout_ref = coalesce(p_payout_ref, payout_ref),
         amount_out = coalesce(p_amount_out, amount_out),
         admin_note = coalesce(p_note, admin_note),
         processed_at = now()
   where id = p_id and method in ('stablecoin', 'lightning') and quote_id is not null and status = 'sending';
  if found then return p_outcome; end if;
  select status into v_status from withdrawals where id = p_id;
  if not found then return 'unknown'; end if;
  return 'already_' || v_status;
end; $$;
revoke all on function public.finalize_stablecoin_withdrawal(uuid, text, text, numeric, text) from public, anon, authenticated;
grant execute on function public.finalize_stablecoin_withdrawal(uuid, text, text, numeric, text) to service_role;
