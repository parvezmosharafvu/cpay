-- 20261020060000 / 20261021020000: forward and payout-address safety. A
-- payout address (USDT or Lightning) changes only in a passkey session and
-- is used at once; without one it is refused; the security
-- notice cannot be hidden by the account; admin hold of waiting forwards;
-- admin close of a stuck USDT batch; quote expiry is service-only; batches
-- only for active accounts; 'refuse' accepts a USDT receive choice.
-- BEGIN/ROLLBACK.
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
  ('f6000000-0000-0000-0000-0000000000a1', 'fs-nomfa@test.invalid'),
  ('f6000000-0000-0000-0000-0000000000a2', 'fs-mfa@test.invalid'),
  ('f6000000-0000-0000-0000-0000000000a3', 'fs-usdt@test.invalid'),
  ('f6000000-0000-0000-0000-0000000000ad', 'fs-admin@test.invalid');
update profiles set account_status = 'active', platform_fee_percent = 0 where id::text like 'f6000000-%';
update profiles set role = 'admin' where id = 'f6000000-0000-0000-0000-0000000000ad';
insert into auth.mfa_factors(id, user_id, friendly_name, factor_type, status) values
  (gen_random_uuid(), 'f6000000-0000-0000-0000-0000000000a2', 'test', 'totp', 'verified'),
  (gen_random_uuid(), 'f6000000-0000-0000-0000-0000000000a3', 'test', 'totp', 'verified'),
  -- An unverified factor does not count.
  (gen_random_uuid(), 'f6000000-0000-0000-0000-0000000000a1', 'pending', 'totp', 'unverified');
insert into payment_links(id, user_id, slug) values
  ('f6000000-0000-0000-0000-0000000001a2', 'f6000000-0000-0000-0000-0000000000a2', 'fs-link-mfa'),
  ('f6000000-0000-0000-0000-0000000001a3', 'f6000000-0000-0000-0000-0000000000a3', 'fs-link-usdt');
insert into platform_settings(key, value) values ('payment_mode', '"instant_forward"');

create function pg_temp.pay(p_id text, p_user text, p_link text, p_usd numeric, p_sat bigint) returns void language plpgsql as $$
begin
  insert into payments(id, user_id, payment_link_id, amount_requested, method, status, expires_at, invoice_ref)
  values (p_id::uuid, p_user::uuid, p_link::uuid, p_usd, 'lightning', 'new', now() + interval '15 min', 'fs-' || p_id);
  update payments set status = 'settled', amount_settled = p_usd, amount_sat = p_sat, settled_at = now() where id = p_id::uuid;
end $$;

-- 1. Payout address changes (owner decision 2026-10-21, 20261021020000):
--    a signed-in account needs a passkey session of its own and the address
--    is used at once; without one the change is refused (no 24-hour wait).
--    Service-role callers (Edge Functions that check the passkey) get now().
do $$ begin
  perform set_config('request.jwt.claim.sub', 'f6000000-0000-0000-0000-0000000000a1', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'aal', 'aal1',
    'amr', jsonb_build_array(jsonb_build_object('method', 'password', 'timestamp', extract(epoch from now())::bigint)))::text, true);
  begin
    perform payout_ready_at('f6000000-0000-0000-0000-0000000000a1');
    raise exception 'password session allowed an address change';
  exception when raise_exception then if sqlerrm <> 'Confirm with your passkey to change address' then raise; end if; end;
  -- An old authenticator alone no longer counts.
  perform set_config('request.jwt.claim.sub', 'f6000000-0000-0000-0000-0000000000a2', true);
  begin
    perform payout_ready_at('f6000000-0000-0000-0000-0000000000a2');
    raise exception 'old authenticator allowed an address change without a passkey';
  exception when raise_exception then if sqlerrm <> 'Confirm with your passkey to change address' then raise; end if; end;
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'aal', 'aal1',
    'amr', jsonb_build_array(jsonb_build_object('method', 'passkey', 'timestamp', extract(epoch from now())::bigint)))::text, true);
  if payout_ready_at('f6000000-0000-0000-0000-0000000000a2') > now() then raise exception 'passkey change waits'; end if;
  begin
    perform payout_ready_at('f6000000-0000-0000-0000-0000000000a1');
    raise exception 'a passkey session changed another account''s address';
  exception when raise_exception then if sqlerrm <> 'Confirm with your passkey to change address' then raise; end if; end;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  if payout_ready_at('f6000000-0000-0000-0000-0000000000a1') > now() then raise exception 'service path waits'; end if;
  if has_function_privilege('authenticated', 'public.payout_ready_at(uuid)', 'execute')
     or has_function_privilege('anon', 'public.payout_ready_at(uuid)', 'execute') then raise exception 'payout_ready_at exposed'; end if;
  if exists (select 1 from pg_proc where proname = 'notify_payout_address_changed' and pronargs = 2) then
    raise exception 'old two-argument notifier still there'; end if;
end $$;

-- 2. USDT, saved by the account after a fresh sign-in: refused without a
--    passkey session; with one, used at once and the account is told.
grant select, insert, update, delete on public.usdt_wallets to authenticated;
create function pg_temp.save_as(p_user text, p_method text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user, true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user, 'aal', 'aal1',
    'amr', jsonb_build_array(jsonb_build_object('method', p_method, 'timestamp', extract(epoch from now())::bigint - 30)))::text, true);
  execute 'set local role authenticated';
  insert into usdt_wallets(user_id, network, address) values (p_user::uuid, 'tron', 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL');
  execute 'reset role';
end $$;
do $$ begin
  perform pg_temp.save_as('f6000000-0000-0000-0000-0000000000a1', 'password');
  raise exception 'USDT address saved without a passkey';
exception when raise_exception then if sqlerrm <> 'Confirm with your passkey to change address' then raise; end if; end $$;
reset role;
select pg_temp.save_as('f6000000-0000-0000-0000-0000000000a1', 'passkey');
select set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true);
do $$ begin
  if (select usable_after from usdt_wallets where user_id = 'f6000000-0000-0000-0000-0000000000a1') > now() then
    raise exception 'USDT address saved with a passkey not usable at once'; end if;
  if not exists (select 1 from support_messages where user_id = 'f6000000-0000-0000-0000-0000000000a1' and security_notice
                  and message like 'Security notice: your USDT payout address%Payments are sent there from now on.%') then
    raise exception 'no USDT notice'; end if;
  if exists (select 1 from support_messages where message like '%24 hours%') then raise exception 'a notice still mentions 24 hours'; end if;
end $$;

-- 3. Lightning, saved through the Edge Function (service role, passkey checked
--    there): used at once, and the change replaces the address in use.
do $$
declare r record;
begin
  select * into r from system_set_settlement_destination('f6000000-0000-0000-0000-0000000000a1', 'first@pay.example.com', 'pay.example.com', 1000, 1000000000);
  if r.ready_at > now() then raise exception 'Lightning address not usable at once: %', r.ready_at; end if;
  select * into r from system_set_settlement_destination('f6000000-0000-0000-0000-0000000000a1', 'second@pay.example.com', 'pay.example.com', 1000, 1000000000);
  if r.ready_at > now() then raise exception 'changed address waits'; end if;
  if (select address from forward_destination_for('f6000000-0000-0000-0000-0000000000a1')) <> 'second@pay.example.com' then
    raise exception 'new address not in use'; end if;
  select * into r from system_set_settlement_destination('f6000000-0000-0000-0000-0000000000a2', 'mfa@pay.example.com', 'pay.example.com', 1000, 1000000000);
  if (select address from forward_destination_for('f6000000-0000-0000-0000-0000000000a2')) <> 'mfa@pay.example.com' then
    raise exception 'address not in use'; end if;
end $$;

-- 4. The account cannot hide a security notice (one message or the thread);
--    its own messages it still can.
insert into support_messages(user_id, sender, message) values ('f6000000-0000-0000-0000-0000000000a1', 'creator', 'hello');
select id as notice_id from support_messages where user_id = 'f6000000-0000-0000-0000-0000000000a1' and security_notice order by created_at limit 1 \gset
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f6000000-0000-0000-0000-0000000000a1', true);
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select hide_message(:'notice_id');
select clear_message_thread('f6000000-0000-0000-0000-0000000000a1');
reset role;
do $$ begin
  if exists (select 1 from support_messages where user_id = 'f6000000-0000-0000-0000-0000000000a1' and security_notice and deleted_by_creator) then
    raise exception 'security notice hidden by the account'; end if;
  if not exists (select 1 from support_messages where user_id = 'f6000000-0000-0000-0000-0000000000a1' and not security_notice and deleted_by_creator) then
    raise exception 'own message could not be hidden'; end if;
end $$;

-- 5. Admin hold of a waiting forward (needs admin and aal2), then retry.
select pg_temp.pay('f6000000-0000-0000-0000-0000000002a1', 'f6000000-0000-0000-0000-0000000000a2', 'f6000000-0000-0000-0000-0000000001a2', 3, 3000);
do $$ begin
  if (select status from payment_forwards where payment_id = 'f6000000-0000-0000-0000-0000000002a1') <> 'queued' then raise exception 'forward not queued'; end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f6000000-0000-0000-0000-0000000000a2', true);
select set_config('request.jwt.claims', '{"aal":"aal2"}', true);
do $$ begin
  perform admin_forward_action((select id from payment_forwards where payment_id = 'f6000000-0000-0000-0000-0000000002a1'), 'hold');
  raise exception 'non-admin held a forward';
exception when raise_exception then if sqlerrm <> 'Not authorized' then raise; end if; end $$;
select set_config('request.jwt.claim.sub', 'f6000000-0000-0000-0000-0000000000ad', true);
select set_config('request.jwt.claims', '{"aal":"aal1"}', true);
do $$ begin
  perform admin_forward_action((select id from payment_forwards where payment_id = 'f6000000-0000-0000-0000-0000000002a1'), 'hold');
  raise exception 'hold without aal2';
exception when raise_exception then if sqlerrm not like 'Sign in again with your passkey%' then raise; end if; end $$;
select set_config('request.jwt.claims', '{"aal":"aal2"}', true);
select admin_forward_action((select id from payment_forwards where payment_id = 'f6000000-0000-0000-0000-0000000002a1'), 'hold');
do $$ begin
  perform admin_forward_action((select id from payment_forwards where payment_id = 'f6000000-0000-0000-0000-0000000002a1'), 'hold');
  raise exception 'held twice';
exception when raise_exception then if sqlerrm not like 'Only a waiting forward%' then raise; end if; end $$;
reset role;
do $$ begin
  if (select status || '/' || reason from payment_forwards where payment_id = 'f6000000-0000-0000-0000-0000000002a1') <> 'owed/held_by_admin' then
    raise exception 'not held'; end if;
  if not exists (select 1 from audit_log where action = 'forward.hold') then raise exception 'hold not audited'; end if;
end $$;
set local role authenticated;
select admin_forward_action((select id from payment_forwards where payment_id = 'f6000000-0000-0000-0000-0000000002a1'), 'retry');
reset role;
do $$ begin
  if (select status from payment_forwards where payment_id = 'f6000000-0000-0000-0000-0000000002a1') <> 'queued' then raise exception 'retry after hold not queued'; end if;
end $$;

-- 6. USDT receive choice: accepted under 'refuse'; batches only for an
--    active account.
insert into usdt_wallets(user_id, network, address) values ('f6000000-0000-0000-0000-0000000000a3', 'tron', 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL');
do $$ begin
  -- Written by the database owner (no account session): used at once.
  if (select usable_after from usdt_wallets where user_id = 'f6000000-0000-0000-0000-0000000000a3') > now() then
    raise exception 'owner write waits'; end if;
end $$;
insert into receive_settings(user_id, method, usdt_network) values ('f6000000-0000-0000-0000-0000000000a3', 'usdt', 'tron');
insert into platform_settings(key, value) values ('instant_forward_no_address', '"refuse"');
select pg_temp.pay('f6000000-0000-0000-0000-0000000002a3', 'f6000000-0000-0000-0000-0000000000a3', 'f6000000-0000-0000-0000-0000000001a3', 20, 20000);
do $$ begin
  if (select kind || '/' || status from payment_forwards where payment_id = 'f6000000-0000-0000-0000-0000000002a3') <> 'usdt/queued' then
    raise exception 'USDT forward not queued under refuse'; end if;
end $$;
update profiles set account_status = 'suspended' where id = 'f6000000-0000-0000-0000-0000000000a3';
do $$ begin
  if exists (select 1 from system_usdt_batch_create('f6000000-0000-0000-0000-0000000000a3', 'tron', 'route-test')) then
    raise exception 'batch for a suspended account'; end if;
end $$;
update profiles set account_status = 'active' where id = 'f6000000-0000-0000-0000-0000000000a3';
create temp table b1 on commit drop as select * from system_usdt_batch_create('f6000000-0000-0000-0000-0000000000a3', 'tron', 'route-test');
do $$ begin
  if (select count(*) from b1) <> 1 then raise exception 'batch not created for the active account'; end if;
end $$;
select id as b1_id from b1 \gset

-- 7. Quote expiry: service-only, recorded only while sending.
do $$ begin
  if has_function_privilege('authenticated', 'public.system_usdt_batch_quoted(uuid, timestamptz)', 'execute')
     or has_function_privilege('anon', 'public.system_usdt_batch_quoted(uuid, timestamptz)', 'execute') then raise exception 'quoted exposed'; end if;
  if not has_function_privilege('service_role', 'public.system_usdt_batch_quoted(uuid, timestamptz)', 'execute') then raise exception 'quoted not for service'; end if;
  perform system_usdt_batch_quoted((select id from b1), now() + interval '1 minute');
  if (select quote_expires_at from forward_batches where id = (select id from b1)) is null then raise exception 'quote expiry not recorded'; end if;
end $$;

-- 8. Admin close of a stuck batch: only after an hour; delivered needs a
--    reference; hold makes its forwards owed for review.
insert into forward_batches(id, user_id, network, address, route_id, amount_sat, amount_usd)
values ('f6000000-0000-0000-0000-0000000003a2', 'f6000000-0000-0000-0000-0000000000a2', 'tron', 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL', 'route-test', 20000, 20);
set local role authenticated;
do $$ begin
  perform admin_forward_batch_action('f6000000-0000-0000-0000-0000000003a2', 'hold');
  raise exception 'closed a fresh batch';
exception when raise_exception then if sqlerrm not like 'Wait at least an hour%' then raise; end if; end $$;
reset role;
update forward_batches set updated_at = now() - interval '2 hours' where id in ('f6000000-0000-0000-0000-0000000003a2', (select id from b1));
set local role authenticated;
do $$ begin
  if jsonb_array_length(admin_list_forwards()->'stuck_batches') <> 2 then raise exception 'stuck batches not listed for the admin'; end if;
end $$;
do $$ begin
  perform admin_forward_batch_action('f6000000-0000-0000-0000-0000000003a2', 'delivered', '  ');
  raise exception 'delivered without a reference';
exception when raise_exception then if sqlerrm not like 'Give the transaction hash%' then raise; end if; end $$;
select set_config('request.jwt.claims', '{"aal":"aal1"}', true);
do $$ begin
  perform admin_forward_batch_action('f6000000-0000-0000-0000-0000000003a2', 'delivered', '0xabc');
  raise exception 'batch closed without aal2';
exception when raise_exception then if sqlerrm not like 'Sign in again with your passkey%' then raise; end if; end $$;
select set_config('request.jwt.claims', '{"aal":"aal2"}', true);
select admin_forward_batch_action('f6000000-0000-0000-0000-0000000003a2', 'delivered', '0xabc');
select admin_forward_batch_action(:'b1_id', 'hold');
do $$ begin
  perform admin_forward_batch_action('f6000000-0000-0000-0000-0000000003a2', 'hold');
  raise exception 'closed twice';
exception when raise_exception then if sqlerrm not like 'Only a batch that is still sending%' then raise; end if; end $$;
select set_config('request.jwt.claim.sub', 'f6000000-0000-0000-0000-0000000000a2', true);
do $$ begin
  perform admin_forward_batch_action((select id from forward_batches where route_id = 'route-test' and user_id = 'f6000000-0000-0000-0000-0000000000a3'), 'hold');
  raise exception 'non-admin closed a batch';
exception when raise_exception then if sqlerrm <> 'Not authorized' then raise; end if; end $$;
reset role;
do $$ begin
  if (select status || '/' || payment_ref from forward_batches where id = 'f6000000-0000-0000-0000-0000000003a2') <> 'forwarded/0xabc' then
    raise exception 'delivered batch not recorded'; end if;
  if (select status from forward_batches where id = (select id from b1)) <> 'held' then raise exception 'batch not held'; end if;
  if (select status || '/' || reason from payment_forwards where payment_id = 'f6000000-0000-0000-0000-0000000002a3') <> 'owed/stuck_admin_review' then
    raise exception 'held batch forwards not owed for review'; end if;
  if (select count(*) from audit_log where action like 'forward_batch.%') <> 2 then raise exception 'batch actions not audited'; end if;
end $$;

-- 9. Invariant holds.
do $$ declare r jsonb := instant_forward_invariants(); begin
  if not (r->>'ok')::boolean then raise exception 'invariant broken %', r; end if;
end $$;

rollback;
\echo 'forward_safety_test: ok'
