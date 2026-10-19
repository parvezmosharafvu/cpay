-- 20261020060000: forward and payout-address safety. A new payout address
-- (USDT or Lightning) is used at once only with an authenticator, otherwise
-- after 24 hours, and the address in use stays until then; the security
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

-- 1. When an address may be used: authenticator at once, otherwise 24 hours.
do $$ begin
  if payout_ready_at('f6000000-0000-0000-0000-0000000000a2') > now() then raise exception 'authenticator account waits'; end if;
  if payout_ready_at('f6000000-0000-0000-0000-0000000000a1') not between now() + interval '23 hours' and now() + interval '25 hours' then
    raise exception 'account without an authenticator does not wait 24 h'; end if;
  if has_function_privilege('authenticated', 'public.payout_ready_at(uuid)', 'execute')
     or has_function_privilege('anon', 'public.payout_ready_at(uuid)', 'execute') then raise exception 'payout_ready_at exposed'; end if;
  if exists (select 1 from pg_proc where proname = 'notify_payout_address_changed' and pronargs = 2) then
    raise exception 'old two-argument notifier still there'; end if;
end $$;

-- 2. USDT, saved by the account after a fresh sign-in: no authenticator
--    waits 24 h, and the notice says until when.
grant select, insert, update, delete on public.usdt_wallets to authenticated;
create function pg_temp.save_as(p_user text, p_aal text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user, true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user, 'aal', p_aal,
    'amr', jsonb_build_array(jsonb_build_object('method', 'password', 'timestamp', extract(epoch from now())::bigint - 30)))::text, true);
  execute 'set local role authenticated';
  insert into usdt_wallets(user_id, network, address) values (p_user::uuid, 'tron', 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL');
  execute 'reset role';
end $$;
select pg_temp.save_as('f6000000-0000-0000-0000-0000000000a1', 'aal1');
select pg_temp.save_as('f6000000-0000-0000-0000-0000000000a2', 'aal2');
select set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true);
do $$ begin
  if (select usable_after from usdt_wallets where user_id = 'f6000000-0000-0000-0000-0000000000a1') < now() + interval '23 hours' then
    raise exception 'USDT address without an authenticator usable early'; end if;
  if (select usable_after from usdt_wallets where user_id = 'f6000000-0000-0000-0000-0000000000a2') > now() then
    raise exception 'USDT address with an authenticator not usable at once'; end if;
  if not exists (select 1 from support_messages where user_id = 'f6000000-0000-0000-0000-0000000000a1' and security_notice
                  and message like 'Security notice: your USDT payout address%24 hours, because this account has no authenticator%') then
    raise exception 'no 24 h USDT notice'; end if;
  if not exists (select 1 from support_messages where user_id = 'f6000000-0000-0000-0000-0000000000a2' and security_notice
                  and message like '%Payments are sent there from now on.%') then
    raise exception 'no at-once USDT notice'; end if;
  if (select note from audit_log where action = 'payout_wallet.saved' and subject_id = 'f6000000-0000-0000-0000-0000000000a1' order by id desc limit 1)
     not like '%usable in 24 hours%' then raise exception 'audit does not record the wait'; end if;
end $$;

-- 3. Lightning: no authenticator waits 24 h; the address in use stays until
--    the new one is ready.
do $$
declare r record;
begin
  select * into r from system_set_settlement_destination('f6000000-0000-0000-0000-0000000000a1', 'first@pay.example.com', 'pay.example.com', 1000, 1000000000);
  if r.ready_at < now() + interval '23 hours' then raise exception 'Lightning address without an authenticator usable early: %', r.ready_at; end if;
  if exists (select 1 from forward_destination_for('f6000000-0000-0000-0000-0000000000a1')) then raise exception 'waiting address used'; end if;
end $$;
alter table settlement_destinations disable trigger trg_guard_settlement_destination_changes;
update settlement_destinations set ready_at = now() - interval '1 minute' where user_id = 'f6000000-0000-0000-0000-0000000000a1';
alter table settlement_destinations enable trigger trg_guard_settlement_destination_changes;
do $$
declare r record;
begin
  select * into r from system_set_settlement_destination('f6000000-0000-0000-0000-0000000000a1', 'mallory@evil.example.com', 'evil.example.com', 1000, 1000000000);
  if r.ready_at < now() + interval '23 hours' then raise exception 'changed address usable early'; end if;
  if (select address from forward_destination_for('f6000000-0000-0000-0000-0000000000a1')) <> 'first@pay.example.com' then
    raise exception 'the address in use was dropped before the new one is ready'; end if;
  select * into r from system_set_settlement_destination('f6000000-0000-0000-0000-0000000000a2', 'mfa@pay.example.com', 'pay.example.com', 1000, 1000000000);
  if r.ready_at > now() then raise exception 'Lightning address with an authenticator not usable at once'; end if;
  if (select address from forward_destination_for('f6000000-0000-0000-0000-0000000000a2')) <> 'mfa@pay.example.com' then
    raise exception 'authenticator account address not in use'; end if;
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
exception when raise_exception then if sqlerrm not like 'Enter your authenticator code%' then raise; end if; end $$;
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
exception when raise_exception then if sqlerrm not like 'Enter your authenticator code%' then raise; end if; end $$;
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
