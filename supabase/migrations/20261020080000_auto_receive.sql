-- Saving an address is enough to get paid (instant forward).
--
-- Until now a freelancer had to save an address AND pick "Where to receive";
-- with no pick, a USDT address was ignored and, under the 'refuse' policy,
-- their links stopped taking payments. Now receive_target_for() decides:
--   1. an explicit, still usable pick in receive_settings wins;
--   2. otherwise the saved Lightning address;
--   3. otherwise a usable USDT address: the preferred network first, then
--      the most recently saved one.
-- Used by the enqueue trigger, the 'refuse' gate and my_receive_settings().
-- Address cooldowns (usable_after, ready_at) still apply. Re-appliable.

create or replace function public.receive_target_for(p_user uuid)
returns table(kind text, destination_id uuid, address text, network text)
language plpgsql stable security definer set search_path = public
as $$
declare s receive_settings; d record; w usdt_wallets; v_active boolean;
begin
  select (p.account_status = 'active') into v_active from profiles p where p.id = p_user;
  if not coalesce(v_active, false) then return; end if;
  select * into s from receive_settings r where r.user_id = p_user;
  select * into d from forward_destination_for(p_user);
  if s.method = 'usdt' then
    select * into w from usdt_wallets x where x.user_id = p_user and x.network = s.usdt_network and x.usable_after <= now();
    if w.id is not null then return query select 'usdt'::text, null::uuid, w.address, w.network; return; end if;
  end if;
  if d.id is not null then return query select 'lightning'::text, d.id, d.address, null::text; return; end if;
  select x.* into w from usdt_wallets x left join profiles p on p.id = x.user_id
   where x.user_id = p_user and x.usable_after <= now()
   order by (x.network = p.preferred_usdt_network) desc nulls last, x.updated_at desc limit 1;
  if w.id is not null then return query select 'usdt'::text, null::uuid, w.address, w.network; end if;
end;
$$;
revoke all on function public.receive_target_for(uuid) from public, anon, authenticated;
grant execute on function public.receive_target_for(uuid) to service_role;

create or replace function public.instant_forward_enqueue()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  t record; v_kind text := 'lightning'; v_dest uuid; v_addr text; v_net text;
  v_fee bigint; v_fwd bigint; v_status text := 'queued'; v_reason text;
  v_max jsonb := platform_setting('instant_forward_max_usd');
begin
  if payment_mode() <> 'instant_forward' then return new; end if;
  select * into t from receive_target_for(new.user_id);
  if t.kind is not null then v_kind := t.kind; v_dest := t.destination_id; v_addr := t.address; v_net := t.network; end if;
  if v_addr is null and coalesce(platform_setting('instant_forward_no_address') #>> '{}', 'balance') = 'balance' then
    return new;  -- stays in the CPAY balance, as before
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
  if payment_mode() = 'instant_forward'
     and platform_setting('instant_forward_no_address') = '"refuse"'::jsonb
     and not exists (select 1 from receive_target_for(new.user_id)) then
    raise exception 'This link is not taking payments right now.';
  end if;
  return new;
end;
$$;

-- What the desk shows: where the next payment goes.
create or replace function public.my_receive_settings()
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare v_uid uuid := auth.uid(); t record; ln record;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  select * into t from receive_target_for(v_uid);
  select d.address into ln from settlement_destinations d
   where d.user_id = v_uid and d.status = 'active' and d.ready_at <= now() order by d.created_at desc limit 1;
  return jsonb_build_object(
    'method', coalesce(t.kind, 'none'),
    'usdt_network', t.network,
    'usdt_address', case when t.kind = 'usdt' then t.address end,
    'lightning_address', ln.address,
    'target_address', t.address,
    'payment_mode', payment_mode());
end;
$$;
revoke all on function public.my_receive_settings() from public, anon;
grant execute on function public.my_receive_settings() to authenticated;
