-- 20261021010000: Auto withdraw switch. Global switch = payment_mode;
-- per-profile override (default/on/off) by an admin at aal2 only, audited;
-- effective mode decides forward vs balance; turning a user off releases
-- waiting forwards into the balance; the desk sees its own state; manual
-- Lightning withdrawals lock the balance (no double spend). BEGIN/ROLLBACK.
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
  ('ea100000-0000-0000-0000-0000000000a1', 'aw-a@test.invalid'),
  ('ea100000-0000-0000-0000-0000000000b1', 'aw-b@test.invalid'),
  ('ea100000-0000-0000-0000-0000000000ad', 'aw-admin@test.invalid');
update profiles set account_status = 'active' where id::text like 'ea100000-%';
update profiles set role = 'admin' where id = 'ea100000-0000-0000-0000-0000000000ad';
insert into payment_links(id, user_id, slug) values
  ('ea100000-0000-0000-0000-0000000001a1', 'ea100000-0000-0000-0000-0000000000a1', 'aw-link-a'),
  ('ea100000-0000-0000-0000-0000000001b1', 'ea100000-0000-0000-0000-0000000000b1', 'aw-link-b');
create function pg_temp.pay(p_id text, p_user text, p_link text, p_usd numeric, p_sat bigint) returns void language plpgsql as $$
begin
  insert into payments(id, user_id, payment_link_id, amount_requested, method, status, expires_at, invoice_ref)
  values (p_id::uuid, p_user::uuid, p_link::uuid, p_usd, 'lightning', 'new', now() + interval '15 min', 'aw-' || p_id);
  update payments set status = 'settled', amount_settled = p_usd, amount_sat = p_sat, settled_at = now() where id = p_id::uuid;
end $$;

-- 1. Default: global balance, no override -> balance for everyone; no
--    Lightning address can be saved until auto withdraw is on for the user.
do $$ begin
  if payment_mode_for('ea100000-0000-0000-0000-0000000000a1') <> 'balance' then raise exception 'default not balance'; end if;
  perform system_set_settlement_destination('ea100000-0000-0000-0000-0000000000a1', 'a@pay.example.com', 'pay.example.com', 1000, 100000000);
  raise exception 'address saved while auto withdraw is off';
exception when raise_exception then if sqlerrm not like 'Direct payments are not available yet%' then raise; end if; end $$;
insert into auto_withdraw_overrides(user_id, mode) values ('ea100000-0000-0000-0000-0000000000a1', 'on');
select system_set_settlement_destination('ea100000-0000-0000-0000-0000000000a1', 'a@pay.example.com', 'pay.example.com', 1000, 100000000);
alter table settlement_destinations disable trigger user;
update settlement_destinations set ready_at = now() - interval '1 minute' where user_id = 'ea100000-0000-0000-0000-0000000000a1';
alter table settlement_destinations enable trigger user;
delete from auto_withdraw_overrides;
do $$ begin
  if direct_settlement_enabled_for('ea100000-0000-0000-0000-0000000000a1') then raise exception 'saving an address opened direct links'; end if;
  if exists (select 1 from system_direct_destination_for('ea100000-0000-0000-0000-0000000000a1')) then raise exception 'direct destination exposed'; end if;
end $$;

-- 2. Override needs an admin at aal2; users and anon cannot call it.
set local role anon;
do $$ begin perform admin_set_auto_withdraw('ea100000-0000-0000-0000-0000000000a1', 'on'); raise exception 'anon ran it';
exception when insufficient_privilege then null; end $$;
do $$ begin perform admin_auto_withdraw_overview(); raise exception 'anon ran overview';
exception when insufficient_privilege then null; end $$;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ea100000-0000-0000-0000-0000000000a1', true);
select set_config('request.jwt.claims', '{"aal":"aal2"}', true);
do $$ begin perform admin_set_auto_withdraw('ea100000-0000-0000-0000-0000000000a1', 'on'); raise exception 'user set own override';
exception when raise_exception then if sqlerrm <> 'Not authorized' then raise; end if; end $$;
do $$ begin perform 1 from auto_withdraw_overrides; raise exception 'table readable';
exception when insufficient_privilege then null; end $$;
do $$ declare s jsonb := my_receive_settings(); begin
  if (s->>'auto_withdraw')::boolean or s->>'payment_mode' <> 'balance' then raise exception 'desk %', s; end if;
end $$;
select set_config('request.jwt.claim.sub', 'ea100000-0000-0000-0000-0000000000ad', true);
select set_config('request.jwt.claims', '{}', true);
do $$ begin perform admin_set_auto_withdraw('ea100000-0000-0000-0000-0000000000a1', 'on'); raise exception 'aal1 accepted';
exception when raise_exception then if sqlerrm not like 'Sign in again with your passkey%' then raise; end if; end $$;
select set_config('request.jwt.claims', '{"aal":"aal2"}', true);
do $$ begin perform admin_set_auto_withdraw('ea100000-0000-0000-0000-0000000000a1', 'maybe'); raise exception 'bad mode accepted';
exception when raise_exception then if sqlerrm <> 'Choose default, on or off' then raise; end if; end $$;
do $$ declare r jsonb := admin_set_auto_withdraw('ea100000-0000-0000-0000-0000000000a1', 'on'); begin
  if not (r->>'auto_withdraw')::boolean then raise exception 'not on %', r; end if;
end $$;
reset role;
do $$ begin
  if not exists (select 1 from audit_log where action = 'auto_withdraw.profile' and subject_id = 'ea100000-0000-0000-0000-0000000000a1') then
    raise exception 'not audited'; end if;
  if payment_mode_for('ea100000-0000-0000-0000-0000000000a1') <> 'instant_forward' then raise exception 'override ignored'; end if;
  if payment_mode_for('ea100000-0000-0000-0000-0000000000b1') <> 'balance' then raise exception 'override leaked to b'; end if;
end $$;

-- 3. A (on): payment forwarded after the fee; B (default, global off): balance.
select pg_temp.pay('ea100000-0000-0000-0000-0000000002a1', 'ea100000-0000-0000-0000-0000000000a1', 'ea100000-0000-0000-0000-0000000001a1', 20, 20000);
select pg_temp.pay('ea100000-0000-0000-0000-0000000002b1', 'ea100000-0000-0000-0000-0000000000b1', 'ea100000-0000-0000-0000-0000000001b1', 20, 20000);
do $$ declare f payment_forwards; begin
  select * into f from payment_forwards where payment_id = 'ea100000-0000-0000-0000-0000000002a1';
  if f.id is null or f.status <> 'queued' or f.address <> 'a@pay.example.com' then raise exception 'A not forwarded %', f; end if;
  if f.forward_sat + f.fee_sat <> 20000 then raise exception 'split %', f; end if;
  if exists (select 1 from payment_forwards where payment_id = 'ea100000-0000-0000-0000-0000000002b1') then raise exception 'B forwarded'; end if;
  if (select available from get_balance_for('ea100000-0000-0000-0000-0000000000b1')) <= 0 then raise exception 'B balance missing'; end if;
  if (select count(*) from system_forward_claim(50) c where c.user_id = 'ea100000-0000-0000-0000-0000000000a1') <> 1 then raise exception 'worker skipped A'; end if;
end $$;
-- The claim above moved A's forward to 'sending'; finish it as failed-retry
-- so it is waiting again.
update payment_forwards set status = 'retry', next_attempt_at = now() + interval '1 hour'
 where payment_id = 'ea100000-0000-0000-0000-0000000002a1';

-- 4. Turning A off: waiting forward released into A's balance, nothing sent.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ea100000-0000-0000-0000-0000000000ad', true);
select set_config('request.jwt.claims', '{"aal":"aal2"}', true);
do $$ declare r jsonb := admin_set_auto_withdraw('ea100000-0000-0000-0000-0000000000a1', 'off'); begin
  if (r->>'auto_withdraw')::boolean or (r->>'released_forwards')::int <> 1 then raise exception 'off %', r; end if;
end $$;
reset role;
do $$ begin
  if (select status from payment_forwards where payment_id = 'ea100000-0000-0000-0000-0000000002a1') <> 'released' then raise exception 'not released'; end if;
  if (select available from get_balance_for('ea100000-0000-0000-0000-0000000000a1')) < 19 then raise exception 'A balance missing'; end if;
end $$;

-- 5. Global switch ON: B follows it, A stays off (override wins); default resets.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ea100000-0000-0000-0000-0000000000ad', true);
select set_config('request.jwt.claims', '{"aal":"aal2"}', true);
select admin_set_auto_withdraw_global(true);
do $$ declare o jsonb := admin_auto_withdraw_overview(); begin
  if not (o->>'global')::boolean then raise exception 'global %', o; end if;
end $$;
reset role;
do $$ begin
  if payment_mode() <> 'instant_forward' then raise exception 'global not on'; end if;
  if payment_mode_for('ea100000-0000-0000-0000-0000000000b1') <> 'instant_forward' then raise exception 'B not following'; end if;
  if payment_mode_for('ea100000-0000-0000-0000-0000000000a1') <> 'balance' then raise exception 'A override lost'; end if;
  if not exists (select 1 from audit_log where action = 'auto_withdraw.global') then raise exception 'global not audited'; end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ea100000-0000-0000-0000-0000000000ad', true);
select set_config('request.jwt.claims', '{"aal":"aal2"}', true);
select admin_set_auto_withdraw('ea100000-0000-0000-0000-0000000000a1', 'default');
select admin_set_auto_withdraw_global(false);
reset role;
do $$ begin
  if exists (select 1 from auto_withdraw_overrides where user_id = 'ea100000-0000-0000-0000-0000000000a1') then raise exception 'default kept row'; end if;
  if payment_mode() <> 'balance' then raise exception 'global not off'; end if;
end $$;

-- 6. Manual Lightning withdrawal: saved address or invoice only, limits,
--    one quote one row, and the balance cannot be spent twice.
do $$ declare w withdrawals; v_av numeric := (select available from get_balance_for('ea100000-0000-0000-0000-0000000000a1')); begin
  begin
    perform reserve_lightning_withdrawal('ea100000-0000-0000-0000-0000000000a1', 'q-x', 5, resolve_withdrawal_fee('ea100000-0000-0000-0000-0000000000a1'),
      round(5 * (1 - resolve_withdrawal_fee('ea100000-0000-0000-0000-0000000000a1') / 100), 2), 'thief@evil.example', 5000, 5, now() + interval '1 min');
    raise exception 'unsaved address accepted';
  exception when raise_exception then if sqlerrm not like 'Save this Lightning address%' then raise; end if; end;
  w := reserve_lightning_withdrawal('ea100000-0000-0000-0000-0000000000a1', 'q-1', v_av, resolve_withdrawal_fee('ea100000-0000-0000-0000-0000000000a1'),
      round(v_av * (1 - resolve_withdrawal_fee('ea100000-0000-0000-0000-0000000000a1') / 100), 2), 'A@pay.example.com', 19000, 5, now() + interval '1 min');
  if w.status <> 'sending' or w.method <> 'lightning' then raise exception 'row %', w; end if;
  if (reserve_lightning_withdrawal('ea100000-0000-0000-0000-0000000000a1', 'q-1', v_av, w.fee_percent, w.amount_after_fee, 'a@pay.example.com', 19000, 5, now() + interval '1 min')).id <> w.id then
    raise exception 'same quote made a second row'; end if;
  begin
    perform reserve_lightning_withdrawal('ea100000-0000-0000-0000-0000000000a1', 'q-2', 1, w.fee_percent, round(1 * (1 - w.fee_percent / 100), 2), 'lnbcrt10u1test', 1000, 0, now() + interval '1 min');
    raise exception 'double spend';
  exception when raise_exception then if sqlerrm not like 'Insufficient balance%' then raise; end if; end;
  if finalize_stablecoin_withdrawal(w.id, 'failed', null, null, 'test') <> 'failed' then raise exception 'finalize'; end if;
  if finalize_stablecoin_withdrawal(w.id, 'failed') <> 'already_failed' then raise exception 'refund twice'; end if;
  if (select available from get_balance_for('ea100000-0000-0000-0000-0000000000a1')) <> v_av then raise exception 'not refunded'; end if;
end $$;
set local role authenticated;
do $$ begin perform reserve_lightning_withdrawal('ea100000-0000-0000-0000-0000000000a1', 'q-3', 1, 0, 1, 'lnbc1', 1, 0, now());
  raise exception 'authenticated reserved'; exception when insufficient_privilege then null; end $$;
reset role;
rollback;
\echo auto_withdraw_test: ok
