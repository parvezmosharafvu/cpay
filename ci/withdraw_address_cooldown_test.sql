-- ============================================================
-- 20261009010000: payout address cooldown
-- ============================================================
-- A new or changed USDT address is usable only 24 h later, whoever saves it
-- (RPC, direct PostgREST insert/update, admin); a client cannot set or
-- backdate usable_after; withdraw_destination_status() is service-only and
-- matches EVM addresses case-insensitively; changes are audited.
-- BEGIN/ROLLBACK.
\set ON_ERROR_STOP on
begin;
create or replace function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
insert into auth.users(id, email) values
  ('7c000000-0000-0000-0000-0000000000f1', 'cool-freelancer@test.invalid'),
  ('7c000000-0000-0000-0000-0000000000a1', 'cool-admin@test.invalid');
update profiles set account_status = 'active' where id in ('7c000000-0000-0000-0000-0000000000f1', '7c000000-0000-0000-0000-0000000000a1');
update profiles set role = 'admin' where id = '7c000000-0000-0000-0000-0000000000a1';

-- As the freelancer, through PostgREST-style direct table access and the RPC.
set local role authenticated;
select set_config('request.jwt.claim.sub', '7c000000-0000-0000-0000-0000000000f1', true);
insert into usdt_wallets(user_id, network, address, usable_after)
values ('7c000000-0000-0000-0000-0000000000f1', 'tron', 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL', now() - interval '30 days');
do $$ begin
  if (select usable_after from usdt_wallets where network = 'tron') < now() + interval '23 hours' then
    raise exception 'client-supplied usable_after was accepted on insert';
  end if;
end $$;
update usdt_wallets set usable_after = now() - interval '30 days' where network = 'tron';
do $$ begin
  if (select usable_after from usdt_wallets where network = 'tron') < now() + interval '23 hours' then
    raise exception 'client could backdate usable_after on update';
  end if;
end $$;
select set_my_usdt_wallet('ethereum', '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063');
do $$ begin
  if (select count(*) from my_usdt_wallet_status() where not ready) <> 2 then
    raise exception 'my_usdt_wallet_status should show two cooling addresses';
  end if;
end $$;
-- The browser cannot ask the service-side check.
do $$ begin
  perform withdraw_destination_status('7c000000-0000-0000-0000-0000000000f1', 'x');
  raise exception 'authenticated could execute withdraw_destination_status';
exception when insufficient_privilege then null;
end $$;
reset role;

do $$
declare s jsonb; u uuid := '7c000000-0000-0000-0000-0000000000f1';
begin
  s := withdraw_destination_status(u, 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL');
  if s->>'reason' <> 'cooling_down' or (s->>'ok')::boolean then raise exception 'new address not cooling: %', s; end if;
  s := withdraw_destination_status(u, 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8');
  if s->>'reason' <> 'not_saved' then raise exception 'unsaved address: %', s; end if;
  -- 25 hours later (simulated by moving the clock of the row with triggers off).
  set local session_replication_role = replica;
  update usdt_wallets set usable_after = now() - interval '1 hour' where user_id = u;
  set local session_replication_role = origin;
  s := withdraw_destination_status(u, 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL');
  if not (s->>'ok')::boolean then raise exception 'aged address not ready: %', s; end if;
  s := withdraw_destination_status(u, lower('0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063'));
  if not (s->>'ok')::boolean then raise exception 'EVM case-insensitive match failed: %', s; end if;
  -- Same address saved again: no new wait. Changed address: new wait.
  update usdt_wallets set address = address where user_id = u and network = 'tron';
  if not (withdraw_destination_status(u, 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL')->>'ok')::boolean then raise exception 'no-op update restarted the wait'; end if;
  update usdt_wallets set address = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8' where user_id = u and network = 'tron';
  if withdraw_destination_status(u, 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8')->>'reason' <> 'cooling_down' then raise exception 'changed address not cooling'; end if;
  if withdraw_destination_status(u, 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL')->>'reason' <> 'not_saved' then raise exception 'replaced address still accepted'; end if;
  if (select count(*) from audit_log where action = 'payout_wallet.saved' and subject_id = u::text) < 3 then
    raise exception 'address saves not audited';
  end if;
end $$;

-- An admin setting a user's address also starts the wait.
select set_config('request.jwt.claim.sub', '7c000000-0000-0000-0000-0000000000a1', true);
select admin_set_user_usdt_wallet('7c000000-0000-0000-0000-0000000000f1', 'solana', '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV');
do $$ begin
  if withdraw_destination_status('7c000000-0000-0000-0000-0000000000f1', '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV')->>'reason' <> 'cooling_down' then
    raise exception 'admin-set address skipped the wait';
  end if;
end $$;
do $$ begin
  if has_function_privilege('anon', 'public.my_usdt_wallet_status()', 'execute') then raise exception 'anon can read wallet status'; end if;
  if has_function_privilege('anon', 'public.withdraw_destination_status(uuid, text)', 'execute') then raise exception 'anon can run the destination check'; end if;
end $$;
\echo 'withdraw address cooldown: PASS'
rollback;
