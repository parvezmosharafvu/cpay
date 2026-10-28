-- 20261028050000: Manual payouts only. Only an admin with a passkey/aal2
-- session can turn it on (audited); on locks auto withdraw off; a user can
-- then send a withdrawal request (a 'pending' row that holds the amount)
-- but no instant withdrawal; requests need it on, enough balance and a
-- method; the admin closes a request as paid. BEGIN/ROLLBACK.
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
  ('ec100000-0000-0000-0000-0000000000a1', 'mp-user@test.invalid'),
  ('ec100000-0000-0000-0000-0000000000ad', 'mp-admin@test.invalid');
update profiles set account_status = 'active' where id::text like 'ec100000-%';
update profiles set role = 'admin' where id = 'ec100000-0000-0000-0000-0000000000ad';
insert into payment_links(id, user_id, slug)
values ('ec100000-0000-0000-0000-0000000001a1', 'ec100000-0000-0000-0000-0000000000a1', 'mp-link');

create function pg_temp.as_claims(p_sub text, p_claims text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_sub, true), set_config('request.jwt.claims', p_claims, true);
$$;
create function pg_temp.refused(p_sql text, p_like text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm not like p_like then
      raise exception 'expected "%" from: %, got: %', p_like, p_sql, sqlerrm;
    end if;
    return;
  end;
  raise exception 'not refused: %', p_sql;
end $$;
grant execute on function pg_temp.as_claims(text, text) to authenticated;
grant execute on function pg_temp.refused(text, text) to authenticated;

-- 1. Off: no requests. Turning it on needs a strong admin session.
set local role authenticated;
do $$ begin
  perform pg_temp.as_claims('ec100000-0000-0000-0000-0000000000a1', '{"aal":"aal1"}');
  perform pg_temp.refused($q$select request_manual_withdrawal(10, 'lightning', 'me@ln.test')$q$, '%only used while payouts are paid by hand%');
  perform pg_temp.refused($q$select admin_set_manual_payouts(true)$q$, 'Not authorized');
  perform pg_temp.as_claims('ec100000-0000-0000-0000-0000000000ad', '{"aal":"aal1"}');
  perform pg_temp.refused($q$select admin_set_manual_payouts(true)$q$, 'Sign in again with your passkey%');
end $$;
-- 2. On: auto withdraw locked off, audited.
do $$ declare r jsonb; begin
  perform pg_temp.as_claims('ec100000-0000-0000-0000-0000000000ad', '{"aal":"aal2"}');
  r := admin_set_manual_payouts(true);
  if not (r->>'manual_payouts_only')::boolean or not (r->>'auto_withdraw_locked_off')::boolean then raise exception 'on %', r; end if;
end $$;
-- 2b. Not by a direct table write.
do $$ begin
  perform pg_temp.as_claims('ec100000-0000-0000-0000-0000000000ad', '{"aal":"aal2"}');
  begin
    delete from app_settings where key = 'manual_payouts_only';
    if found then raise exception 'direct delete allowed'; end if;
  exception when raise_exception or insufficient_privilege then
    if sqlerrm = 'direct delete allowed' then raise; end if;
  end;
end $$;
reset role;
do $$ begin
  if not manual_payouts_only() then raise exception 'not on'; end if;
  if payment_mode_for('ec100000-0000-0000-0000-0000000000a1') <> 'balance' then raise exception 'payments not to balance'; end if;
  if not exists (select 1 from audit_log where action = 'payouts.manual_only' and new_value->>'on' = 'true') then
    raise exception 'not audited';
  end if;
end $$;

-- 3. The user has $20 settled into the balance.
insert into payments(id, user_id, payment_link_id, amount_requested, method, status, expires_at, invoice_ref)
values ('ec100000-0000-0000-0000-0000000002a1', 'ec100000-0000-0000-0000-0000000000a1', 'ec100000-0000-0000-0000-0000000001a1',
        20, 'lightning', 'new', now() + interval '15 min', 'mp-1');
update payments set status = 'settled', amount_settled = 20, amount_sat = 30000, settled_at = now()
 where id = 'ec100000-0000-0000-0000-0000000002a1';

-- 4. A request needs a passkey session and holds the amount; bad requests
--    and instant withdrawals are refused.
set local role authenticated;
do $$ declare w withdrawals; before numeric; after numeric; begin
  perform pg_temp.as_claims('ec100000-0000-0000-0000-0000000000a1', '{"aal":"aal1"}');
  perform pg_temp.refused($q$select request_manual_withdrawal(10, 'lightning', 'me@ln.test')$q$, 'Confirm with your passkey%');
  perform pg_temp.as_claims('ec100000-0000-0000-0000-0000000000a1', '{"aal":"aal2"}');
  select available into before from get_my_balance();
  perform pg_temp.refused($q$select request_manual_withdrawal(10, 'bank', 'x@y.test')$q$, 'Choose how you want to be paid');
  perform pg_temp.refused($q$select request_manual_withdrawal(4, 'lightning', 'me@ln.test')$q$, 'Minimum withdrawal is $5');
  perform pg_temp.refused($q$select request_manual_withdrawal(10, 'lightning', '')$q$, 'Enter where to send the money');
  perform pg_temp.refused($q$select request_manual_withdrawal(9999, 'lightning', 'me@ln.test')$q$, 'Insufficient balance%');
  w := request_manual_withdrawal(10, 'lightning', '  me@ln.test ');
  if w.status <> 'pending' or w.destination <> 'me@ln.test' or w.amount_after_fee <> round(10 * (1 - w.fee_percent / 100), 2) then
    raise exception 'request row %', row_to_json(w);
  end if;
  select available into after from get_my_balance();
  if after <> before - 10 then raise exception 'not held: % -> %', before, after; end if;
  w := request_manual_withdrawal(5, 'lightning', 'lnbc' || repeat('x', 400));
  if w.status <> 'pending' then raise exception 'long invoice refused'; end if;
end $$;
-- 4b. Auto withdraw cannot be unlocked while manual payouts are on.
do $$ begin
  perform pg_temp.as_claims('ec100000-0000-0000-0000-0000000000ad', '{"aal":"aal2"}');
  perform pg_temp.refused($q$select admin_lock_auto_withdraw(false)$q$, 'Manual payouts only is on%');
end $$;
reset role;
do $$ begin
  insert into withdrawals(user_id, amount_requested, fee_percent, amount_after_fee, method, destination, status)
  values ('ec100000-0000-0000-0000-0000000000a1', 5, 0, 5, 'lightning', 'me@ln.test', 'sending');
  raise exception 'instant withdrawal accepted';
exception when raise_exception then
  if sqlerrm not like 'Withdrawals are paid by hand now%' then raise; end if;
end $$;

-- 5. The admin pays it by hand and closes it as paid.
do $$ declare v_id uuid := (select w.id from withdrawals w where w.user_id = 'ec100000-0000-0000-0000-0000000000a1' and w.status = 'pending' and w.amount_requested = 10); begin
  if not system_claim_withdrawal(v_id, 'paid') then raise exception 'claim failed'; end if;
  if (select status from withdrawals where withdrawals.id = v_id) <> 'paid' then raise exception 'not paid'; end if;
end $$;

rollback;
\echo 'manual payouts: OK'
