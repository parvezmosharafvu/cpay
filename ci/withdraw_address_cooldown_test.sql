-- ============================================================
-- Payout address changes (20261009010000, replaced by 20261020040000)
-- ============================================================
-- A new or changed USDT address is usable at once, but only after a fresh
-- sign-in (payout_step_up_ok: first factor within 10 minutes, aal2 when the
-- account has an authenticator), whoever's token writes it (RPC or direct
-- table write). Every change is audited and the user gets an inbox notice.
-- withdraw_destination_status() stays service-only and matches EVM addresses
-- case-insensitively. BEGIN/ROLLBACK.
\set ON_ERROR_STOP on
begin;
create or replace function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.jwt() returns jsonb language sql stable
as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.jwt() to anon, authenticated, service_role;
insert into auth.users(id, email) values
  ('7c000000-0000-0000-0000-0000000000f1', 'cool-freelancer@test.invalid'),
  ('7c000000-0000-0000-0000-0000000000a1', 'cool-admin@test.invalid');
update profiles set account_status = 'active' where id in ('7c000000-0000-0000-0000-0000000000f1', '7c000000-0000-0000-0000-0000000000a1');
update profiles set role = 'admin' where id = '7c000000-0000-0000-0000-0000000000a1';
create function pg_temp.claims(p_age_secs int, p_aal text default 'aal1', p_method text default 'password') returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'aal', p_aal,
    'amr', jsonb_build_array(jsonb_build_object('method', p_method, 'timestamp', extract(epoch from now())::bigint - p_age_secs)))::text, true) $$;

grant select, insert, update, delete on public.usdt_wallets to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', '7c000000-0000-0000-0000-0000000000f1', true);

-- 1. A stale session (signed in an hour ago) cannot save or change an address.
select pg_temp.claims(3600);
do $$ begin
  perform set_my_usdt_wallet('tron', 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL');
  raise exception 'stale session saved an address';
exception when raise_exception then if sqlerrm not like 'reauth_required:%' then raise; end if; end $$;
do $$ begin
  insert into usdt_wallets(user_id, network, address) values ('7c000000-0000-0000-0000-0000000000f1', 'tron', 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL');
  raise exception 'stale session inserted an address';
exception when raise_exception then if sqlerrm not like 'reauth_required:%' then raise; end if; end $$;
-- An email-link session never counts.
select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'amr',
  jsonb_build_array(jsonb_build_object('method', 'recovery', 'timestamp', extract(epoch from now())::bigint)))::text, true);
do $$ begin
  perform set_my_usdt_wallet('tron', 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL');
  raise exception 'recovery-link session saved an address';
exception when raise_exception then if sqlerrm not like 'reauth_required:%' then raise; end if; end $$;

-- 2. Fresh password sign-in: refused (owner decision 2026-10-21, no 24-hour
--    wait any more). Fresh passkey sign-in: used at once; a client-supplied
--    usable_after is ignored.
select pg_temp.claims(30);
do $$ begin
  perform set_my_usdt_wallet('tron', 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL');
  raise exception 'password session saved an address';
exception when raise_exception then if sqlerrm not like 'Confirm with your passkey to change address%' then raise; end if; end $$;
select pg_temp.claims(30, 'aal1', 'passkey');
insert into usdt_wallets(user_id, network, address, usable_after)
values ('7c000000-0000-0000-0000-0000000000f1', 'tron', 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL', now() + interval '30 days');
do $$ begin
  if (select usable_after from usdt_wallets where network = 'tron') > now() then
    raise exception 'client-supplied usable_after accepted, or a passkey change waits'; end if;
end $$;
select set_my_usdt_wallet('ethereum', '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063');
do $$ begin
  if (select count(*) from my_usdt_wallet_status() where ready) <> 2 then raise exception 'addresses not ready at once with a passkey'; end if;
end $$;
reset role;
do $$ begin
  if (select count(*) from support_messages where user_id = '7c000000-0000-0000-0000-0000000000f1' and message like '%Payments are sent there from now on.%') <> 2 then
    raise exception 'notice does not say the address is used now'; end if;
end $$;
set local role authenticated;
do $$ begin
  perform withdraw_destination_status('7c000000-0000-0000-0000-0000000000f1', 'x');
  raise exception 'authenticated could execute withdraw_destination_status';
exception when insufficient_privilege then null;
end $$;

-- 3. An account with an authenticator needs aal2 as well.
reset role;
insert into auth.mfa_factors(user_id, status) values ('7c000000-0000-0000-0000-0000000000f1', 'verified');
set local role authenticated;
select pg_temp.claims(30);
do $$ begin
  update usdt_wallets set address = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8' where network = 'tron';
  raise exception 'aal1 changed an address on an MFA account';
exception when raise_exception then if sqlerrm not like 'reauth_required:%' then raise; end if; end $$;
select pg_temp.claims(30, 'aal2');
update usdt_wallets set address = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8' where network = 'tron';
-- A no-op update needs no sign-in and changes nothing.
select pg_temp.claims(3600, 'aal1');
update usdt_wallets set address = address where network = 'tron';
reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare s jsonb; u uuid := '7c000000-0000-0000-0000-0000000000f1';
begin
  s := withdraw_destination_status(u, 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8');
  if not (s->>'ok')::boolean then raise exception 'changed address not usable at once: %', s; end if;
  if withdraw_destination_status(u, 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL')->>'reason' <> 'not_saved' then raise exception 'replaced address still accepted'; end if;
  s := withdraw_destination_status(u, lower('0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063'));
  if not (s->>'ok')::boolean then raise exception 'EVM case-insensitive match failed: %', s; end if;
  if (select count(*) from audit_log where action = 'payout_wallet.saved' and subject_id = u::text) <> 3 then
    raise exception 'address saves not audited once each';
  end if;
  if (select count(*) from support_messages where user_id = u and sender = 'admin' and message like 'Security notice: your USDT payout address%') <> 3 then
    raise exception 'user not notified of each change';
  end if;
end $$;

-- 4. An admin setting a user's address (service path, admin token checked by
--    its own function): usable at once, audited, user told.
select set_config('request.jwt.claim.sub', '7c000000-0000-0000-0000-0000000000a1', true);
select admin_set_user_usdt_wallet('7c000000-0000-0000-0000-0000000000f1', 'solana', '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV');
do $$ begin
  if not (withdraw_destination_status('7c000000-0000-0000-0000-0000000000f1', '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV')->>'ok')::boolean then
    raise exception 'admin-set address not usable';
  end if;
end $$;
do $$ begin
  if has_function_privilege('anon', 'public.my_usdt_wallet_status()', 'execute') then raise exception 'anon can read wallet status'; end if;
  if has_function_privilege('anon', 'public.withdraw_destination_status(uuid, text)', 'execute') then raise exception 'anon can run the destination check'; end if;
  if has_function_privilege('authenticated', 'public.payout_step_up_ok(integer)', 'execute') then raise exception 'step-up check exposed'; end if;
  if has_function_privilege('authenticated', 'public.notify_payout_address_changed(uuid, text, timestamptz)', 'execute') then raise exception 'notify exposed'; end if;
  if has_function_privilege('authenticated', 'public.payout_ready_at(uuid)', 'execute') then raise exception 'payout_ready_at exposed'; end if;
end $$;
\echo 'payout address changes: PASS'
rollback;
