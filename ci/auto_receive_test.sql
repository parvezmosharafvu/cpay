-- 20261020080000: saving an address is enough to get paid. No pick in
-- receive_settings: USDT only -> USDT forward and 'refuse' lets the payment
-- in; USDT and Lightning -> Lightning; an explicit USDT pick still wins;
-- nothing saved -> refused. BEGIN/ROLLBACK.
\set ON_ERROR_STOP on
begin;
insert into auth.users(id, email) values
  ('f8000000-0000-0000-0000-0000000000a1', 'ar-usdt@test.invalid'),
  ('f8000000-0000-0000-0000-0000000000a2', 'ar-none@test.invalid');
update profiles set account_status = 'active', platform_fee_percent = 0 where id::text like 'f8000000-%';
insert into payment_links(id, user_id, slug) values
  ('f8000000-0000-0000-0000-0000000001a1', 'f8000000-0000-0000-0000-0000000000a1', 'ar-link-usdt'),
  ('f8000000-0000-0000-0000-0000000001a2', 'f8000000-0000-0000-0000-0000000000a2', 'ar-link-none');
insert into platform_settings(key, value) values ('payment_mode', '"instant_forward"'), ('instant_forward_no_address', '"refuse"')
  on conflict (key) do update set value = excluded.value;

create function pg_temp.pay(p_id text, p_user text, p_link text) returns void language plpgsql as $$
begin
  insert into payments(id, user_id, payment_link_id, amount_requested, method, status, expires_at, invoice_ref)
  values (p_id::uuid, p_user::uuid, p_link::uuid, 20, 'lightning', 'new', now() + interval '15 min', 'ar-' || p_id);
  update payments set status = 'settled', amount_settled = 20, amount_sat = 20000, settled_at = now() where id = p_id::uuid;
end $$;
create function pg_temp.fwd(p_id text) returns text language sql as $$
  select kind || '/' || coalesce(network, '-') || '/' || status from payment_forwards where payment_id = p_id::uuid $$;

-- 1. Nothing saved: refused.
do $$ begin
  perform pg_temp.pay('f8000000-0000-0000-0000-0000000002a0', 'f8000000-0000-0000-0000-0000000000a2', 'f8000000-0000-0000-0000-0000000001a2');
  raise exception 'payment accepted with no address';
exception when raise_exception then if sqlerrm not like 'This link is not taking payments%' then raise; end if; end $$;

-- 2. Only a USDT address, no pick: accepted and forwarded as USDT. With two,
--    the preferred network wins.
insert into usdt_wallets(user_id, network, address) values
  ('f8000000-0000-0000-0000-0000000000a1', 'tron', 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL'),
  ('f8000000-0000-0000-0000-0000000000a1', 'bsc', '0x1111111111111111111111111111111111111111');
update profiles set preferred_usdt_network = 'tron' where id = 'f8000000-0000-0000-0000-0000000000a1';
select pg_temp.pay('f8000000-0000-0000-0000-0000000002a1', 'f8000000-0000-0000-0000-0000000000a1', 'f8000000-0000-0000-0000-0000000001a1');
do $$ begin
  if pg_temp.fwd('f8000000-0000-0000-0000-0000000002a1') <> 'usdt/tron/queued' then
    raise exception 'USDT-only: %', pg_temp.fwd('f8000000-0000-0000-0000-0000000002a1'); end if;
end $$;

-- 3. A USDT address still waiting (cooldown) does not count.
alter table usdt_wallets disable trigger user;
update usdt_wallets set usable_after = now() + interval '1 day' where user_id = 'f8000000-0000-0000-0000-0000000000a1';
do $$ begin
  if exists (select 1 from receive_target_for('f8000000-0000-0000-0000-0000000000a1')) then raise exception 'waiting address used'; end if;
end $$;
update usdt_wallets set usable_after = now() where user_id = 'f8000000-0000-0000-0000-0000000000a1';
alter table usdt_wallets enable trigger user;

-- 4. Lightning saved too, no pick: Lightning.
select system_set_settlement_destination('f8000000-0000-0000-0000-0000000000a1', 'me@pay.example.com', 'pay.example.com', 1000, 100000000);
alter table settlement_destinations disable trigger trg_guard_settlement_destination_changes;
update settlement_destinations set ready_at = now() where user_id = 'f8000000-0000-0000-0000-0000000000a1';
alter table settlement_destinations enable trigger trg_guard_settlement_destination_changes;
select pg_temp.pay('f8000000-0000-0000-0000-0000000002a2', 'f8000000-0000-0000-0000-0000000000a1', 'f8000000-0000-0000-0000-0000000001a1');
do $$ begin
  if pg_temp.fwd('f8000000-0000-0000-0000-0000000002a2') <> 'lightning/-/queued' then
    raise exception 'both saved: %', pg_temp.fwd('f8000000-0000-0000-0000-0000000002a2'); end if;
end $$;

-- 5. An explicit USDT pick still wins over Lightning.
insert into receive_settings(user_id, method, usdt_network) values ('f8000000-0000-0000-0000-0000000000a1', 'usdt', 'bsc');
select pg_temp.pay('f8000000-0000-0000-0000-0000000002a3', 'f8000000-0000-0000-0000-0000000000a1', 'f8000000-0000-0000-0000-0000000001a1');
do $$ begin
  if pg_temp.fwd('f8000000-0000-0000-0000-0000000002a3') <> 'usdt/bsc/queued' then
    raise exception 'explicit pick: %', pg_temp.fwd('f8000000-0000-0000-0000-0000000002a3'); end if;
end $$;

-- 6. A suspended account gets no target; receive_target_for is service-only.
update profiles set account_status = 'suspended' where id = 'f8000000-0000-0000-0000-0000000000a1';
do $$ begin
  if exists (select 1 from receive_target_for('f8000000-0000-0000-0000-0000000000a1')) then raise exception 'suspended account has a target'; end if;
  if has_function_privilege('authenticated', 'public.receive_target_for(uuid)', 'execute') then raise exception 'authenticated can call receive_target_for'; end if;
end $$;
rollback;
\echo auto_receive_test: ok
