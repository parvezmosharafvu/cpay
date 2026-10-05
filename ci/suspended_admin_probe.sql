-- ============================================================
-- What a SUSPENDED admin can do on the withdrawal and account paths
-- ============================================================
-- Prints one line per probe: name|allowed, name|refused or name|absent
-- (the function does not exist on this schema). Run it on the schema
-- before 20261005020000 and after it; ci/suspended_admin_compare.sh then
-- fails if anything is allowed after that was not allowed before, or if
-- the new admin_request_withdrawal_for() is allowed at all. Works on both
-- schemas. Runs inside BEGIN/ROLLBACK.
-- ============================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
\set QUIET on
-- psql -v admin_status=active runs the same probes as an ACTIVE admin: the
-- positive control that shows each probe can see an allowed call.
\if :{?admin_status}
\else
\set admin_status suspended
\endif
begin;

create or replace function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create temp table probe_result (n serial, name text, result text);
grant all on probe_result to authenticated;
grant all on sequence probe_result_n_seq to authenticated;

-- kind: exec  = allowed when the statement does not raise
--       rows  = allowed when it changes at least one row
--       count = allowed when the count it returns is above 0
create function pg_temp.probe(p_name text, p_needs text, p_kind text, p_sql text) returns void language plpgsql as $$
declare v_n bigint;
begin
  if p_needs is not null and to_regprocedure(p_needs) is null then
    insert into probe_result(name, result) values (p_name, 'absent');
    return;
  end if;
  begin
    if p_kind = 'count' then
      execute p_sql into v_n;
    else
      execute p_sql;
      get diagnostics v_n = row_count;
    end if;
    insert into probe_result(name, result)
    values (p_name, case when p_kind = 'exec' or v_n > 0 then 'allowed' else 'refused' end);
  exception when others then
    insert into probe_result(name, result) values (p_name, 'refused');
  end;
end $$;
grant execute on function pg_temp.probe(text, text, text, text) to authenticated;

-- Fixtures: S = suspended admin with a balance and a saved wallet,
-- T = active freelancer with a balance, a saved wallet, a pending
-- application and a pending withdrawal.
insert into auth.users (id, email, raw_user_meta_data) values
  ('5a000000-0000-0000-0000-0000000000a5', 'probe-suspended-admin@test.invalid', '{}'),
  ('5a000000-0000-0000-0000-0000000000f1', 'probe-freelancer@test.invalid', '{}');
update profiles set role = 'admin', account_status = :'admin_status' where id = '5a000000-0000-0000-0000-0000000000a5';
update profiles set account_status = 'active' where id = '5a000000-0000-0000-0000-0000000000f1';
insert into payments (user_id, amount_requested, amount_settled, status, settled_at, expires_at)
select id, 100, 100, 'settled', now(), now() + interval '1 hour'
  from profiles where id in ('5a000000-0000-0000-0000-0000000000a5', '5a000000-0000-0000-0000-0000000000f1');
insert into usdt_wallets (user_id, network, address) values
  ('5a000000-0000-0000-0000-0000000000a5', 'tron', 'TProbeSuspendedAdminXXXXXXXXXXXXXX'),
  ('5a000000-0000-0000-0000-0000000000f1', 'tron', 'TProbeFreelancerXXXXXXXXXXXXXXXXXX');
insert into withdrawals (id, user_id, amount_requested, fee_percent, amount_after_fee, method, destination, status, coin, chain)
values ('5a000000-0000-0000-0000-0000000003f1', '5a000000-0000-0000-0000-0000000000f1', 10, 0, 10,
        'stablecoin', 'TProbeFreelancerXXXXXXXXXXXXXXXXXX', 'pending', 'USDT', 'tron');
select set_config('t.app', (select id::text from account_applications where user_id = '5a000000-0000-0000-0000-0000000000f1'), false) \g /dev/null

select set_config('request.jwt.claim.sub', '5a000000-0000-0000-0000-0000000000a5', true) \g /dev/null
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"5a000000-0000-0000-0000-0000000000a5"}', true) \g /dev/null
set local role authenticated;
do $$
declare
  t constant text := '''5a000000-0000-0000-0000-0000000000f1''';
  s constant text := '''5a000000-0000-0000-0000-0000000000a5''';
begin
  perform pg_temp.probe('is_admin', null, 'count', 'select count(*) from (select 1 where is_admin()) x');
  -- Withdrawals for another account
  perform pg_temp.probe('admin_request_withdrawal_for(other)', 'admin_request_withdrawal_for(uuid,numeric,text,text)', 'exec',
    format('select admin_request_withdrawal_for(%s, 10, ''tron'', '''')', t));
  perform pg_temp.probe('reseller_request_withdrawal_for(other)', 'reseller_request_withdrawal_for(uuid,numeric,text,text)', 'exec',
    format('select reseller_request_withdrawal_for(%s, 10, ''tron'', '''')', t));
  perform pg_temp.probe('system_queue_withdrawal(other)', 'system_queue_withdrawal(uuid)', 'exec',
    format('select system_queue_withdrawal(%s)', t));
  perform pg_temp.probe('insert withdrawal for other', null, 'rows',
    format('insert into withdrawals (user_id, amount_requested, fee_percent, amount_after_fee, method, destination, status, coin, chain) values (%s, 10, 0, 10, ''stablecoin'', ''TProbeFreelancerXXXXXXXXXXXXXXXXXX'', ''pending'', ''USDT'', ''tron'')', t));
  perform pg_temp.probe('approve other withdrawal', null, 'rows',
    'update withdrawals set status = ''approved'' where id = ''5a000000-0000-0000-0000-0000000003f1''');
  perform pg_temp.probe('read other withdrawals', null, 'count',
    format('select count(*) from withdrawals where user_id = %s', t));
  -- Own withdrawal (the account is suspended)
  perform pg_temp.probe('request_withdrawal(own)', 'request_withdrawal(numeric,text,text)', 'exec',
    'select request_withdrawal(10, ''stablecoin'', '''')');
  perform pg_temp.probe('insert withdrawal for self', null, 'rows',
    format('insert into withdrawals (user_id, amount_requested, fee_percent, amount_after_fee, method, destination, status, coin, chain) values (%s, 10, 0, 10, ''stablecoin'', ''TProbeSuspendedAdminXXXXXXXXXXXXXX'', ''pending'', ''USDT'', ''tron'')', s));
  -- Fees, wallets and the reseller switches
  perform pg_temp.probe('admin_update_creator_fee', 'admin_update_creator_fee(uuid,numeric)', 'exec',
    format('select admin_update_creator_fee(%s, 0)', t));
  perform pg_temp.probe('admin_set_default_withdrawal_fee', 'admin_set_default_withdrawal_fee(numeric)', 'exec',
    'select admin_set_default_withdrawal_fee(0)');
  perform pg_temp.probe('admin_set_reseller_withdrawal_fee', 'admin_set_reseller_withdrawal_fee(uuid,numeric)', 'exec',
    format('select admin_set_reseller_withdrawal_fee(%s, 0)', t));
  perform pg_temp.probe('admin_set_reseller_self_withdraw', 'admin_set_reseller_self_withdraw(uuid,boolean)', 'exec',
    format('select admin_set_reseller_self_withdraw(%s, true)', t));
  perform pg_temp.probe('admin_set_user_usdt_wallet', 'admin_set_user_usdt_wallet(uuid,text,text)', 'exec',
    format('select admin_set_user_usdt_wallet(%s, ''tron'', ''TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL'')', t));
  perform pg_temp.probe('admin_withdraw_fee_overview', 'admin_withdraw_fee_overview()', 'exec',
    'select count(*) from admin_withdraw_fee_overview()');
  perform pg_temp.probe('admin_list_user_wallets', 'admin_list_user_wallets()', 'exec',
    'select count(*) from admin_list_user_wallets()');
  perform pg_temp.probe('resolve_withdrawal_fee(other)', 'resolve_withdrawal_fee(uuid)', 'exec',
    format('select resolve_withdrawal_fee(%s)', t));
  perform pg_temp.probe('self_withdraw_allowed(other)', 'self_withdraw_allowed(uuid)', 'exec',
    format('select self_withdraw_allowed(%s)', t));
  -- Account control
  perform pg_temp.probe('reactivate self (update)', null, 'rows',
    format('update profiles set account_status = ''active'' where id = %s', s));
  perform pg_temp.probe('admin_update_account_control(self)', 'admin_update_account_control(uuid,text,text,text)', 'exec',
    format('select admin_update_account_control(%s, ''admin'', ''active'')', s));
  perform pg_temp.probe('admin_review_account_application', 'admin_review_account_application(uuid,text,text)', 'exec',
    format('select admin_review_account_application(%L, ''rejected'', null)', current_setting('t.app')));
  perform pg_temp.probe('admin_list_people', 'admin_list_people()', 'exec', 'select count(*) from admin_list_people()');
end $$;
reset role;
select name || '|' || result from probe_result order by n;
rollback;
