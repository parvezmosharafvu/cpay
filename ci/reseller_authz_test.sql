-- ============================================================
-- Reseller / staff authorization (20261004010000)
-- ============================================================
-- Exploit regression for M1 and the M2/M3 boundaries, plus proof that the
-- access people legitimately use still works: signup referral, the
-- reseller's team list (commission removed in 20261005010000), admin functions, and the public
-- invoice page. Runs on both CI databases (plain and Supabase default
-- privileges) inside BEGIN/ROLLBACK; leaves nothing behind.
-- ============================================================
\set ON_ERROR_STOP on
begin;

-- auth.uid() in ci/bootstrap.sql always returns null. Read the JWT sub
-- the way Supabase does so each block can act as a different user.
create or replace function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- Act as a signed-in user (sub), anon (null) or the service role.
create function pg_temp.act(p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
  perform set_config('request.jwt.claims',
    case when p_sub is null then '{"role":"anon"}'
         else json_build_object('role', 'authenticated', 'sub', p_sub)::text end, true);
end $$;
grant execute on function pg_temp.act(text) to anon, authenticated, service_role;

-- People. Fixed ids so failures are easy to read.
--   ad, a2 = active admins     a5 = suspended admin
--   ra = reseller A (attacker) rc = reseller C (victim's reseller)
--   rs = suspended reseller    pf = plain freelancer, no reseller
insert into auth.users(id, email) values
  ('5a000000-0000-0000-0000-0000000000ad', 'authz-admin@test.invalid'),
  ('5a000000-0000-0000-0000-0000000000a2', 'authz-admin-two@test.invalid'),
  ('5a000000-0000-0000-0000-0000000000a5', 'authz-admin-suspended@test.invalid'),
  ('5a000000-0000-0000-0000-0000000000aa', 'authz-reseller-a@test.invalid'),
  ('5a000000-0000-0000-0000-0000000000cc', 'authz-reseller-c@test.invalid'),
  ('5a000000-0000-0000-0000-0000000000c5', 'authz-reseller-suspended@test.invalid'),
  ('5a000000-0000-0000-0000-0000000000ff', 'authz-plain@test.invalid');
update profiles set role = 'admin',     account_status = 'active'    where id in ('5a000000-0000-0000-0000-0000000000ad', '5a000000-0000-0000-0000-0000000000a2');
update profiles set role = 'admin',     account_status = 'suspended' where id = '5a000000-0000-0000-0000-0000000000a5';
update profiles set role = 'moderator', account_status = 'active'    where id in ('5a000000-0000-0000-0000-0000000000aa', '5a000000-0000-0000-0000-0000000000cc');
update profiles set role = 'moderator', account_status = 'suspended' where id = '5a000000-0000-0000-0000-0000000000c5';
update profiles set role = 'creator',   account_status = 'active'    where id = '5a000000-0000-0000-0000-0000000000ff';

-- ------------------------------------------------------------
-- 1. Signup referral, the real path: a freelancer signs up with reseller
--    C's affiliate code. handle_new_user() runs with no session and
--    calls attach_freelancer_to_reseller() as the definer.
-- ------------------------------------------------------------
do $$ begin perform pg_temp.act(null); end $$;
do $$
declare v_code text;
begin
  select affiliate_code into v_code from profiles where id = '5a000000-0000-0000-0000-0000000000cc';
  if v_code is null then raise exception 'reseller C has no affiliate code'; end if;
  insert into auth.users(id, email, raw_user_meta_data) values
    ('5a000000-0000-0000-0000-0000000000bb', 'authz-freelancer-b@test.invalid',
     jsonb_build_object('requested_role', 'freelancer', 'affiliate_code', upper(v_code)));
  if (select referred_by from profiles where id = '5a000000-0000-0000-0000-0000000000bb')
     is distinct from '5a000000-0000-0000-0000-0000000000cc' then
    raise exception 'signup referral: freelancer B was not referred to reseller C';
  end if;
  if not exists (select 1 from moderator_assignments
                  where moderator_id = '5a000000-0000-0000-0000-0000000000cc'
                    and creator_id   = '5a000000-0000-0000-0000-0000000000bb') then
    raise exception 'signup referral: freelancer B was not assigned to reseller C';
  end if;
  raise notice 'ok: signup with an affiliate code attaches the freelancer to that reseller';
end $$;
-- Approve B as an admin would, so B can have links and payments below.
update profiles set account_status = 'active' where id = '5a000000-0000-0000-0000-0000000000bb';

-- ------------------------------------------------------------
-- 2. Grants
-- ------------------------------------------------------------
do $$
declare
  v_sig text;
  v_role text;
begin
  -- Internal only: nobody but the service role (and the owner) may call these.
  foreach v_sig in array array[
    'public.attach_freelancer_to_reseller(uuid, uuid)',
    'public.system_link_for_invoice(text)',
    'public.cpay_make_affiliate_code(uuid)',
    'public.account_is_active(uuid)',
    'public.cpay_platform_fee_percent(uuid)',
    'public.cpay_feature_enabled(uuid, text)',
    'public.hide_threshold_for(uuid)'
  ] loop
    foreach v_role in array array['anon', 'authenticated'] loop
      if has_function_privilege(v_role, v_sig, 'execute') then
        raise exception '% can still EXECUTE %', v_role, v_sig;
      end if;
    end loop;
    if exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where p.oid = v_sig::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
      raise exception 'PUBLIC can still EXECUTE %', v_sig;
    end if;
    if not has_function_privilege('service_role', v_sig, 'execute') then
      raise exception 'service_role lost EXECUTE on %', v_sig;
    end if;
  end loop;

  -- Signed in only (M6): anon refused, signed-in callers keep access.
  foreach v_sig in array array[
    'public.admin_customer_directory()',
    'public.admin_list_payment_links()',
    'public.admin_list_payments(integer, integer, text)',
    'public.admin_list_people()',
    'public.admin_list_user_wallets()',
    'public.admin_live_payments()',
    'public.admin_set_user_usdt_wallet(uuid, text, text)',
    'public.staff_list_payments(integer, integer, text, text, text)',
    'public.create_link_variants(text, text[])',
    'public.get_my_payments(integer, integer, text, text)',
    'public.my_reseller_id()'
  ] loop
    if has_function_privilege('anon', v_sig, 'execute') then
      raise exception 'anon can still EXECUTE %', v_sig;
    end if;
    if not has_function_privilege('authenticated', v_sig, 'execute') then
      raise exception 'authenticated lost EXECUTE on %', v_sig;
    end if;
  end loop;

  -- Still public, still needed by RLS and the invoice page.
  foreach v_sig in array array[
    'public.is_admin()', 'public.get_invoice_public(uuid)', 'public.lookup_payment_status(text)',
    'public.get_link_preview(text)'
  ] loop
    if not has_function_privilege('anon', v_sig, 'execute') then
      raise exception 'anon lost EXECUTE on %', v_sig;
    end if;
  end loop;
  raise notice 'ok: grants';
end $$;

-- ------------------------------------------------------------
-- 3. M1 exploit: reseller A tries to take freelancer B, who belongs to
--    reseller C. Refused by the grant, through PostgREST's role.
-- ------------------------------------------------------------
do $$ begin perform pg_temp.act('5a000000-0000-0000-0000-0000000000aa'); end $$;
set local role authenticated;
do $$
declare v_denied boolean := false;
begin
  begin
    perform public.attach_freelancer_to_reseller('5a000000-0000-0000-0000-0000000000bb', '5a000000-0000-0000-0000-0000000000aa');
  exception when insufficient_privilege then v_denied := true;
  end;
  if not v_denied then raise exception 'M1: reseller A could call attach_freelancer_to_reseller'; end if;
end $$;
reset role;

-- A malicious signed-in freelancer: attach itself, or someone else, to
-- any reseller. Refused the same way.
do $$ begin perform pg_temp.act('5a000000-0000-0000-0000-0000000000ff'); end $$;
set local role authenticated;
do $$
declare
  v_pair uuid[];
  v_denied boolean;
begin
  foreach v_pair slice 1 in array array[
    array['5a000000-0000-0000-0000-0000000000ff', '5a000000-0000-0000-0000-0000000000aa']::uuid[],
    array['5a000000-0000-0000-0000-0000000000bb', '5a000000-0000-0000-0000-0000000000aa']::uuid[]
  ] loop
    v_denied := false;
    begin
      perform public.attach_freelancer_to_reseller(v_pair[1], v_pair[2]);
    exception when insufficient_privilege then v_denied := true;
    end;
    if not v_denied then raise exception 'M1: a signed-in freelancer could call attach_freelancer_to_reseller(%, %)', v_pair[1], v_pair[2]; end if;
  end loop;
end $$;
reset role;

-- anon too.
do $$ begin perform pg_temp.act(null); end $$;
set local role anon;
do $$
declare v_denied boolean := false;
begin
  begin
    perform public.attach_freelancer_to_reseller('5a000000-0000-0000-0000-0000000000ff', '5a000000-0000-0000-0000-0000000000aa');
  exception when insufficient_privilege then v_denied := true;
  end;
  if not v_denied then raise exception 'M1: anon could call attach_freelancer_to_reseller'; end if;
end $$;
reset role;

-- Second layer: even with EXECUTE (as if the grant came back), the body
-- refuses a signed-in non-admin and writes nothing.
do $$
begin
  perform pg_temp.act('5a000000-0000-0000-0000-0000000000aa');
  if public.attach_freelancer_to_reseller('5a000000-0000-0000-0000-0000000000bb', '5a000000-0000-0000-0000-0000000000aa') then
    raise exception 'M1: body let reseller A attach freelancer B';
  end if;
  perform pg_temp.act('5a000000-0000-0000-0000-0000000000ff');
  if public.attach_freelancer_to_reseller('5a000000-0000-0000-0000-0000000000ff', '5a000000-0000-0000-0000-0000000000aa') then
    raise exception 'M1: body let a freelancer attach itself';
  end if;
  -- A suspended admin is not an admin.
  perform pg_temp.act('5a000000-0000-0000-0000-0000000000a5');
  if public.attach_freelancer_to_reseller('5a000000-0000-0000-0000-0000000000ff', '5a000000-0000-0000-0000-0000000000aa') then
    raise exception 'M1: body let a suspended admin attach a freelancer';
  end if;
  -- An active admin may not move another reseller's freelancer either.
  perform pg_temp.act('5a000000-0000-0000-0000-0000000000ad');
  if public.attach_freelancer_to_reseller('5a000000-0000-0000-0000-0000000000bb', '5a000000-0000-0000-0000-0000000000aa') then
    raise exception 'M1: freelancer B (reseller C) was attached to reseller A';
  end if;
  -- Service role / signup context (no sub) is refused for B as well.
  perform pg_temp.act(null);
  if public.attach_freelancer_to_reseller('5a000000-0000-0000-0000-0000000000bb', '5a000000-0000-0000-0000-0000000000aa') then
    raise exception 'M1: freelancer B (reseller C) was attached to reseller A without a session';
  end if;

  if exists (select 1 from moderator_assignments where moderator_id = '5a000000-0000-0000-0000-0000000000aa') then
    raise exception 'M1: reseller A gained an assignment';
  end if;
  if (select referred_by from profiles where id = '5a000000-0000-0000-0000-0000000000bb') <> '5a000000-0000-0000-0000-0000000000cc'
     or (select referred_by from profiles where id = '5a000000-0000-0000-0000-0000000000ff') is not null then
    raise exception 'M1: a referral changed';
  end if;
  raise notice 'ok: M1, nobody outside signup or an active admin can create a reseller relationship';
end $$;

-- Reseller A still cannot see freelancer B.
do $$ begin perform pg_temp.act('5a000000-0000-0000-0000-0000000000aa'); end $$;
set local role authenticated;
do $$
begin
  if exists (select 1 from public.my_team_members() where id = '5a000000-0000-0000-0000-0000000000bb') then
    raise exception 'M1: freelancer B is in reseller A''s team';
  end if;
end $$;
reset role;

-- ------------------------------------------------------------
-- Data for the rest: B has a link and a settled payment; the plain
-- freelancer has one too. Inserted 'new' then settled, like production,
-- so the settle trigger stamps the platform fee (commission was removed
-- in 20261005010000).
-- ------------------------------------------------------------
do $$ begin perform pg_temp.act(null); end $$;
insert into payment_links(id, user_id, slug) values
  ('5a000000-0000-0000-0000-00000000011b', '5a000000-0000-0000-0000-0000000000bb', 'authz-b-link'),
  ('5a000000-0000-0000-0000-00000000011f', '5a000000-0000-0000-0000-0000000000ff', 'authz-plain-link');
insert into payments(id, user_id, payment_link_id, amount_requested, method, status, expires_at, invoice_ref, customer_city) values
  ('5a000000-0000-0000-0000-00000000022b', '5a000000-0000-0000-0000-0000000000bb', '5a000000-0000-0000-0000-00000000011b', 100, 'lightning', 'new', now() + interval '15 min', 'authz-invoice-ref-b', 'AuthzCity'),
  ('5a000000-0000-0000-0000-00000000022f', '5a000000-0000-0000-0000-0000000000ff', '5a000000-0000-0000-0000-00000000011f', 40,  'lightning', 'new', now() + interval '15 min', 'authz-invoice-ref-f', 'AuthzCity');
update payments set status = 'settled', amount_settled = amount_requested, settled_at = now()
 where id in ('5a000000-0000-0000-0000-00000000022b', '5a000000-0000-0000-0000-00000000022f');

-- Reseller C would have reached B's payments through the old staff path:
-- it holds an assignment for B. Give reseller A one for the plain
-- freelancer the legitimate way (an admin writes the table) to prove the
-- staff functions refuse even a reseller with assignments.
insert into moderator_assignments(moderator_id, creator_id)
values ('5a000000-0000-0000-0000-0000000000aa', '5a000000-0000-0000-0000-0000000000ff');

-- ------------------------------------------------------------
-- 4. M2: staff functions, admin_list_payments and cross-user marks are
--    platform-admin only. Resellers (with assignments) are refused.
-- ------------------------------------------------------------
do $$
declare
  v_sub text;
  v_call text;
  v_denied boolean;
begin
  foreach v_sub in array array[
    '5a000000-0000-0000-0000-0000000000cc',  -- reseller C, assigned to B
    '5a000000-0000-0000-0000-0000000000aa',  -- reseller A, assigned to plain freelancer
    '5a000000-0000-0000-0000-0000000000a5',  -- suspended admin
    '5a000000-0000-0000-0000-0000000000ff'   -- freelancer
  ] loop
    foreach v_call in array array[
      'select count(*) from public.staff_customer_directory()',
      'select count(*) from public.staff_customer_totals()',
      'select count(*) from public.staff_daily_settled(14)',
      'select count(*) from public.staff_global_stats()',
      'select count(*) from public.staff_list_payments()',
      'select count(*) from public.admin_list_payments()',
      'select public.mark_payment(''5a000000-0000-0000-0000-00000000022b'', ''x'')',
      'select public.unmark_payment(''5a000000-0000-0000-0000-00000000022b'')'
    ] loop
      perform pg_temp.act(v_sub);
      v_denied := false;
      execute 'set local role authenticated';
      begin
        execute v_call;
      exception when others then
        v_denied := sqlerrm like '%Not authorized%';
      end;
      execute 'reset role';
      if not v_denied then raise exception 'M2: % was allowed: %', v_sub, v_call; end if;
    end loop;
    perform pg_temp.act(v_sub);
    if handles_creator('5a000000-0000-0000-0000-0000000000bb') then
      raise exception 'M2: handles_creator() is true for %', v_sub;
    end if;
  end loop;
  perform pg_temp.act(null);
  if exists (select 1 from payments where marked_at is not null and id::text like '5a000000-%') then
    raise exception 'M2: a payment was marked';
  end if;
  raise notice 'ok: M2, staff functions, admin_list_payments and cross-user marks refuse resellers, suspended admins and freelancers';
end $$;

-- ------------------------------------------------------------
-- 5. M3: suspended accounts lose their role.
-- ------------------------------------------------------------
do $$
begin
  perform pg_temp.act('5a000000-0000-0000-0000-0000000000a5');
  if is_admin() then raise exception 'M3: suspended admin passes is_admin()'; end if;
  perform pg_temp.act('5a000000-0000-0000-0000-0000000000c5');
  if is_reseller() or is_moderator() then raise exception 'M3: suspended reseller passes is_reseller()/is_moderator()'; end if;
  begin
    perform count(*) from public.my_team_members();
    raise exception 'M3: suspended reseller read my_team_members()';
  exception when others then
    if sqlerrm not like '%Not authorized%' then raise; end if;
  end;
  perform pg_temp.act('5a000000-0000-0000-0000-0000000000ad');
  if not is_admin() then raise exception 'active admin fails is_admin()'; end if;
  perform pg_temp.act('5a000000-0000-0000-0000-0000000000cc');
  if not (is_reseller() and is_moderator()) then raise exception 'active reseller fails is_reseller()'; end if;
  raise notice 'ok: M3, suspended admins and resellers lose role powers; active ones keep them';
end $$;

-- Lockout guards an active admin cannot get past.
do $$
begin
  perform pg_temp.act('5a000000-0000-0000-0000-0000000000ad');
  begin
    perform public.admin_update_account_control('5a000000-0000-0000-0000-0000000000ad', 'admin', 'suspended');
    raise exception 'lockout: an admin suspended itself through admin_update_account_control';
  exception when others then
    if sqlerrm not like '%cannot change your own admin access%' then raise; end if;
  end;
  begin
    perform public.admin_bulk_set_account_status(array['5a000000-0000-0000-0000-0000000000ad']::uuid[], 'suspended');
    raise exception 'lockout: bulk action suspended its own admin account';
  exception when others then
    if sqlerrm not like '%cannot change your own access%' then raise; end if;
  end;
  begin
    perform public.admin_bulk_set_account_status(array['5a000000-0000-0000-0000-0000000000a2']::uuid[], 'suspended');
    raise exception 'lockout: bulk action suspended another active admin';
  exception when others then
    if sqlerrm not like '%cannot suspend or reject an active admin%' then raise; end if;
  end;
  begin
    perform public.admin_set_profile_suspension('5a000000-0000-0000-0000-0000000000a2', true, 'test');
    raise exception 'lockout: emergency suspension suspended an admin';
  exception when others then
    if sqlerrm not like '%protected account-control flow%' then raise; end if;
  end;
  raise notice 'ok: last-admin and self-suspension guards hold';
end $$;

-- ------------------------------------------------------------
-- 6. Legitimate access still works.
-- ------------------------------------------------------------
-- 6a. Reseller C: team list. Commission was removed in 20261005010000:
--     the commission functions and payment columns no longer exist, and
--     B's settled payment carries only the platform fee.
do $$ begin perform pg_temp.act('5a000000-0000-0000-0000-0000000000cc'); end $$;
set local role authenticated;
do $$
begin
  if not exists (select 1 from public.my_team_members() where id = '5a000000-0000-0000-0000-0000000000bb' and affiliate) then
    raise exception 'reseller C lost freelancer B from my_team_members()';
  end if;
  raise notice 'ok: reseller team list';
end $$;
reset role;
do $$
begin
  if to_regprocedure('public.my_commission_totals()') is not null
     or to_regprocedure('public.my_affiliate_commission_rows()') is not null
     or to_regprocedure('public.cpay_reseller_commission_percent(uuid)') is not null then
    raise exception 'a commission function still exists';
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'payments'
               and column_name in ('reseller_id', 'reseller_commission_percent', 'reseller_commission_amount')) then
    raise exception 'a commission column still exists on payments';
  end if;
  if (select platform_fee_amount from payments where id = '5a000000-0000-0000-0000-00000000022b') is null then
    raise exception 'B''s settled payment has no platform fee stamped';
  end if;
  raise notice 'ok: no commission; platform fee still stamped';
end $$;

-- 6b. Freelancer B: own reseller, own payments, mark own payment.
do $$ begin perform pg_temp.act('5a000000-0000-0000-0000-0000000000bb'); end $$;
set local role authenticated;
do $$
begin
  if public.my_reseller_id() is distinct from '5a000000-0000-0000-0000-0000000000cc' then
    raise exception 'freelancer B: my_reseller_id() changed';
  end if;
  if not exists (select 1 from public.get_my_payments(50, 0, null, null) where id = '5a000000-0000-0000-0000-00000000022b') then
    raise exception 'freelancer B cannot list own payment';
  end if;
  perform public.mark_payment('5a000000-0000-0000-0000-00000000022b', 'own');
  perform public.unmark_payment('5a000000-0000-0000-0000-00000000022b');
  raise notice 'ok: freelancer own reseller, own payments, own marks';
end $$;
reset role;

-- 6c. Active admin: staff and admin functions, cross-user marks.
do $$ begin perform pg_temp.act('5a000000-0000-0000-0000-0000000000ad'); end $$;
set local role authenticated;
do $$
declare v int;
begin
  select count(*) into v from public.admin_list_payments(200, 0, 'authz-invoice-ref');
  if v <> 2 then raise exception 'admin_list_payments: expected 2 test payments, got %', v; end if;
  select count(*) into v from public.staff_list_payments(200, 0, 'authz-invoice-ref');
  if v <> 2 then raise exception 'staff_list_payments: expected 2 test payments, got %', v; end if;
  select count(*) into v from public.staff_customer_directory() where id in ('5a000000-0000-0000-0000-0000000000bb', '5a000000-0000-0000-0000-0000000000ff');
  if v <> 2 then raise exception 'staff_customer_directory: expected 2, got %', v; end if;
  select count(*) into v from public.staff_customer_totals() where creator_id in ('5a000000-0000-0000-0000-0000000000bb', '5a000000-0000-0000-0000-0000000000ff');
  if v <> 2 then raise exception 'staff_customer_totals: expected 2, got %', v; end if;
  perform count(*) from public.staff_daily_settled(14);
  perform * from public.staff_global_stats();
  perform count(*) from public.admin_list_people();
  perform count(*) from public.my_team_members();
  perform public.mark_payment('5a000000-0000-0000-0000-00000000022b', 'admin check');
  if (select marked_at from public.admin_list_payments(200, 0, 'authz-invoice-ref-b')) is null then
    raise exception 'admin mark_payment did not record';
  end if;
  perform public.unmark_payment('5a000000-0000-0000-0000-00000000022b');
  raise notice 'ok: admin functions';
end $$;
reset role;

-- 6d. Invoice page: create-invoice (service role) resolves the link;
--     the customer (anon) reads the invoice and looks up its status.
do $$ begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end $$;
set local role service_role;
do $$
declare r record;
begin
  select * into r from public.system_link_for_invoice('authz-b-link');
  if r.user_id is distinct from '5a000000-0000-0000-0000-0000000000bb' or not r.is_active then
    raise exception 'system_link_for_invoice (service role) did not resolve the link';
  end if;
end $$;
reset role;
do $$ begin perform pg_temp.act(null); end $$;
set local role anon;
do $$
declare r record;
begin
  select * into r from public.get_invoice_public('5a000000-0000-0000-0000-00000000022b');
  if r.id is distinct from '5a000000-0000-0000-0000-00000000022b' or r.status <> 'settled' then
    raise exception 'get_invoice_public (anon) failed';
  end if;
  select * into r from public.lookup_payment_status('authz-invoice-ref-b');
  if r.status is distinct from 'settled' then raise exception 'lookup_payment_status (anon) failed'; end if;
  begin
    perform * from public.system_link_for_invoice('authz-b-link');
    raise exception 'M5: anon called system_link_for_invoice';
  exception when insufficient_privilege then null;
  end;
  raise notice 'ok: invoice page (service-role link lookup, anon invoice read and status lookup)';
end $$;
reset role;

rollback;
select 'reseller authorization checks passed' as result;
