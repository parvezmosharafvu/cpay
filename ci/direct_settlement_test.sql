-- ============================================================
-- 20261018010000: direct settlement (non-custodial receive), off by default
-- ============================================================
-- Off by default and refusing while off; only the link's owner can make a
-- link direct; a direct link never creates a custodial payment; a direct
-- payment is paid only with a preimage that hashes to its payment hash,
-- paid is final, expiry waits for the invoice; direct payments never touch
-- a CPAY balance; accounts cannot see each other's rows; a new Lightning
-- address waits 24 h; the internal functions are service-only; turning
-- the switch on needs aal2. BEGIN/ROLLBACK.
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
  ('d5000000-0000-0000-0000-0000000000f1', 'direct-a@test.invalid'),
  ('d5000000-0000-0000-0000-0000000000f2', 'direct-b@test.invalid'),
  ('d5000000-0000-0000-0000-0000000000a1', 'direct-admin@test.invalid');
update profiles set account_status = 'active' where id::text like 'd5000000-%';
update profiles set role = 'admin' where id = 'd5000000-0000-0000-0000-0000000000a1';
insert into payment_links(id, user_id, slug) values
  ('d5000000-0000-0000-0000-0000000001f1', 'd5000000-0000-0000-0000-0000000000f1', 'direct-a-link'),
  ('d5000000-0000-0000-0000-0000000001f2', 'd5000000-0000-0000-0000-0000000000f2', 'direct-b-link');

-- Settled custodial history for A, so the balance has something to keep.
insert into payments(id, user_id, payment_link_id, amount_requested, method, status, expires_at, invoice_ref)
values ('d5000000-0000-0000-0000-0000000002f1', 'd5000000-0000-0000-0000-0000000000f1', 'd5000000-0000-0000-0000-0000000001f1',
        40, 'lightning', 'new', now() + interval '15 min', 'direct-test-custodial-ref');
update payments set status = 'settled', amount_settled = 40, settled_at = now() where id = 'd5000000-0000-0000-0000-0000000002f1';
create temp table balance_before as select * from get_balance_for('d5000000-0000-0000-0000-0000000000f1');

-- 1. Off by default.
do $$ begin
  if direct_settlement_enabled() then raise exception 'direct settlement is on by default'; end if;
  if (select value from app_settings where key = 'direct_settlement_enabled') <> 'false'::jsonb then raise exception 'flag row is not JSON false'; end if;
  if (select settlement_mode from payment_links where id = 'd5000000-0000-0000-0000-0000000001f1') <> 'custodial' then raise exception 'links are not custodial by default'; end if;
end $$;
do $$ begin
  update app_settings set value = '"true"'::jsonb where key = 'direct_settlement_enabled';
  raise exception 'a non-boolean flag value was accepted';
exception when check_violation then null;
end $$;
do $$ begin
  perform system_set_settlement_destination('d5000000-0000-0000-0000-0000000000f1', 'a@pay.example.com', 'pay.example.com', 1000, 1000000);
  raise exception 'a destination was saved while the switch is off';
exception when raise_exception then
  if sqlerrm not like 'Direct payments are not available yet%' then raise; end if;
end $$;

-- As A (signed in): cannot make a link direct while off.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd5000000-0000-0000-0000-0000000000f1', true);
do $$ begin
  perform set_link_settlement_mode('d5000000-0000-0000-0000-0000000001f1', 'direct');
  raise exception 'link made direct while the switch is off';
exception when raise_exception then
  if sqlerrm not like 'Direct payments are not available yet%' then raise; end if;
end $$;
do $$ begin
  if (get_my_direct_settlement()->>'enabled')::boolean then raise exception 'desk sees the switch on'; end if;
end $$;
reset role;

-- 2. The switch: unknown to non-admins, and ON needs aal2.
select set_config('request.jwt.claim.sub', 'd5000000-0000-0000-0000-0000000000a1', true);
select set_config('request.jwt.claims', '{"aal":"aal1"}', true);
do $$ begin
  perform admin_set_feature_toggle('direct_settlement_enabled', true);
  raise exception 'switch turned on without aal2';
exception when raise_exception then
  if sqlerrm not like 'Enter your authenticator code first%' then raise; end if;
end $$;
select admin_set_feature_toggle('direct_settlement_enabled', false); -- OFF never needs it
select set_config('request.jwt.claims', '{"aal":"aal2"}', true);
-- Not around the function: a signed-in admin writing the row directly
-- (the "settings admin write" policy) is refused, aal2 or not.
do $$ begin
  update app_settings set value = 'true'::jsonb where key = 'direct_settlement_enabled';
  raise exception 'a signed-in admin wrote the switch directly';
exception when raise_exception then
  if sqlerrm not like 'Change direct payments in Admin%' then raise; end if;
end $$;
select admin_set_feature_toggle('direct_settlement_enabled', true);
select set_config('request.jwt.claim.sub', 'd5000000-0000-0000-0000-0000000000f1', true);
do $$ begin
  perform admin_set_feature_toggle('direct_settlement_enabled', false);
  raise exception 'a freelancer changed the switch';
exception when raise_exception then
  if sqlerrm <> 'Not authorized' then raise; end if;
end $$;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '', true);
do $$ begin
  if not direct_settlement_enabled() then raise exception 'switch did not turn on'; end if;
end $$;

-- 3. Destination: saved by the service role, waits 24 h, same address is a no-op.
do $$
declare r record;
begin
  select * into r from system_set_settlement_destination('d5000000-0000-0000-0000-0000000000f1', 'Alice@Pay.Example.com', 'pay.example.com', 1000, 1000000000);
  if r.address <> 'alice@pay.example.com' or r.unchanged then raise exception 'destination not saved: %', r; end if;
  if r.ready_at < now() + interval '23 hours 59 minutes' then raise exception 'no 24 h wait: %', r.ready_at; end if;
  if exists (select 1 from system_direct_destination_for('d5000000-0000-0000-0000-0000000000f1')) then
    raise exception 'destination usable before its wait';
  end if;
  select * into r from system_set_settlement_destination('d5000000-0000-0000-0000-0000000000f1', 'alice@pay.example.com', 'pay.example.com', 1000, 1000000000);
  if not r.unchanged then raise exception 'saving the same address started a new wait'; end if;
  if (select count(*) from audit_log where action = 'settlement.destination_saved' and subject_id = 'd5000000-0000-0000-0000-0000000000f1') <> 1 then
    raise exception 'destination save not audited once';
  end if;
end $$;
do $$ begin
  insert into settlement_destinations(user_id, address, callback_host, min_sendable_msat, max_sendable_msat, checked_at, ready_at)
  values ('d5000000-0000-0000-0000-0000000000f1', 'not an address', 'x.example.com', 1, 2, now(), now());
  raise exception 'a malformed address was stored';
exception when check_violation then null;
end $$;
-- While the address waits, a link cannot pay it yet.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd5000000-0000-0000-0000-0000000000f1', true);
do $$ begin
  perform set_link_settlement_mode('d5000000-0000-0000-0000-0000000001f1', 'direct');
  raise exception 'a link was made direct while its address still waits';
exception when raise_exception then
  if sqlerrm not like 'Your Lightning address is not in use yet%' then raise; end if;
end $$;
reset role;
select set_config('request.jwt.claim.sub', '', true);
-- Pass the wait (test only: rewrite the row with the guard off).
alter table settlement_destinations disable trigger trg_guard_settlement_destination_changes;
update settlement_destinations set ready_at = now() - interval '1 minute' where user_id = 'd5000000-0000-0000-0000-0000000000f1';
alter table settlement_destinations enable trigger trg_guard_settlement_destination_changes;
-- Another address saved (waiting), then the one in use saved again: the
-- waiting one is cancelled and the one in use keeps going, with no new wait.
do $$
declare r record; v_ready timestamptz;
begin
  select ready_at into v_ready from settlement_destinations where user_id = 'd5000000-0000-0000-0000-0000000000f1' and status = 'active';
  perform system_set_settlement_destination('d5000000-0000-0000-0000-0000000000f1', 'mallory@evil.example.com', 'evil.example.com', 1000, 1000000000);
  select * into r from system_set_settlement_destination('d5000000-0000-0000-0000-0000000000f1', 'alice@pay.example.com', 'pay.example.com', 1000, 1000000000);
  if not r.unchanged or r.ready_at <> v_ready then raise exception 're-saving the address in use started a new wait: %', r; end if;
  if exists (select 1 from settlement_destinations where address = 'mallory@evil.example.com' and status = 'active') then
    raise exception 'the waiting address was not cancelled';
  end if;
end $$;
do $$ begin
  if (select address from system_direct_destination_for('d5000000-0000-0000-0000-0000000000f1')) <> 'alice@pay.example.com' then
    raise exception 'ready destination not used';
  end if;
  update settlement_destinations set address = 'mallory@evil.example.com' where user_id = 'd5000000-0000-0000-0000-0000000000f1';
  raise exception 'a saved address was edited in place';
exception when raise_exception then
  if sqlerrm not like 'A saved Lightning address cannot be edited%' then raise; end if;
end $$;

-- 4. Only the owner sets a link's mode; never an admin, never the service role.
do $$ begin
  update payment_links set settlement_mode = 'direct' where id = 'd5000000-0000-0000-0000-0000000001f1';
  raise exception 'service role changed a link''s mode directly';
exception when raise_exception then
  if sqlerrm not like 'Only the link''s owner%' then raise; end if;
end $$;
do $$ begin
  insert into payment_links(user_id, slug, settlement_mode) values ('d5000000-0000-0000-0000-0000000000f1', 'direct-a-new', 'direct');
  raise exception 'a link was created direct';
exception when raise_exception then
  if sqlerrm not like 'A new link starts with CPAY balance payments%' then raise; end if;
end $$;
select set_config('request.jwt.claim.sub', 'd5000000-0000-0000-0000-0000000000a1', true);
do $$ begin
  perform set_link_settlement_mode('d5000000-0000-0000-0000-0000000001f1', 'direct');
  raise exception 'an admin set someone else''s link mode';
exception when raise_exception then
  if sqlerrm <> 'Payment link not found' then raise; end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd5000000-0000-0000-0000-0000000000f2', true);
do $$ begin
  perform set_link_settlement_mode('d5000000-0000-0000-0000-0000000001f1', 'direct');
  raise exception 'B set A''s link mode';
exception when raise_exception then
  if sqlerrm <> 'Payment link not found' then raise; end if;
end $$;
do $$ begin
  perform set_link_settlement_mode('d5000000-0000-0000-0000-0000000001f2', 'direct');
  raise exception 'B made a link direct without an address';
exception when raise_exception then
  if sqlerrm <> 'Add your Lightning address first' then raise; end if;
end $$;
select set_config('request.jwt.claim.sub', 'd5000000-0000-0000-0000-0000000000f1', true);
select set_link_settlement_mode('d5000000-0000-0000-0000-0000000001f1', 'direct');
do $$ begin
  if (get_my_direct_settlement()->'current'->>'address') <> 'alice@pay.example.com' then raise exception 'desk does not show the address'; end if;
end $$;
reset role;
select set_config('request.jwt.claim.sub', '', true);
do $$ begin
  if (select settlement_mode from payment_links where id = 'd5000000-0000-0000-0000-0000000001f1') <> 'direct' then raise exception 'owner could not make the link direct'; end if;
  if not exists (select 1 from audit_log where action = 'link.settlement_mode' and subject_id = 'd5000000-0000-0000-0000-0000000001f1') then raise exception 'mode change not audited'; end if;
  if not (select direct_ready from get_link_preview('direct-a-link')) then raise exception 'payment page does not see the direct link as ready'; end if;
  if (select settlement_mode from get_link_preview('direct-b-link')) <> 'custodial' then raise exception 'B''s link changed'; end if;
end $$;

-- 5. A direct link never creates a custodial payment.
do $$ begin
  insert into payments(user_id, payment_link_id, amount_requested, method, status, expires_at)
  values ('d5000000-0000-0000-0000-0000000000f1', 'd5000000-0000-0000-0000-0000000001f1', 10, 'lightning', 'new', now() + interval '1 hour');
  raise exception 'a custodial payment row was created for a direct link';
exception when raise_exception then
  if sqlerrm <> 'This link takes direct payments only' then raise; end if;
end $$;

-- 6. Direct payments: proof, finality, expiry, isolation, balance untouched.
-- preimage 00..00 -> sha256 66687aad...
insert into direct_payments(id, payment_link_id, user_id, destination_id, destination_address, buyer_amount, amount_usd, amount_msat,
                            btc_usd_rate, rate_sources, bolt11, payment_hash, verify_url, expires_at)
select 'd5000000-0000-0000-0000-0000000003f1', 'd5000000-0000-0000-0000-0000000001f1', 'd5000000-0000-0000-0000-0000000000f1', d.id, d.address,
       25, 25, 25000000, 100000, array['a', 'b'], 'lnbc250u1directtestinvoice', encode(sha256(decode(repeat('00', 32), 'hex')), 'hex'),
       'https://pay.example.com/verify/x', now() + interval '1 hour'
  from settlement_destinations d where d.user_id = 'd5000000-0000-0000-0000-0000000000f1' and d.status = 'active';
do $$ begin
  update direct_payments set status = 'paid', preimage = repeat('11', 32), paid_observed_at = now() where id = 'd5000000-0000-0000-0000-0000000003f1';
  raise exception 'paid with a wrong preimage';
exception when check_violation then null;
end $$;
do $$ begin
  perform system_record_direct_payment_proof('d5000000-0000-0000-0000-0000000003f1', repeat('22', 32));
  raise exception 'proof RPC accepted a wrong preimage';
exception when check_violation then null;
end $$;
do $$ begin
  update direct_payments set status = 'paid' where id = 'd5000000-0000-0000-0000-0000000003f1';
  raise exception 'paid without a preimage';
exception when check_violation then null;
end $$;
do $$ begin
  update direct_payments set status = 'expired' where id = 'd5000000-0000-0000-0000-0000000003f1';
  raise exception 'expired before the invoice did';
exception when raise_exception then
  if sqlerrm not like 'A direct payment expires only after%' then raise; end if;
end $$;
do $$ begin
  if system_expire_direct_payment('d5000000-0000-0000-0000-0000000003f1', 600) <> 'pending' then raise exception 'expired early through the RPC'; end if;
  update direct_payments set amount_msat = 1000 where id = 'd5000000-0000-0000-0000-0000000003f1';
  raise exception 'invoice details were changed';
exception when raise_exception then
  if sqlerrm not like 'A direct payment''s invoice details cannot change%' then raise; end if;
end $$;
-- Check claims: one per interval however many callers ask.
do $$ begin
  if (select count(*) from system_claim_direct_check('d5000000-0000-0000-0000-0000000003f1', 3)) <> 1 then raise exception 'first check not claimed'; end if;
  if (select count(*) from system_claim_direct_check('d5000000-0000-0000-0000-0000000003f1', 3)) <> 0 then raise exception 'second check within the interval was claimed'; end if;
end $$;
do $$ begin
  if system_record_direct_payment_proof('d5000000-0000-0000-0000-0000000003f1', repeat('00', 32)) <> 'paid' then raise exception 'true proof refused'; end if;
  if system_record_direct_payment_proof('d5000000-0000-0000-0000-0000000003f1', repeat('00', 32)) <> 'paid' then raise exception 'repeat proof not idempotent'; end if;
  if (select count(*) from system_claim_direct_check('d5000000-0000-0000-0000-0000000003f1', 0)) <> 0 then raise exception 'a paid payment was claimed for checking'; end if;
  update direct_payments set status = 'expired' where id = 'd5000000-0000-0000-0000-0000000003f1';
  raise exception 'a paid payment changed status';
exception when raise_exception then
  if sqlerrm <> 'A paid direct payment is final' then raise; end if;
end $$;
do $$ begin
  delete from direct_payments where id = 'd5000000-0000-0000-0000-0000000003f1';
  raise exception 'a direct payment was deleted';
exception when raise_exception then
  if sqlerrm <> 'Direct payment records are kept' then raise; end if;
end $$;
-- Late proof after expiry still counts (out-of-order delivery).
insert into direct_payments(id, payment_link_id, user_id, destination_id, destination_address, buyer_amount, amount_usd, amount_msat,
                            btc_usd_rate, rate_sources, bolt11, payment_hash, verify_url, expires_at, created_at)
select 'd5000000-0000-0000-0000-0000000003f2', 'd5000000-0000-0000-0000-0000000001f1', 'd5000000-0000-0000-0000-0000000000f1', d.id, d.address,
       5, 5, 5000000, 100000, array['a', 'b'], 'lnbc50u1directtestinvoice2', encode(sha256(decode(repeat('33', 32), 'hex')), 'hex'),
       'https://pay.example.com/verify/y', now() - interval '2 hours', now() - interval '3 hours'
  from settlement_destinations d where d.user_id = 'd5000000-0000-0000-0000-0000000000f1' and d.status = 'active';
do $$ begin
  if system_expire_direct_payment('d5000000-0000-0000-0000-0000000003f2', 600) <> 'expired' then raise exception 'not expired after the grace period'; end if;
  -- The sweep checks an expired invoice at most every 10 minutes.
  update direct_payments set last_checked_at = now() - interval '2 minutes' where id = 'd5000000-0000-0000-0000-0000000003f2';
  if exists (select 1 from system_claim_direct_checks(10, 60) where id = 'd5000000-0000-0000-0000-0000000003f2') then
    raise exception 'an expired invoice was re-checked within 10 minutes';
  end if;
  update direct_payments set last_checked_at = now() - interval '11 minutes' where id = 'd5000000-0000-0000-0000-0000000003f2';
  if not exists (select 1 from system_claim_direct_checks(10, 60) where id = 'd5000000-0000-0000-0000-0000000003f2') then
    raise exception 'an expired invoice was not re-checked after 10 minutes';
  end if;
  if system_record_direct_payment_proof('d5000000-0000-0000-0000-0000000003f2', repeat('33', 32)) <> 'paid' then raise exception 'late proof refused'; end if;
end $$;
-- The CPAY balance is exactly what it was: direct payments are not in it.
do $$ begin
  if (select to_jsonb(b) from get_balance_for('d5000000-0000-0000-0000-0000000000f1') b) <> (select to_jsonb(b) from balance_before b) then
    raise exception 'direct payments changed the CPAY balance';
  end if;
end $$;
-- Own rows only; anon sees nothing.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd5000000-0000-0000-0000-0000000000f2', true);
do $$ begin
  if exists (select 1 from direct_payments) or exists (select 1 from settlement_destinations) then raise exception 'B can read A''s direct rows'; end if;
end $$;
do $$ begin
  update direct_payments set status = 'paid';
  raise exception 'authenticated could update direct payments';
exception when insufficient_privilege then null;
end $$;
select set_config('request.jwt.claim.sub', 'd5000000-0000-0000-0000-0000000000f1', true);
do $$ begin
  if (select count(*) from direct_payments) <> 2 or (select count(*) from settlement_destinations) <> 2 then raise exception 'A cannot read own direct rows'; end if;
  insert into settlement_destinations(user_id, address, callback_host, min_sendable_msat, max_sendable_msat, checked_at, ready_at)
  values ('d5000000-0000-0000-0000-0000000000f1', 'self@pay.example.com', 'pay.example.com', 1, 2, now(), now());
  raise exception 'a Freelancer inserted a destination without the wait';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  perform system_set_settlement_destination('d5000000-0000-0000-0000-0000000000f1', 'self@pay.example.com', 'pay.example.com', 1, 2);
  raise exception 'a Freelancer called the service-only save';
exception when insufficient_privilege then null;
end $$;
reset role;
set local role anon;
do $$ begin
  perform 1 from direct_payments;
  raise exception 'anon can read direct payments';
exception when insufficient_privilege then null;
end $$;
reset role;
do $$
declare f text;
begin
  foreach f in array array['system_direct_destination_for(uuid)', 'system_set_settlement_destination(uuid, text, text, bigint, bigint)',
    'system_remove_settlement_destinations(uuid)', 'system_claim_direct_check(uuid, integer)', 'system_claim_direct_checks(integer, integer)',
    'system_record_direct_payment_proof(uuid, text)', 'system_expire_direct_payment(uuid, integer)', 'system_direct_payment_public(uuid)',
    'direct_settlement_enabled()'] loop
    if has_function_privilege('anon', 'public.' || f, 'execute') or has_function_privilege('authenticated', 'public.' || f, 'execute') then
      raise exception '% is callable by a client role', f;
    end if;
  end loop;
end $$;

-- 7. Admin block stops direct links taking payments, and redirects nothing.
select set_config('request.jwt.claim.sub', 'd5000000-0000-0000-0000-0000000000a1', true);
select admin_set_direct_settlement_blocked('d5000000-0000-0000-0000-0000000000f1', true);
select set_config('request.jwt.claim.sub', '', true);
do $$ begin
  if exists (select 1 from system_direct_destination_for('d5000000-0000-0000-0000-0000000000f1')) then raise exception 'blocked account still takes direct payments'; end if;
  if (select direct_ready from get_link_preview('direct-a-link')) then raise exception 'blocked link still ready'; end if;
  if (select settlement_mode from payment_links where id = 'd5000000-0000-0000-0000-0000000001f1') <> 'direct' then raise exception 'blocking changed where the link pays'; end if;
end $$;
-- Removing the address: the link stays direct and stops taking payments.
select admin_set_direct_settlement_blocked('d5000000-0000-0000-0000-0000000000f1', false) from (select set_config('request.jwt.claim.sub', 'd5000000-0000-0000-0000-0000000000a1', true)) s;
select set_config('request.jwt.claim.sub', '', true);
do $$ begin
  if system_remove_settlement_destinations('d5000000-0000-0000-0000-0000000000f1') <> 1 then raise exception 'remove did not remove'; end if;
  if exists (select 1 from system_direct_destination_for('d5000000-0000-0000-0000-0000000000f1')) then raise exception 'removed address still used'; end if;
end $$;
-- The switch off stops every direct link at once.
select set_config('request.jwt.claim.sub', 'd5000000-0000-0000-0000-0000000000a1', true);
select admin_set_feature_toggle('direct_settlement_enabled', false);
do $$ begin
  if direct_settlement_enabled() then raise exception 'switch did not turn off'; end if;
end $$;
\echo 'direct settlement: PASS'
rollback;
