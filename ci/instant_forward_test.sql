-- 20261020030000: instant forward. Default mode changes nothing; in
-- instant_forward mode a settled payment gets exactly one forward row with the
-- fee kept; the balance leaves it out; state machine; retry -> owed; admin
-- release; invariants; refuse policy. BEGIN/ROLLBACK.
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
  ('e8000000-0000-0000-0000-0000000000a1', 'if-addr@test.invalid'),
  ('e8000000-0000-0000-0000-0000000000a2', 'if-noaddr@test.invalid'),
  ('e8000000-0000-0000-0000-0000000000ad', 'if-admin@test.invalid');
update profiles set account_status = 'active' where id::text like 'e8000000-%';
update profiles set role = 'admin' where id = 'e8000000-0000-0000-0000-0000000000ad';
insert into payment_links(id, user_id, slug) values
  ('e8000000-0000-0000-0000-0000000001a1', 'e8000000-0000-0000-0000-0000000000a1', 'if-link-one'),
  ('e8000000-0000-0000-0000-0000000001a2', 'e8000000-0000-0000-0000-0000000000a2', 'if-link-two');

create function pg_temp.pay(p_id text, p_user text, p_link text, p_usd numeric, p_sat bigint) returns void language plpgsql as $$
begin
  insert into payments(id, user_id, payment_link_id, amount_requested, method, status, expires_at, invoice_ref)
  values (p_id::uuid, p_user::uuid, p_link::uuid, p_usd, 'lightning', 'new', now() + interval '15 min', 'if-' || p_id);
  update payments set status = 'settled', amount_settled = p_usd, amount_sat = p_sat, settled_at = now() where id = p_id::uuid;
end $$;

-- 1. Default mode 'balance': no forward rows, money in the balance as before.
do $$ begin
  if payment_mode() <> 'balance' then raise exception 'default mode is not balance'; end if;
end $$;
select pg_temp.pay('e8000000-0000-0000-0000-0000000002a0', 'e8000000-0000-0000-0000-0000000000a1', 'e8000000-0000-0000-0000-0000000001a1', 10, 10000);
do $$ begin
  if exists (select 1 from payment_forwards) then raise exception 'forward row in balance mode'; end if;
  if (select earned from get_balance_for('e8000000-0000-0000-0000-0000000000a1')) <= 0 then raise exception 'balance missing'; end if;
end $$;

-- 2. Saving an address is allowed in instant_forward mode (not in balance mode).
do $$ begin
  perform system_set_settlement_destination('e8000000-0000-0000-0000-0000000000a1', 'me@pay.example.com', 'pay.example.com', 1000, 100000000);
  raise exception 'address saved in balance mode';
exception when raise_exception then if sqlerrm not like 'Direct payments are not available yet%' then raise; end if; end $$;
insert into platform_settings(key, value) values ('payment_mode', '"instant_forward"');
select system_set_settlement_destination('e8000000-0000-0000-0000-0000000000a1', 'me@pay.example.com', 'pay.example.com', 1000, 100000000);
do $$ begin
  if direct_settlement_enabled_for('e8000000-0000-0000-0000-0000000000a1') then raise exception 'instant forward opened direct links'; end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e8000000-0000-0000-0000-0000000000a1', true);
do $$ declare s jsonb := get_my_direct_settlement(); begin
  if (s->>'enabled')::boolean or not (s->>'address_enabled')::boolean or not (s->>'instant_forward')::boolean then
    raise exception 'desk flags wrong: %', s; end if;
end $$;
reset role;
select set_config('request.jwt.claim.sub', '', true);

-- 3. Address still waiting (24 h): policy 'balance' -> no row, stays in balance.
select pg_temp.pay('e8000000-0000-0000-0000-0000000002a1', 'e8000000-0000-0000-0000-0000000000a1', 'e8000000-0000-0000-0000-0000000001a1', 5, 5000);
do $$ begin
  if exists (select 1 from payment_forwards where payment_id = 'e8000000-0000-0000-0000-0000000002a1') then raise exception 'forwarded to a waiting address'; end if;
end $$;
alter table settlement_destinations disable trigger trg_guard_settlement_destination_changes;
update settlement_destinations set ready_at = now() - interval '1 minute' where user_id = 'e8000000-0000-0000-0000-0000000000a1';
alter table settlement_destinations enable trigger trg_guard_settlement_destination_changes;

-- 4. Ready address: one queued row, fee kept, balance excludes it.
update profiles set platform_fee_percent = 3 where id = 'e8000000-0000-0000-0000-0000000000a1';
create temp table b0 as select earned from get_balance_for('e8000000-0000-0000-0000-0000000000a1');
select pg_temp.pay('e8000000-0000-0000-0000-0000000002a2', 'e8000000-0000-0000-0000-0000000000a1', 'e8000000-0000-0000-0000-0000000001a1', 10, 10000);
do $$ declare f payment_forwards; begin
  select * into f from payment_forwards where payment_id = 'e8000000-0000-0000-0000-0000000002a2';
  if f.status <> 'queued' or f.gross_sat <> 10000 or f.fee_sat <> 300 or f.forward_sat <> 9700
     or f.address <> 'me@pay.example.com' or f.fee_usd <> 0.30 then raise exception 'bad row %', to_jsonb(f); end if;
  if (select earned from get_balance_for('e8000000-0000-0000-0000-0000000000a1')) <> (select earned from b0) then
    raise exception 'forwarded payment counted in the balance'; end if;
end $$;

-- 5. Double-forward prevention: re-settling or a second insert gives no second row.
-- (settled -> other is refused by enforce_payment_status_transition, so the
-- trigger fires once; the unique key is the backstop.)
do $$ begin
  update payments set status = 'pending' where id = 'e8000000-0000-0000-0000-0000000002a2';
  raise exception 'settled payment re-opened';
exception when others then if sqlerrm not like '%invalid status transition%' then raise; end if; end $$;
do $$ begin
  if (select count(*) from payment_forwards where payment_id = 'e8000000-0000-0000-0000-0000000002a2') <> 1 then raise exception 'second forward row'; end if;
  begin
    insert into payment_forwards(payment_id, user_id, gross_sat, fee_sat, forward_sat, status)
    values ('e8000000-0000-0000-0000-0000000002a2', 'e8000000-0000-0000-0000-0000000000a1', 1, 0, 1, 'queued');
    raise exception 'duplicate insert allowed';
  exception when unique_violation then null; end;
end $$;

-- 6. Claim: once only (sending), not claimable twice; finish is idempotent.
do $$ declare n int; m int; begin
  select count(*) into n from system_forward_claim(10);
  select count(*) into m from system_forward_claim(10);
  if n <> 1 or m <> 0 then raise exception 'claimed % then %', n, m; end if;
end $$;
do $$ declare fid uuid := (select id from payment_forwards where payment_id = 'e8000000-0000-0000-0000-0000000002a2'); begin
  begin perform system_forward_finish(fid, 'forwarded', 9700, 5, 'pay-1'); raise exception 'over-send accepted';
  exception when raise_exception then if sqlerrm not like 'Forward amounts%' then raise; end if; end;
  if system_forward_finish(fid, 'forwarded', 9690, 8, 'pay-1') <> 'forwarded' then raise exception 'not forwarded'; end if;
  if system_forward_finish(fid, 'retry', null, null, null, 'late') <> 'forwarded' then raise exception 'finish not idempotent'; end if;
  if (select remainder_sat from payment_forwards where payment_forwards.id = fid) <> 2 then raise exception 'remainder wrong'; end if;
  begin update payment_forwards set status = 'owed' where payment_forwards.id = fid; raise exception 'final row changed';
  exception when raise_exception then if sqlerrm not like 'payment_forwards:%' then raise; end if; end;
  begin update payment_forwards set forward_sat = 1 where payment_forwards.id = fid; raise exception 'amount changed';
  exception when raise_exception then if sqlerrm not like 'payment_forwards:%' then raise; end if; end;
  begin delete from payment_forwards where payment_forwards.id = fid; raise exception 'deleted';
  exception when raise_exception then if sqlerrm not like 'payment_forwards rows are never deleted%' then raise; end if; end;
end $$;

-- 7. Partial failure: retries with backoff, then owed after max attempts.
insert into platform_settings(key, value) values ('instant_forward_max_attempts', '2');
select pg_temp.pay('e8000000-0000-0000-0000-0000000002a3', 'e8000000-0000-0000-0000-0000000000a1', 'e8000000-0000-0000-0000-0000000001a1', 2, 2000);
do $$ declare fid uuid := (select id from payment_forwards where payment_id = 'e8000000-0000-0000-0000-0000000002a3'); begin
  perform system_forward_claim(10);
  if system_forward_finish(fid, 'retry', null, null, null, 'no route') <> 'retry' then raise exception 'not retry'; end if;
  if (select next_attempt_at from payment_forwards where payment_forwards.id = fid) <= now() then raise exception 'no backoff'; end if;
  if exists (select 1 from system_forward_claim(10)) then raise exception 'claimed before backoff'; end if;
  update payment_forwards set next_attempt_at = now() - interval '1 second' where payment_forwards.id = fid;
  if (select count(*) from system_forward_claim(10)) <> 1 then raise exception 'not reclaimed'; end if;
  if system_forward_finish(fid, 'retry', null, null, null, 'no route') <> 'owed' then raise exception 'not owed after max'; end if;
  if (select reason from payment_forwards where payment_forwards.id = fid) <> 'failed' then raise exception 'reason'; end if;
  if (select earned from get_balance_for('e8000000-0000-0000-0000-0000000000a1')) <> (select earned from b0) then
    raise exception 'owed counted in balance'; end if;
  if forwards_owed_usd() <> 1.94 then raise exception 'owed usd %', forwards_owed_usd(); end if;
end $$;

-- 8. Below minimum and over limit are held; no address with policy refuse.
insert into platform_settings(key, value) values ('instant_forward_max_usd', '50');
select pg_temp.pay('e8000000-0000-0000-0000-0000000002a4', 'e8000000-0000-0000-0000-0000000000a1', 'e8000000-0000-0000-0000-0000000001a1', 0.05, 50);
select pg_temp.pay('e8000000-0000-0000-0000-0000000002a5', 'e8000000-0000-0000-0000-0000000000a1', 'e8000000-0000-0000-0000-0000000001a1', 100, 100000);
do $$ begin
  if (select reason from payment_forwards where payment_id = 'e8000000-0000-0000-0000-0000000002a4') <> 'below_minimum' then raise exception 'dust not held'; end if;
  if (select reason from payment_forwards where payment_id = 'e8000000-0000-0000-0000-0000000002a5') <> 'over_limit' then raise exception 'limit not held'; end if;
end $$;
select pg_temp.pay('e8000000-0000-0000-0000-0000000002a6', 'e8000000-0000-0000-0000-0000000000a2', 'e8000000-0000-0000-0000-0000000001a2', 3, 3000);
do $$ begin
  if exists (select 1 from payment_forwards where payment_id = 'e8000000-0000-0000-0000-0000000002a6') then raise exception 'no-address row under balance policy'; end if;
end $$;
insert into platform_settings(key, value) values ('instant_forward_no_address', '"refuse"');
do $$ begin
  insert into payments(user_id, payment_link_id, amount_requested, method, status, expires_at, invoice_ref)
  values ('e8000000-0000-0000-0000-0000000000a2', 'e8000000-0000-0000-0000-0000000001a2', 3, 'lightning', 'new', now() + interval '15 min', 'if-refused');
  raise exception 'payment accepted under refuse';
exception when raise_exception then if sqlerrm not like 'This link is not taking payments%' then raise; end if; end $$;

-- 9. Mode off again: nothing is claimed.
update platform_settings set value = '"balance"' where key = 'payment_mode';
update payment_forwards set status = 'queued' where payment_id = 'e8000000-0000-0000-0000-0000000002a5';
do $$ begin if exists (select 1 from system_forward_claim(10)) then raise exception 'claimed while off'; end if; end $$;
update platform_settings set value = '"instant_forward"' where key = 'payment_mode';
update payment_forwards set status = 'owed' where payment_id = 'e8000000-0000-0000-0000-0000000002a5' and status = 'queued';

-- 10. Invariant holds.
do $$ declare r jsonb := instant_forward_invariants(); begin
  if not (r->>'ok')::boolean then raise exception 'invariant broken %', r; end if;
end $$;

-- 11. Admin: needs aal2; release puts it back in the balance; retry re-queues.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e8000000-0000-0000-0000-0000000000ad', true);
do $$ begin
  if jsonb_array_length(admin_list_forwards()->'rows') < 4 then raise exception 'admin list short'; end if;
  perform admin_forward_action((select id from payment_forwards where payment_id = 'e8000000-0000-0000-0000-0000000002a4'), 'release');
  raise exception 'no aal2 accepted';
exception when raise_exception then if sqlerrm not like 'Enter your authenticator code%' then raise; end if; end $$;
select set_config('request.jwt.claims', '{"aal":"aal2"}', true);
select admin_forward_action((select id from payment_forwards where payment_id = 'e8000000-0000-0000-0000-0000000002a4'), 'release');
select admin_forward_action((select id from payment_forwards where payment_id = 'e8000000-0000-0000-0000-0000000002a3'), 'retry');
do $$ begin
  if (select status from payment_forwards where payment_id = 'e8000000-0000-0000-0000-0000000002a3') <> 'queued' then raise exception 'retry not queued'; end if;
  if not exists (select 1 from jsonb_array_elements(admin_system_alerts()->'alerts') a where a->>'code' = 'forward_owed') then raise exception 'no alert'; end if;
end $$;
select set_config('request.jwt.claim.sub', 'e8000000-0000-0000-0000-0000000000a2', true);
do $$ begin
  perform admin_list_forwards(); raise exception 'non-admin listed';
exception when raise_exception then if sqlerrm not like 'Not authorized%' then raise; end if; end $$;
do $$ begin if exists (select 1 from payment_forwards) then raise exception 'other user sees forwards'; end if; end $$;
reset role;
do $$ begin
  if (select earned from get_balance_for('e8000000-0000-0000-0000-0000000000a1')) <> (select earned from b0) + 0.05 then
    raise exception 'released not in balance'; end if;
end $$;
rollback;
\echo instant forward OK
