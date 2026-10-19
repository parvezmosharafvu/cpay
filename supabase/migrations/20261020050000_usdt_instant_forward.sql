-- Instant forward to USDT (docs/INSTANT-FORWARD.md §10). A user chooses where
-- to receive: Lightning (the saved Lightning address) or USDT (one of their
-- saved USDT payout addresses, by network). In payment mode 'instant_forward'
-- each settled payment's forward row (fee already deducted) is marked
-- kind = 'usdt' for a USDT user. USDT forwards are sent in batches by the
-- wallet function:
--   - rows wait as 'queued' (reason 'accumulating') until their total reaches
--     the route's minimum, then one send carries them all (forward_batches);
--   - one open batch per user and network (partial unique index); a row is in
--     at most one open batch; the batch id is the send's idempotency key;
--   - the quote is made right before the send, so it cannot expire unseen; a
--     failed or expired quote retries the rows with backoff, then holds them
--     ('owed') for the admin, as for Lightning.
-- Changing the receive choice is a payout change: fresh sign-in, audit and an
-- inbox notice (payout_step_up_ok, 20261020040000). Re-appliable.

-- 1. Where to receive --------------------------------------------------------
create table if not exists public.receive_settings (
  user_id      uuid primary key references public.profiles(id) on delete cascade,
  method       text not null default 'lightning' check (method in ('lightning', 'usdt')),
  usdt_network text check (usdt_network is null or usdt_network in ('tron','bsc','ethereum','polygon','arbitrum','base','optimism','avalanche','solana')),
  updated_at   timestamptz not null default now(),
  constraint receive_settings_usdt check (method <> 'usdt' or usdt_network is not null)
);
alter table public.receive_settings enable row level security;
revoke all on public.receive_settings from public, anon, authenticated;
grant select on public.receive_settings to authenticated;
drop policy if exists receive_settings_own on public.receive_settings;
create policy receive_settings_own on public.receive_settings for select to authenticated using (user_id = auth.uid() or is_admin());

create or replace function public.set_my_receive_method(p_method text, p_network text default null)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_uid uuid := auth.uid(); v_old receive_settings; v_addr text;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_method not in ('lightning', 'usdt') then raise exception 'Choose Lightning or USDT'; end if;
  if p_method = 'usdt' then
    select address into v_addr from usdt_wallets where user_id = v_uid and network = p_network;
    if v_addr is null then raise exception 'Save a USDT address for that network first'; end if;
  else
    p_network := null;
  end if;
  select * into v_old from receive_settings where user_id = v_uid;
  if coalesce(v_old.method, 'lightning') = p_method and v_old.usdt_network is not distinct from p_network then
    return my_receive_settings();
  end if;
  if not payout_step_up_ok() then
    raise exception 'reauth_required: For your security, enter your password again to change where payments are sent.';
  end if;
  insert into receive_settings (user_id, method, usdt_network, updated_at) values (v_uid, p_method, p_network, now())
  on conflict (user_id) do update set method = excluded.method, usdt_network = excluded.usdt_network, updated_at = now();
  perform record_audit('payout.receive_method', 'profile', v_uid::text,
    jsonb_build_object('method', coalesce(v_old.method, 'lightning'), 'usdt_network', v_old.usdt_network),
    jsonb_build_object('method', p_method, 'usdt_network', p_network));
  perform notify_payout_address_changed(v_uid, case when p_method = 'usdt'
    then 'your payments are now sent as USDT on ' || p_network || ' to ' || v_addr
    else 'your payments are now sent to your Lightning address' end);
  return my_receive_settings();
end;
$$;

create or replace function public.my_receive_settings()
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare v_uid uuid := auth.uid(); s receive_settings; ln record;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  select * into s from receive_settings where user_id = v_uid;
  select d.address into ln from settlement_destinations d
   where d.user_id = v_uid and d.status = 'active' and d.ready_at <= now() order by d.created_at desc limit 1;
  return jsonb_build_object(
    'method', coalesce(s.method, 'lightning'),
    'usdt_network', s.usdt_network,
    'usdt_address', (select address from usdt_wallets where user_id = v_uid and network = s.usdt_network),
    'lightning_address', ln.address,
    'payment_mode', payment_mode());
end;
$$;
revoke all on function public.set_my_receive_method(text, text) from public, anon;
revoke all on function public.my_receive_settings() from public, anon;
grant execute on function public.set_my_receive_method(text, text) to authenticated;
grant execute on function public.my_receive_settings() to authenticated;

-- 2. Forward rows know their kind; batches ----------------------------------
alter table public.payment_forwards add column if not exists kind text not null default 'lightning';
alter table public.payment_forwards add column if not exists network text;
alter table public.payment_forwards drop constraint if exists payment_forwards_kind;
alter table public.payment_forwards add constraint payment_forwards_kind check (kind in ('lightning', 'usdt') and (kind = 'lightning' or network is not null));

create table if not exists public.forward_batches (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id),
  network         text not null,
  address         text not null,
  route_id        text not null,
  amount_sat      bigint not null check (amount_sat > 0),
  amount_usd      numeric(18,8) not null,
  status          text not null default 'sending' check (status in ('sending','forwarded','failed','held')),
  payment_ref     text,
  receive         text,
  network_fee_usd numeric(18,8),
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  finished_at     timestamptz
);
create unique index if not exists forward_batches_one_open on public.forward_batches (user_id, network) where status = 'sending';
alter table public.forward_batches enable row level security;
revoke all on public.forward_batches from public, anon, authenticated;
grant select on public.forward_batches to authenticated;
drop policy if exists forward_batches_own on public.forward_batches;
create policy forward_batches_own on public.forward_batches for select to authenticated using (user_id = auth.uid() or is_admin());
alter table public.payment_forwards add column if not exists batch_id uuid references public.forward_batches(id);

-- 3. Enqueue: Lightning or USDT ---------------------------------------------
create or replace function public.instant_forward_enqueue()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  d record; s receive_settings; w usdt_wallets;
  v_kind text := 'lightning'; v_dest uuid; v_addr text; v_net text;
  v_fee bigint; v_fwd bigint; v_status text := 'queued'; v_reason text;
  v_max jsonb := platform_setting('instant_forward_max_usd');
begin
  if payment_mode() <> 'instant_forward' then return new; end if;
  select * into s from receive_settings where user_id = new.user_id;
  if s.method = 'usdt' then
    select * into w from usdt_wallets x where x.user_id = new.user_id and x.network = s.usdt_network and x.usable_after <= now()
       and exists (select 1 from profiles p where p.id = new.user_id and p.account_status = 'active');
    if w.id is not null then v_kind := 'usdt'; v_addr := w.address; v_net := w.network; end if;
  else
    select * into d from forward_destination_for(new.user_id);
    if d.id is not null then v_dest := d.id; v_addr := d.address; end if;
  end if;
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
  if v_kind = 'usdt' and v_status = 'owed' and v_reason = 'no_address' then v_kind := 'lightning'; end if;
  insert into payment_forwards (payment_id, user_id, destination_id, address, kind, network, gross_sat, fee_sat, forward_sat,
                                fee_usd, amount_usd, status, reason, next_attempt_at)
  values (new.id, new.user_id, v_dest, v_addr, v_kind, v_net, greatest(coalesce(new.amount_sat, 0), 0), v_fee, v_fwd,
          coalesce(new.platform_fee_amount, 0), coalesce(new.amount_settled, 0) - coalesce(new.platform_fee_amount, 0),
          v_status, v_reason, case when v_status = 'queued' then now() end)
  on conflict (payment_id) do nothing;
  return new;
end;
$$;

-- 4. Lightning worker functions only take Lightning rows ---------------------
create or replace function public.system_forward_claim(p_limit integer default 10)
returns setof public.payment_forwards language plpgsql security definer set search_path = public
as $$
begin
  if payment_mode() <> 'instant_forward' then return; end if;
  return query
  update payment_forwards f set status = 'sending', attempts = f.attempts + 1, last_error = null
   where f.id in (select x.id from payment_forwards x
                   where x.kind = 'lightning'
                     and (x.status = 'queued' or (x.status = 'retry' and x.next_attempt_at <= now()))
                   order by x.created_at limit greatest(1, least(coalesce(p_limit, 10), 50))
                   for update skip locked)
  returning f.*;
end;
$$;
create or replace function public.system_forward_stuck(p_secs integer default 120)
returns setof public.payment_forwards language sql stable security definer set search_path = public
as $$ select * from payment_forwards where status = 'sending' and kind = 'lightning'
         and updated_at < now() - make_interval(secs => greatest(p_secs, 0)) order by created_at limit 50 $$;

-- 5. USDT batches (service_role) ---------------------------------------------
-- Groups ready to look at: due USDT rows per user and network, with the
-- user's current address for that network; none while a batch is open.
create or replace function public.system_usdt_due()
returns table(user_id uuid, network text, address text, total_usd numeric, total_sat bigint, n integer, oldest timestamptz)
language sql stable security definer set search_path = public
as $$
  select f.user_id, f.network, w.address, sum(f.amount_usd), sum(f.forward_sat)::bigint, count(*)::int, min(f.created_at)
    from payment_forwards f
    join usdt_wallets w on w.user_id = f.user_id and w.network = f.network and w.usable_after <= now()
   where payment_mode() = 'instant_forward' and f.kind = 'usdt'
     and (f.status = 'queued' or (f.status = 'retry' and f.next_attempt_at <= now()))
     and not exists (select 1 from forward_batches b where b.user_id = f.user_id and b.network = f.network and b.status = 'sending')
   group by f.user_id, f.network, w.address
   order by min(f.created_at)
   limit 50
$$;

create or replace function public.system_usdt_mark_accumulating(p_user uuid, p_network text)
returns integer language plpgsql security definer set search_path = public
as $$
declare n integer;
begin
  update payment_forwards set reason = 'accumulating'
   where user_id = p_user and network = p_network and kind = 'usdt' and status in ('queued', 'retry')
     and reason is distinct from 'accumulating';
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.system_usdt_batch_create(p_user uuid, p_network text, p_route_id text)
returns setof public.forward_batches language plpgsql security definer set search_path = public
as $$
declare w usdt_wallets; b forward_batches; v_ids uuid[]; v_sat bigint; v_usd numeric;
begin
  if payment_mode() <> 'instant_forward' then return; end if;
  select * into w from usdt_wallets x where x.user_id = p_user and x.network = p_network and x.usable_after <= now();
  if w.id is null then return; end if;
  select array_agg(id), sum(forward_sat), sum(amount_usd) into v_ids, v_sat, v_usd from (
    select f.id, f.forward_sat, f.amount_usd from payment_forwards f
     where f.user_id = p_user and f.network = p_network and f.kind = 'usdt'
       and (f.status = 'queued' or (f.status = 'retry' and f.next_attempt_at <= now()))
     for update skip locked) x;
  if v_ids is null or coalesce(v_sat, 0) <= 0 then return; end if;
  begin
    insert into forward_batches (user_id, network, address, route_id, amount_sat, amount_usd)
    values (p_user, p_network, w.address, p_route_id, v_sat, v_usd) returning * into b;
  exception when unique_violation then return;  -- another batch is open
  end;
  update payment_forwards set status = 'sending', attempts = attempts + 1, batch_id = b.id, address = w.address,
         reason = null, last_error = null
   where id = any(v_ids);
  return next b;
end;
$$;

create or replace function public.system_usdt_batch_finish(p_id uuid, p_outcome text, p_payment_ref text default null,
  p_receive text default null, p_network_fee_usd numeric default null, p_error text default null)
returns text language plpgsql security definer set search_path = public
as $$
declare b forward_batches; f record; v_max int := coalesce((platform_setting('instant_forward_max_attempts') #>> '{}')::int, 6);
begin
  select * into b from forward_batches where id = p_id for update;
  if not found then raise exception 'Batch not found'; end if;
  if b.status <> 'sending' then return b.status; end if;   -- idempotent
  if p_outcome = 'forwarded' then
    if p_payment_ref is null then raise exception 'A sent batch needs its payment id'; end if;
    update forward_batches set status = 'forwarded', payment_ref = p_payment_ref, receive = p_receive,
           network_fee_usd = p_network_fee_usd, finished_at = now(), updated_at = now(), last_error = null where id = p_id;
    update payment_forwards set status = 'forwarded', sent_sat = forward_sat, routing_fee_sat = 0, remainder_sat = 0,
           payment_ref = p_payment_ref, forwarded_at = now(), next_attempt_at = null
     where batch_id = p_id and status = 'sending';
    return 'forwarded';
  elsif p_outcome = 'retry' then
    update forward_batches set status = 'failed', last_error = left(p_error, 500), finished_at = now(), updated_at = now() where id = p_id;
    for f in select id, attempts from payment_forwards where batch_id = p_id and status = 'sending' for update loop
      if f.attempts >= v_max then
        update payment_forwards set status = 'owed', reason = 'failed', last_error = left(p_error, 500), next_attempt_at = null where id = f.id;
      else
        update payment_forwards set status = 'retry', last_error = left(p_error, 500),
               next_attempt_at = now() + make_interval(secs => least(3600, 60 * power(2, greatest(f.attempts - 1, 0))::int))
         where id = f.id;
      end if;
    end loop;
    return 'retry';
  elsif p_outcome = 'held' then
    update forward_batches set status = 'held', payment_ref = p_payment_ref, last_error = left(p_error, 500), finished_at = now(), updated_at = now() where id = p_id;
    update payment_forwards set status = 'owed', reason = coalesce(left(p_error, 100), 'held'), last_error = left(p_error, 500), next_attempt_at = null
     where batch_id = p_id and status = 'sending';
    return 'held';
  end if;
  raise exception 'Unknown outcome';
end;
$$;

create or replace function public.system_usdt_batches_open(p_secs integer default 120)
returns setof public.forward_batches language sql stable security definer set search_path = public
as $$ select * from forward_batches where status = 'sending'
         and updated_at < now() - make_interval(secs => greatest(p_secs, 0)) order by created_at limit 50 $$;

do $$ declare f text; begin
  foreach f in array array['system_usdt_due()', 'system_usdt_mark_accumulating(uuid, text)', 'system_usdt_batch_create(uuid, text, text)',
    'system_usdt_batch_finish(uuid, text, text, text, numeric, text)', 'system_usdt_batches_open(integer)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- 6. Admin -------------------------------------------------------------------
create or replace function public.admin_list_forwards(p_status text default null, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  return jsonb_build_object(
    'mode', payment_mode(),
    'counts', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) n from payment_forwards group by status) c),
    'accumulating', (select count(*) from payment_forwards where kind = 'usdt' and status in ('queued','retry') and reason = 'accumulating'),
    'totals', instant_forward_invariants(),
    'rows', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc) from (
        select f.id, f.payment_id, f.user_id, p.email as user_email, f.kind, f.network, f.address, f.gross_sat, f.fee_sat, f.forward_sat,
               f.sent_sat, f.routing_fee_sat, f.amount_usd, f.status, f.reason, f.attempts, f.next_attempt_at,
               f.last_error, f.created_at, f.forwarded_at, b.receive as usdt_received, b.network_fee_usd
          from payment_forwards f left join profiles p on p.id = f.user_id left join forward_batches b on b.id = f.batch_id
         where p_status is null or f.status = p_status
         order by f.created_at desc limit greatest(1, least(coalesce(p_limit, 100), 500))) x), '[]'::jsonb));
end;
$$;

create or replace function public.admin_forward_action(p_id uuid, p_action text)
returns text language plpgsql security definer set search_path = public
as $$
declare f payment_forwards; d record; w usdt_wallets;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'Enter your authenticator code first (sign in again with two-step sign-in)';
  end if;
  select * into f from payment_forwards where id = p_id for update;
  if not found then raise exception 'Forward not found'; end if;
  if f.status <> 'owed' then raise exception 'Only a held forward can be changed'; end if;
  if p_action = 'retry' then
    if f.kind = 'usdt' then
      select * into w from usdt_wallets where user_id = f.user_id and network = f.network;
      if w.id is null then raise exception 'This user has no USDT address for that network'; end if;
      update payment_forwards set status = 'queued', attempts = 0, reason = null, last_error = null,
             address = w.address, next_attempt_at = now() where id = p_id;
    else
      select * into d from forward_destination_for(f.user_id);
      if d.id is null then raise exception 'This user has no Lightning address in use'; end if;
      update payment_forwards set status = 'queued', attempts = 0, reason = null, last_error = null,
             destination_id = d.id, address = d.address, next_attempt_at = now() where id = p_id;
    end if;
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

-- 7. Alert: USDT forwards accumulating for more than 3 days ------------------
do $do$
declare src text := pg_get_functiondef('public.admin_system_alerts()'::regprocedure);
begin
  if src like '%forward_accumulating%' then return; end if;
  if src not like '%return jsonb_build_object(''checked_at''%' then raise exception 'admin_system_alerts: patch point not found'; end if;
  execute replace(src, ' return jsonb_build_object(''checked_at''',
    ' if exists (select 1 from payment_forwards where kind = ''usdt'' and status in (''queued'',''retry'') and reason = ''accumulating'' and created_at < now() - interval ''3 days'') then a:=a||jsonb_build_array(jsonb_build_object(''code'',''forward_accumulating'',''severity'',''info'',''title'',''USDT forwards are below the minimum'',''detail'',''Some users have USDT payments waiting for more than 3 days to reach the network minimum.'')); end if;
 return jsonb_build_object(''checked_at''');
end $do$;
