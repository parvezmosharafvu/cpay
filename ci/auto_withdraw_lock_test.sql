-- 20261028040000: Auto withdraw "Lock off". Locking turns the global switch
-- off and every profile to balance (a profile's own "on" included); while
-- locked nothing can turn it on; only an admin with a passkey/aal2 session
-- can lock or unlock; both are audited; unlocking gives profiles back their
-- own setting. BEGIN/ROLLBACK.
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
  ('eb100000-0000-0000-0000-0000000000a1', 'lock-a@test.invalid'),
  ('eb100000-0000-0000-0000-0000000000b1', 'lock-b@test.invalid'),
  ('eb100000-0000-0000-0000-0000000000ad', 'lock-admin@test.invalid');
update profiles set account_status = 'active' where id::text like 'eb100000-%';
update profiles set role = 'admin' where id = 'eb100000-0000-0000-0000-0000000000ad';

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

-- 1. Global on, A has its own "on".
set local role authenticated;
do $$ begin
  perform pg_temp.as_claims('eb100000-0000-0000-0000-0000000000ad', '{"aal":"aal2"}');
  perform admin_set_auto_withdraw_global(true);
  perform admin_set_auto_withdraw('eb100000-0000-0000-0000-0000000000a1', 'on');
end $$;
-- 2. Only a strong admin session can lock.
do $$ begin
  perform pg_temp.as_claims('eb100000-0000-0000-0000-0000000000ad', '{"aal":"aal1"}');
  perform pg_temp.refused($q$select admin_lock_auto_withdraw(true)$q$, 'Sign in again with your passkey%');
  perform pg_temp.as_claims('eb100000-0000-0000-0000-0000000000b1', '{"aal":"aal2"}');
  perform pg_temp.refused($q$select admin_lock_auto_withdraw(true)$q$, 'Not authorized');
end $$;
-- 3. Lock: global off, everyone balance, nothing can turn it on.
do $$ declare r jsonb; o jsonb; begin
  perform pg_temp.as_claims('eb100000-0000-0000-0000-0000000000ad', '{"aal":"aal2"}');
  r := admin_lock_auto_withdraw(true);
  if not (r->>'locked_off')::boolean or r->>'payment_mode' <> 'balance' then raise exception 'lock %', r; end if;
  o := admin_auto_withdraw_overview();
  if not (o->>'locked_off')::boolean or (o->>'global')::boolean then raise exception 'overview %', o; end if;
  perform pg_temp.refused($q$select admin_set_auto_withdraw_global(true)$q$, 'Auto withdraw is locked off%');
  perform pg_temp.refused($q$select admin_set_auto_withdraw('eb100000-0000-0000-0000-0000000000b1', 'on')$q$, 'Auto withdraw is locked off%');
  perform admin_set_auto_withdraw('eb100000-0000-0000-0000-0000000000b1', 'off');
  perform admin_set_auto_withdraw('eb100000-0000-0000-0000-0000000000b1', 'default');
end $$;
reset role;
do $$ begin
  if payment_mode() <> 'balance' then raise exception 'global not off'; end if;
  if payment_mode_for('eb100000-0000-0000-0000-0000000000a1') <> 'balance' then raise exception 'A own on beat the lock'; end if;
  if payment_mode_for('eb100000-0000-0000-0000-0000000000b1') <> 'balance' then raise exception 'B not balance'; end if;
  if not exists (select 1 from audit_log where action = 'auto_withdraw.lock'
                 and new_value->>'locked_off' = 'true') then raise exception 'lock not audited'; end if;
end $$;

-- 3b. A signed-in admin cannot change or delete the rows directly.
set local role authenticated;
do $$ begin
  perform pg_temp.as_claims('eb100000-0000-0000-0000-0000000000ad', '{"aal":"aal2"}');
  begin
    delete from app_settings where key = 'auto_withdraw_locked_off';
    if found then raise exception 'direct delete of the lock allowed'; end if;
  exception when raise_exception or insufficient_privilege then
    if sqlerrm = 'direct delete of the lock allowed' then raise; end if;
  end;
  begin
    update app_settings set value = 'true' where key = 'auto_approve_freelancer';
    if found then raise exception 'direct update of auto approve allowed'; end if;
  exception when raise_exception or insufficient_privilege then
    if sqlerrm = 'direct update of auto approve allowed' then raise; end if;
  end;
end $$;
reset role;
do $$ begin
  if not auto_withdraw_locked() then raise exception 'lock row gone'; end if;
end $$;

-- 4. Unlock: A's own "on" counts again; the global switch stays off.
set local role authenticated;
do $$ begin
  perform pg_temp.as_claims('eb100000-0000-0000-0000-0000000000ad', '{"aal":"aal2"}');
  perform admin_lock_auto_withdraw(false);
end $$;
reset role;
do $$ begin
  if auto_withdraw_locked() then raise exception 'still locked'; end if;
  if payment_mode() <> 'balance' then raise exception 'unlock turned global on'; end if;
  if payment_mode_for('eb100000-0000-0000-0000-0000000000a1') <> 'instant_forward' then raise exception 'A own on lost'; end if;
  if not exists (select 1 from audit_log where action = 'auto_withdraw.lock'
                 and new_value->>'locked_off' = 'false') then raise exception 'unlock not audited'; end if;
end $$;

rollback;
\echo 'auto withdraw lock: OK'
