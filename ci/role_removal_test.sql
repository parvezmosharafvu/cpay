-- ============================================================
-- Two account types: freelancer and admin (20261005020000)
-- ============================================================
-- Replaces ci/reseller_authz_test.sql. Checks that the reseller role and
-- everything only it used are gone, that sign-up, approval and role
-- changes only produce freelancers and admins, that link pricing has no
-- lock and no team price, that the withdrawal fee is the account's own
-- override else the global default, that the new admin withdraw-on-behalf
-- function is admin-only and keeps every withdrawal check, and that the
-- access people use still works (own payments and marks, admin tools,
-- lockout guards, the invoice page). Runs on both CI databases (plain and
-- Supabase default privileges) inside BEGIN/ROLLBACK.
-- ============================================================
\set ON_ERROR_STOP on
begin;

create or replace function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create function pg_temp.act(p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
  perform set_config('request.jwt.claims',
    case when p_sub is null then '{"role":"anon"}'
         else json_build_object('role', 'authenticated', 'sub', p_sub)::text end, true);
end $$;
grant execute on function pg_temp.act(text) to anon, authenticated, service_role;

-- Expect p_sql to fail with a message like p_like.
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
  raise exception 'accepted, expected "%": %', p_like, p_sql;
end $$;
grant execute on function pg_temp.refused(text, text) to anon, authenticated, service_role;

--   ad, a2 = active admins   a5 = suspended admin
--   fa, fb = active freelancers   fp = pending freelancer
insert into auth.users(id, email, raw_user_meta_data) values
  ('5c000000-0000-0000-0000-0000000000ad', 'role-admin@test.invalid', '{}'),
  ('5c000000-0000-0000-0000-0000000000a2', 'role-admin-two@test.invalid', '{}'),
  ('5c000000-0000-0000-0000-0000000000a5', 'role-admin-suspended@test.invalid', '{}'),
  ('5c000000-0000-0000-0000-0000000000fa', 'role-freelancer-a@test.invalid', '{}'),
  ('5c000000-0000-0000-0000-0000000000fb', 'role-freelancer-b@test.invalid', '{}'),
  ('5c000000-0000-0000-0000-0000000000f0', 'role-freelancer-pending@test.invalid', '{}');
update profiles set account_status = 'active' where id::text like '5c000000-%' and id <> '5c000000-0000-0000-0000-0000000000f0';
update profiles set role = 'admin' where id in ('5c000000-0000-0000-0000-0000000000ad', '5c000000-0000-0000-0000-0000000000a2', '5c000000-0000-0000-0000-0000000000a5');
update profiles set account_status = 'suspended' where id = '5c000000-0000-0000-0000-0000000000a5';

insert into payment_links (id, user_id, slug, display_name) values
  ('5c000000-0000-0000-0000-0000000001fa', '5c000000-0000-0000-0000-0000000000fa', 'role-a-link', 'A'),
  ('5c000000-0000-0000-0000-0000000001fb', '5c000000-0000-0000-0000-0000000000fb', 'role-b-link', 'B');
insert into payments (id, user_id, payment_link_id, amount_requested, method, status, expires_at, invoice_ref)
values ('5c000000-0000-0000-0000-0000000002fa', '5c000000-0000-0000-0000-0000000000fa', '5c000000-0000-0000-0000-0000000001fa',
        200, 'lightning', 'new', now() + interval '15 min', 'role-invoice-ref-a'),
       ('5c000000-0000-0000-0000-0000000002fb', '5c000000-0000-0000-0000-0000000000fb', '5c000000-0000-0000-0000-0000000001fb',
        50, 'lightning', 'new', now() + interval '15 min', 'role-invoice-ref-b');
update payments set status = 'settled', amount_settled = amount_requested, settled_at = now() where id::text like '5c000000-%';

-- ------------------------------------------------------------
-- 1. Nothing of the reseller role is left
-- ------------------------------------------------------------
do $$
declare v text;
begin
  select string_agg(relname, ', ') into v from pg_class where relnamespace = 'public'::regnamespace
     and relname in ('reseller_settings', 'moderator_assignments', 'reseller_notices', 'team_messages', 'reseller_alert_channels');
  if v is not null then raise exception 'reseller table(s) left: %', v; end if;
  select string_agg(column_name, ', ') into v from information_schema.columns
   where table_schema = 'public' and table_name = 'profiles'
     and column_name in ('referred_by', 'affiliate_code', 'cost_locked', 'team_cost_percent');
  if v is not null then raise exception 'reseller profile column(s) left: %', v; end if;
  select string_agg(tgname, ', ') into v from pg_trigger
   where tgname in ('trg_reseller_affiliate_code', 'trg_clear_link_costs_on_lock', 'trg_guard_withdrawal_self_allowed');
  if v is not null then raise exception 'reseller trigger(s) left: %', v; end if;
  select string_agg(p.oid::regprocedure::text, ', ') into v from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and (p.proname ~ '(reseller|moderator|affiliate|team_|staff_|handles_creator|link_update_is_lock_clear|clear_link_costs_on_lock|self_withdraw_off_message|enqueue_daily_close)'
          or p.proname in ('admin_set_domain_owner', 'admin_assign_creator', 'admin_list_staff'));
  if v is not null then raise exception 'reseller function(s) left: %', v; end if;
  select string_agg(p.oid::regprocedure::text, ', ') into v from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.prosrc ~* 'reseller|moderator|referred_by|affiliate|team_cost|cost_locked'
     and p.oid::regprocedure::text not in ('validate_link_slug()');
  if v is not null then raise exception 'function body still mentions the reseller role: %', v; end if;
  select string_agg(key, ', ') into v from app_settings
   where key in ('auto_approve_reseller', 'feature_affiliate_enabled', 'feature_reseller_team_withdraw', 'feature_reseller_notices');
  if v is not null then raise exception 'reseller setting(s) left: %', v; end if;
  if pg_get_constraintdef((select oid from pg_constraint where conname = 'profiles_role_check')) ~ 'moderator' then
    raise exception 'profiles_role_check still allows moderator';
  end if;
  raise notice 'ok: no reseller tables, columns, triggers, functions, settings or role';
end $$;

do $$
begin
  perform pg_temp.refused($q$update profiles set role = 'moderator' where id = '5c000000-0000-0000-0000-0000000000fa'$q$, '%profiles_role_check%');
  perform pg_temp.refused($q$update account_applications set requested_role = 'reseller' where user_id = '5c000000-0000-0000-0000-0000000000fa'$q$, '%requested_role_check%');
  raise notice 'ok: the moderator role and reseller applications are refused by constraints';
end $$;

-- ------------------------------------------------------------
-- 2. Sign-up is always a freelancer
-- ------------------------------------------------------------
do $$
declare r record;
begin
  insert into app_settings (key, value) values ('auto_approve_freelancer', 'false')
  on conflict (key) do update set value = excluded.value;
  insert into auth.users (id, email, raw_user_meta_data) values
    ('5c000000-0000-0000-0000-0000000000e1', 'role-signup-reseller@test.invalid',
     '{"requested_role": "reseller", "affiliate_code": "rcode123", "display_name": "Wants Reseller"}');
  select p.role, p.account_status, a.requested_role, a.status into r
    from profiles p join account_applications a on a.user_id = p.id
   where p.id = '5c000000-0000-0000-0000-0000000000e1';
  if r.role <> 'creator' or r.account_status <> 'pending' or r.requested_role <> 'freelancer' or r.status <> 'pending' then
    raise exception 'signup asking for reseller: %', row_to_json(r);
  end if;
  update app_settings set value = 'true' where key = 'auto_approve_freelancer';
  insert into auth.users (id, email, raw_user_meta_data) values
    ('5c000000-0000-0000-0000-0000000000e2', 'role-signup-auto@test.invalid', '{}');
  select p.role, p.account_status, a.status into r
    from profiles p join account_applications a on a.user_id = p.id
   where p.id = '5c000000-0000-0000-0000-0000000000e2';
  if r.role <> 'creator' or r.account_status <> 'active' or r.status <> 'approved' then
    raise exception 'auto-approved signup: %', row_to_json(r);
  end if;
  if cpay_auto_approval_enabled('reseller') is distinct from cpay_auto_approval_enabled('freelancer') then
    raise exception 'auto-approval still depends on the role';
  end if;
  update app_settings set value = 'false' where key = 'auto_approve_freelancer';
  raise notice 'ok: sign-up asking for reseller with a code becomes a pending freelancer; auto-approve uses the freelancer flag';
end $$;

-- ------------------------------------------------------------
-- 3. Admin role tools: freelancer or admin only
-- ------------------------------------------------------------
do $$ begin perform pg_temp.act('5c000000-0000-0000-0000-0000000000ad'); end $$;
set local role authenticated;
do $$
begin
  perform pg_temp.refused($q$select admin_set_role('5c000000-0000-0000-0000-0000000000fb', 'moderator')$q$, 'Unknown role');
  perform pg_temp.refused($q$select admin_update_account_control('5c000000-0000-0000-0000-0000000000fb', 'moderator', 'active')$q$, 'Invalid role');
  perform pg_temp.refused($q$select admin_set_auto_approval('reseller', true)$q$, 'Invalid application role');
  perform pg_temp.refused($q$select admin_set_feature_toggle('feature_reseller_team_withdraw', true)$q$, 'Unknown toggle');
  perform admin_set_role('5c000000-0000-0000-0000-0000000000fb', 'admin');
  perform admin_set_role('5c000000-0000-0000-0000-0000000000fb', 'creator');
  perform admin_update_account_control('5c000000-0000-0000-0000-0000000000fb', 'creator', 'active');
  perform admin_set_auto_approval('freelancer', false);
  raise notice 'ok: admins set creator/admin only; reseller toggles unknown';
end $$;
reset role;
do $$
declare v_app uuid := (select id from account_applications where user_id = '5c000000-0000-0000-0000-0000000000f0');
begin
  perform pg_temp.act('5c000000-0000-0000-0000-0000000000ad');
  perform admin_review_account_application(v_app, 'approved', null);
  if (select role || '/' || account_status from profiles where id = '5c000000-0000-0000-0000-0000000000f0') <> 'creator/active'
     or (select status from account_applications where id = v_app) <> 'approved' then
    raise exception 'approval did not produce an active freelancer';
  end if;
  perform admin_review_account_application(
    (select id from account_applications where user_id = '5c000000-0000-0000-0000-0000000000a2'), 'rejected', null);
  if (select role from profiles where id = '5c000000-0000-0000-0000-0000000000a2') <> 'admin' then
    raise exception 'an application decision demoted an admin';
  end if;
  update profiles set account_status = 'active' where id = '5c000000-0000-0000-0000-0000000000a2';
  update profiles set account_status = 'pending' where id = '5c000000-0000-0000-0000-0000000000f0';
  perform pg_temp.act(null);
  raise notice 'ok: approving an application makes an active freelancer; a decision never demotes an admin';
end $$;

-- ------------------------------------------------------------
-- 4. Link pricing: no lock, no team price, owner or admin only
-- ------------------------------------------------------------
do $$ begin perform pg_temp.act('5c000000-0000-0000-0000-0000000000fa'); end $$;
set local role authenticated;
do $$
begin
  perform set_my_cost_percent(3.5);
  perform set_link_cost_percent('5c000000-0000-0000-0000-0000000001fa', 7);
  perform set_payment_link_theme('5c000000-0000-0000-0000-0000000001fa', 'classic');
  perform set_payment_link_experience('5c000000-0000-0000-0000-0000000001fa', 'tile', null, null);
  perform pg_temp.refused($q$select set_link_cost_percent('5c000000-0000-0000-0000-0000000001fb', 1)$q$, 'Not authorized');
  perform pg_temp.refused($q$select set_payment_link_theme('5c000000-0000-0000-0000-0000000001fb', 'classic')$q$, 'Not authorized');
  perform pg_temp.refused($q$select set_payment_link_experience('5c000000-0000-0000-0000-0000000001fb', 'tile', null, null)$q$, 'Not authorized');
  perform pg_temp.refused($q$select * from daily_link_breakdown(3, '5c000000-0000-0000-0000-0000000000fb')$q$, 'Not authorized');
  perform pg_temp.refused($q$update profiles set role = 'admin' where id = auth.uid()$q$, '%');
  raise notice 'ok: a freelancer prices its own account and links freely (no lock), never another account''s';
end $$;
reset role;
do $$
begin
  -- The guards themselves (table grants differ between the two CI
  -- databases, so these run as the owner with the freelancer's session).
  perform pg_temp.act('5c000000-0000-0000-0000-0000000000fa');
  update payment_links set cost_percent = 8 where id = '5c000000-0000-0000-0000-0000000001fa';
  update payment_links set cost_percent = null where id = '5c000000-0000-0000-0000-0000000001fa';
  perform pg_temp.refused($q$update profiles set cost_percent = 9 where id = '5c000000-0000-0000-0000-0000000000fb'$q$, 'Only an admin can set another account''s cost rate');
  perform pg_temp.refused($q$update profiles set account_status = 'suspended' where id = '5c000000-0000-0000-0000-0000000000fa'$q$, 'You cannot change your own role or account status');
  perform pg_temp.refused($q$update payment_links set user_id = '5c000000-0000-0000-0000-0000000000fa' where id = '5c000000-0000-0000-0000-0000000001fb'$q$, 'Cannot change link owner');
  perform pg_temp.act('5c000000-0000-0000-0000-0000000000ad');
  perform set_link_cost_percent('5c000000-0000-0000-0000-0000000001fb', 2);
  update profiles set cost_percent = 1 where id = '5c000000-0000-0000-0000-0000000000fb';
  perform pg_temp.act(null);
  if (select cost_percent from payment_links where id = '5c000000-0000-0000-0000-0000000001fb') <> 2
     or (select cost_percent from profiles where id = '5c000000-0000-0000-0000-0000000000fa') <> 3.5 then
    raise exception 'pricing not saved';
  end if;
  raise notice 'ok: profile and link guards: no cross-account pricing, no own role/status change; an admin prices any account';
end $$;

-- ------------------------------------------------------------
-- 5. Withdrawal fee: own override, else the global default, else 0
-- ------------------------------------------------------------
do $$
declare r record; v jsonb;
begin
  insert into app_settings (key, value) values ('default_withdrawal_fee_percent', '{"percent": 2.5}')
  on conflict (key) do update set value = excluded.value;
  update profiles set withdrawal_fee_percent = 1 where id = '5c000000-0000-0000-0000-0000000000fb';
  select * into r from withdrawal_fee_resolution('5c000000-0000-0000-0000-0000000000fb');
  if r.fee_percent <> 1 or r.source <> 'account' then raise exception 'own fee: %', row_to_json(r); end if;
  select * into r from withdrawal_fee_resolution('5c000000-0000-0000-0000-0000000000fa');
  if r.fee_percent <> 2.5 or r.source <> 'global' then raise exception 'global fee: %', row_to_json(r); end if;
  if resolve_withdrawal_fee('5c000000-0000-0000-0000-0000000000fa') <> 2.5 then raise exception 'resolve_withdrawal_fee disagrees'; end if;
  delete from app_settings where key = 'default_withdrawal_fee_percent';
  select * into r from withdrawal_fee_resolution('5c000000-0000-0000-0000-0000000000fa');
  if r.fee_percent <> 0 or r.source <> 'none' then raise exception 'no fee: %', row_to_json(r); end if;
  insert into app_settings (key, value) values ('default_withdrawal_fee_percent', '{"percent": 2.5}');

  perform pg_temp.act('5c000000-0000-0000-0000-0000000000fa');
  v := my_withdraw_settings();
  if v->>'fee_source' <> 'global' or (v->>'fee_percent')::numeric <> 2.5 or (v->>'global_fee_percent')::numeric <> 2.5
     or (v->>'self_withdraw_allowed')::boolean is not true
     or v ? 'has_reseller' or v ? 'team_withdraw_enabled' or v ? 'reseller' then
    raise exception 'my_withdraw_settings: %', v;
  end if;
  perform pg_temp.act(null);
  if not self_withdraw_allowed('5c000000-0000-0000-0000-0000000000fa') then raise exception 'compat shim is not true'; end if;
  raise notice 'ok: fee = own override (1) else global (2.5) else none (0); my_withdraw_settings has no reseller keys, keeps self_withdraw_allowed=true';
end $$;

-- ------------------------------------------------------------
-- 6. admin_request_withdrawal_for
-- ------------------------------------------------------------
insert into usdt_wallets (user_id, network, address)
values ('5c000000-0000-0000-0000-0000000000fa', 'tron', 'TRoleFreelancerAWa11etXXXXXXXXXXXX');
do $$ begin perform pg_temp.act('5c000000-0000-0000-0000-0000000000fa'); end $$;
set local role authenticated;
do $$
begin
  perform pg_temp.refused($q$select admin_request_withdrawal_for('5c000000-0000-0000-0000-0000000000fa', 10, 'tron', '')$q$, 'Not authorized');
  perform pg_temp.refused($q$select admin_request_withdrawal_for('5c000000-0000-0000-0000-0000000000fb', 10, 'tron', '')$q$, 'Not authorized');
  raise notice 'ok: a freelancer cannot use admin_request_withdrawal_for, for itself or anyone';
end $$;
reset role;
do $$ begin perform pg_temp.act('5c000000-0000-0000-0000-0000000000a5'); end $$;
set local role authenticated;
do $$ begin
  perform pg_temp.refused($q$select admin_request_withdrawal_for('5c000000-0000-0000-0000-0000000000fa', 10, 'tron', '')$q$, 'Not authorized');
  raise notice 'ok: a suspended admin cannot either';
end $$;
reset role;
do $$ begin perform pg_temp.act(null); end $$;
set local role anon;
do $$ begin
  perform pg_temp.refused($q$select public.admin_request_withdrawal_for('5c000000-0000-0000-0000-0000000000fa', 10, 'tron', '')$q$, '%');
end $$;
reset role;
create temp table t_avail as select available from get_balance_for('5c000000-0000-0000-0000-0000000000fa');
grant select, update on t_avail to authenticated;
do $$ begin perform pg_temp.act('5c000000-0000-0000-0000-0000000000ad'); end $$;
set local role authenticated;
do $$
declare v_w withdrawals; v_avail numeric := (select available from t_avail);
begin
  perform pg_temp.refused($q$select admin_request_withdrawal_for('5c000000-0000-0000-0000-0000000000fb', 10, 'tron', 'TTypedByAdmin')$q$, 'Save a USDT address on this account first');
  perform pg_temp.refused($q$select admin_request_withdrawal_for('5c000000-0000-0000-0000-0000000000fa', 4.99, 'tron', '')$q$, 'Minimum withdrawal is $5');
  perform pg_temp.refused($q$select admin_request_withdrawal_for('5c000000-0000-0000-0000-0000000000fa', 100000, 'tron', '')$q$, 'Insufficient balance%');
  perform pg_temp.refused($q$select admin_request_withdrawal_for('5c000000-0000-0000-0000-0000000000f0', 10, 'tron', '')$q$, 'This account cannot withdraw');
  perform pg_temp.refused($q$select admin_request_withdrawal_for('5c000000-0000-0000-0000-0000000000ff', 10, 'tron', '')$q$, 'Profile not found');
  v_w := admin_request_withdrawal_for('5c000000-0000-0000-0000-0000000000fa', 20, 'tron', 'TTypedByAdmin');
  if v_w.user_id <> '5c000000-0000-0000-0000-0000000000fa' or v_w.status <> 'pending' or v_w.amount_requested <> 20
     or v_w.fee_percent <> 2.5 or v_w.amount_after_fee <> 19.50 or v_w.destination <> 'TRoleFreelancerAWa11etXXXXXXXXXXXX'
     or v_w.chain <> 'tron' or v_w.admin_note <> 'USDT payout submitted by admin' then
    raise exception 'admin withdrawal row: %', row_to_json(v_w);
  end if;
  update t_avail set available = available - 20;
  raise notice 'ok: admin withdraws for an account: saved wallet only (typed address ignored), fee resolved (2.5%%), $5 minimum, balance, active account, audited';
end $$;
reset role;
do $$
begin
  if (select available from get_balance_for('5c000000-0000-0000-0000-0000000000fa')) <> (select available from t_avail) then
    raise exception 'balance did not drop by the request';
  end if;
  if not exists (select 1 from audit_log a join withdrawals w on w.id::text = a.subject_id
                 where a.action = 'withdrawal.requested_by_admin' and w.user_id = '5c000000-0000-0000-0000-0000000000fa') then
    raise exception 'admin withdrawal not audited';
  end if;
  insert into profile_limits (user_id, single_withdrawal_limit, daily_withdrawal_limit)
  values ('5c000000-0000-0000-0000-0000000000fa', 15, 30)
  on conflict (user_id) do update set single_withdrawal_limit = 15, daily_withdrawal_limit = 30;
  perform pg_temp.act('5c000000-0000-0000-0000-0000000000ad');
  perform pg_temp.refused($q$select admin_request_withdrawal_for('5c000000-0000-0000-0000-0000000000fa', 16, 'tron', '')$q$, 'This amount exceeds the single-withdrawal limit%');
  perform pg_temp.refused($q$select admin_request_withdrawal_for('5c000000-0000-0000-0000-0000000000fa', 15, 'tron', '')$q$, 'This request exceeds the daily withdrawal limit%');
  delete from profile_limits where user_id = '5c000000-0000-0000-0000-0000000000fa';
  insert into app_settings (key, value) values ('emergency_withdrawals_stop', 'true')
  on conflict (key) do update set value = excluded.value;
  perform pg_temp.refused($q$select admin_request_withdrawal_for('5c000000-0000-0000-0000-0000000000fa', 10, 'tron', '')$q$, 'Withdrawals are temporarily paused%');
  update app_settings set value = 'false' where key = 'emergency_withdrawals_stop';
  perform pg_temp.act(null);
  raise notice 'ok: admin withdraw-on-behalf honours single and daily limits and the emergency stop';
end $$;
do $$
begin
  if has_function_privilege('anon', 'admin_request_withdrawal_for(uuid,numeric,text,text)', 'execute')
     or not has_function_privilege('authenticated', 'admin_request_withdrawal_for(uuid,numeric,text,text)', 'execute')
     or has_function_privilege('anon', 'self_withdraw_allowed(uuid)', 'execute')
     or has_function_privilege('authenticated', 'self_withdraw_allowed(uuid)', 'execute') then
    raise exception 'grants wrong';
  end if;
  raise notice 'ok: grants (admin_request_withdrawal_for: authenticated, not anon; self_withdraw_allowed: service role only)';
end $$;

-- Any freelancer withdraws by itself (no reseller switch any more).
do $$
declare v_w withdrawals;
begin
  v_w := reserve_stablecoin_withdrawal('5c000000-0000-0000-0000-0000000000fa', 'role-test-quote', 10, 2.5, 9.75,
           'USDT', 'tron', 'TRoleFreelancerAWa11etXXXXXXXXXXXX', 0.1, 9.7, 10000, now() + interval '5 minutes');
  if v_w.status <> 'sending' then raise exception 'self-withdraw: %', row_to_json(v_w); end if;
  raise notice 'ok: a freelancer reserves its own withdrawal';
end $$;

-- ------------------------------------------------------------
-- 7. Domains are global only
-- ------------------------------------------------------------
do $$
declare v jsonb;
begin
  perform pg_temp.refused($q$insert into site_domains (hostname, owner_id) values ('role.example.test', '5c000000-0000-0000-0000-0000000000fa')$q$, 'Domains are global%');
  insert into site_domains (hostname) values ('role-global.example.test');
  perform pg_temp.act('5c000000-0000-0000-0000-0000000000ad');
  v := admin_get_profile_workspace('5c000000-0000-0000-0000-0000000000fa');
  if exists (select 1 from jsonb_array_elements(v->'domains') d where d->>'scope' <> 'global')
     or not exists (select 1 from jsonb_array_elements(v->'domains') d where d->>'hostname' = 'role-global.example.test') then
    raise exception 'workspace domains: %', v->'domains';
  end if;
  perform pg_temp.act(null);
  raise notice 'ok: a domain cannot be assigned to an account; the workspace lists global domains';
end $$;

-- ------------------------------------------------------------
-- 8. Access people use: suspended admins, marks, admin tools, lockout
-- ------------------------------------------------------------
do $$
begin
  perform pg_temp.act('5c000000-0000-0000-0000-0000000000a5');
  if is_admin() then raise exception 'suspended admin passes is_admin()'; end if;
  perform pg_temp.act('5c000000-0000-0000-0000-0000000000ad');
  if not is_admin() then raise exception 'active admin fails is_admin()'; end if;
  perform pg_temp.act(null);
end $$;

do $$ begin perform pg_temp.act('5c000000-0000-0000-0000-0000000000fa'); end $$;
set local role authenticated;
do $$
begin
  if not exists (select 1 from public.get_my_payments(50, 0, null, null) where id = '5c000000-0000-0000-0000-0000000002fa') then
    raise exception 'freelancer cannot list own payment';
  end if;
  perform mark_payment('5c000000-0000-0000-0000-0000000002fa', 'own');
  perform unmark_payment('5c000000-0000-0000-0000-0000000002fa');
  perform pg_temp.refused($q$select mark_payment('5c000000-0000-0000-0000-0000000002fb', 'not mine')$q$, 'Not authorized');
  perform pg_temp.refused($q$select unmark_payment('5c000000-0000-0000-0000-0000000002fb')$q$, 'Not authorized');
  perform pg_temp.refused($q$select * from admin_list_payments(10, 0, null)$q$, 'Not authorized');
  perform pg_temp.refused($q$select * from admin_daily_summary(3, null)$q$, 'Not authorized');
  perform pg_temp.refused($q$select * from admin_withdraw_fee_overview()$q$, 'Not authorized');
  perform pg_temp.refused($q$select * from admin_list_business_profiles()$q$, 'Not authorized');
  if (select count(*) from my_dashboard_profile()) <> 1 then raise exception 'own profile card'; end if;
  raise notice 'ok: freelancer: own payments and marks; others'' marks and admin reads refused';
end $$;
reset role;

do $$ begin perform pg_temp.act('5c000000-0000-0000-0000-0000000000ad'); end $$;
set local role authenticated;
do $$
declare v int;
begin
  select count(*) into v from admin_list_payments(200, 0, 'role-invoice-ref');
  if v <> 2 then raise exception 'admin_list_payments: expected 2 test payments, got %', v; end if;
  perform mark_payment('5c000000-0000-0000-0000-0000000002fb', 'admin check');
  if (select marked_at from admin_list_payments(200, 0, 'role-invoice-ref-b')) is null then
    raise exception 'admin mark_payment did not record';
  end if;
  perform unmark_payment('5c000000-0000-0000-0000-0000000002fb');
  if exists (select 1 from admin_list_people() where role <> 'creator') then raise exception 'admin_list_people role'; end if;
  if not exists (select 1 from admin_list_people() where id = '5c000000-0000-0000-0000-0000000000fa') then raise exception 'admin_list_people missing'; end if;
  if exists (select 1 from admin_list_business_profiles() where role not in ('creator', 'admin')) then raise exception 'business profiles role'; end if;
  if (select source from admin_withdraw_fee_overview() where user_id = '5c000000-0000-0000-0000-0000000000fb') <> 'account'
     or (select source from admin_withdraw_fee_overview() where user_id = '5c000000-0000-0000-0000-0000000000fa') <> 'global' then
    raise exception 'admin_withdraw_fee_overview sources';
  end if;
  if (select active_creators from admin_global_stats()) < 2 then raise exception 'admin_global_stats creators'; end if;
  perform count(*) from admin_link_usage();
  perform count(*) from admin_daily_timeseries(3, null);
  raise notice 'ok: admin tools (payments, marks, people, business profiles, fee overview, stats, usage, series)';
end $$;
do $$
begin
  perform pg_temp.refused($q$select admin_update_account_control('5c000000-0000-0000-0000-0000000000ad', 'admin', 'suspended')$q$, '%cannot change your own admin access%');
  perform pg_temp.refused($q$select admin_bulk_set_account_status(array['5c000000-0000-0000-0000-0000000000ad']::uuid[], 'suspended')$q$, '%cannot change your own access%');
  perform pg_temp.refused($q$select admin_bulk_set_account_status(array['5c000000-0000-0000-0000-0000000000a2']::uuid[], 'suspended')$q$, '%cannot suspend or reject an active admin%');
  perform pg_temp.refused($q$select admin_set_profile_suspension('5c000000-0000-0000-0000-0000000000a2', true, 'test')$q$, '%protected account-control flow%');
  raise notice 'ok: last-admin and self-suspension guards hold';
end $$;
reset role;

-- Invoice page: create-invoice (service role) resolves the link; the
-- customer (anon) reads the invoice and its status; telegram_context runs.
do $$ begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end $$;
set local role service_role;
do $$
declare r record; v jsonb;
begin
  select * into r from public.system_link_for_invoice('role-a-link');
  if r.user_id is distinct from '5c000000-0000-0000-0000-0000000000fa' or not r.is_active then
    raise exception 'system_link_for_invoice (service role) did not resolve the link';
  end if;
  v := public.telegram_context('all', 7);
  if not exists (select 1 from jsonb_array_elements(v->'creators') c where c->>'role' = 'creator') then
    raise exception 'telegram_context lists no freelancer: %', v->'creators';
  end if;
end $$;
reset role;
do $$ begin perform pg_temp.act(null); end $$;
set local role anon;
do $$
declare r record;
begin
  select * into r from public.get_invoice_public('5c000000-0000-0000-0000-0000000002fb');
  if r.id is distinct from '5c000000-0000-0000-0000-0000000002fb' or r.status <> 'settled' then
    raise exception 'get_invoice_public (anon) failed';
  end if;
  select * into r from public.lookup_payment_status('role-invoice-ref-b');
  if r.status is distinct from 'settled' then raise exception 'lookup_payment_status (anon) failed'; end if;
  if not exists (select 1 from public.get_public_store('5c000000-0000-0000-0000-0000000000fa')) then
    raise exception 'storefront of an active freelancer is empty';
  end if;
  raise notice 'ok: invoice page, status lookup and storefront';
end $$;
reset role;

rollback;
select 'two account types (freelancer, admin) checks passed' as result;
