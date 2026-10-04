-- ============================================================
-- Which SECURITY DEFINER functions can a signed-in user call?
-- ============================================================
-- The anon check (ci/anon_rpc_allowlist.sql) never looked at the
-- authenticated role, and that is how attach_freelancer_to_reseller()
-- shipped callable by every signed-in user: its migration revoked PUBLIC
-- and anon, and Supabase's default privileges left authenticated in place.
--
-- Run against the database built with Supabase's default privileges, like
-- the anon check. Two rules:
--
--   1. Internal functions (signup trigger helpers, settlement and guard
--      helpers, service-role Edge Function lookups) must not be executable
--      by anon, authenticated or PUBLIC, and must stay executable by
--      service_role.
--
--   2. Every other SECURITY DEFINER function a signed-in user can execute
--      must check its caller (auth.uid(), is_admin(), is_reseller(),
--      is_moderator() or handles_creator()) or be listed below as safe for
--      any caller, with a reason.
-- ============================================================
\set ON_ERROR_STOP on

create temp table internal_only(signature text primary key, called_by text not null);
insert into internal_only values
  ('attach_freelancer_to_reseller(uuid, uuid)', 'handle_new_user() at signup'),
  ('system_link_for_invoice(text)',             'create-invoice Edge Function (service role)'),
  ('cpay_make_affiliate_code(uuid)',            'handle_new_user(), ensure_reseller_affiliate_code()'),
  ('cpay_reseller_commission_percent(uuid)',    'stamp_payment_platform_fee(), my_earnings_split()'),
  ('cpay_reseller_for(uuid)',                   'no current caller'),
  ('account_is_active(uuid)',                   'account-status guard triggers, onchain_address_create(), reseller_request_withdrawal_for()'),
  ('cpay_platform_fee_percent(uuid)',           'stamp_payment_platform_fee(), admin_list_business_profiles()'),
  ('cpay_feature_enabled(uuid, text)',          'feature guard triggers, reserve_stablecoin_withdrawal()'),
  ('hide_threshold_for(uuid)',                  'dashboard, balance and Telegram SECURITY DEFINER functions');

create temp table authenticated_no_caller_check(signature text primary key, reason text not null);
insert into authenticated_no_caller_check values
  ('get_invoice_public(uuid)',       'public invoice page'),
  ('get_link_preview(text)',         'public payment link page'),
  ('get_public_store(uuid)',         'public creator store'),
  ('lookup_payment_status(text)',    'public payment status lookup'),
  ('public_settled_feed(integer)',   'public settled feed (admin toggle)'),
  ('link_style_options(text)',       'slug suggestions: only reports whether a slug is taken'),
  ('request_withdrawal(numeric, text, text)', 'retired: always raises'),
  ('cpay_auto_approval_enabled(text)', 'pending review: returns a global signup setting; called by handle_new_user()');

do $$
declare
  v_bad text;
begin
  select string_agg(i.signature || ' [' || r.rolname || ']', ', ' order by i.signature)
    into v_bad
    from internal_only i
    join pg_proc p on p.oid = ('public.' || i.signature)::regprocedure
    cross join (select rolname from pg_roles where rolname in ('anon', 'authenticated')) r
   where has_function_privilege(r.rolname, p.oid, 'execute');
  if v_bad is not null then
    raise exception 'internal function(s) executable by a client role: %. Revoke EXECUTE from public, anon, authenticated.', v_bad;
  end if;

  select string_agg(i.signature, ', ' order by i.signature)
    into v_bad
    from internal_only i
    join pg_proc p on p.oid = ('public.' || i.signature)::regprocedure
    cross join aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
   where a.grantee = 0 and a.privilege_type = 'EXECUTE';
  if v_bad is not null then
    raise exception 'internal function(s) executable by PUBLIC: %', v_bad;
  end if;

  select string_agg(i.signature, ', ' order by i.signature)
    into v_bad
    from internal_only i
   where not has_function_privilege('service_role', ('public.' || i.signature)::regprocedure, 'execute');
  if v_bad is not null then
    raise exception 'service_role lost EXECUTE on internal function(s): %', v_bad;
  end if;
end $$;

create temp view authenticated_unchecked as
select p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as signature
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.prosecdef
   and p.prorettype <> 'trigger'::regtype
   and has_function_privilege('authenticated', p.oid, 'execute')
   and p.prosrc !~ '(auth\.uid\(\)|is_admin\(\)|is_reseller\(\)|is_moderator\(\)|handles_creator\()';

\echo 'SECURITY DEFINER functions authenticated can execute with no caller check in the body:'
select u.signature, coalesce(a.reason, '*** NOT ALLOWLISTED ***') as status
  from authenticated_unchecked u
  left join authenticated_no_caller_check a using (signature)
 order by (a.reason is null) desc, u.signature;

do $$
declare
  v_unexpected text;
  v_stale text;
begin
  select string_agg(signature, ', ' order by signature) into v_stale
    from authenticated_no_caller_check
   where signature not in (select signature from authenticated_unchecked);
  if v_stale is not null then
    raise notice 'Allowlist entries no longer matched: %', v_stale;
  end if;

  select string_agg(signature, ', ' order by signature) into v_unexpected
    from authenticated_unchecked
   where signature not in (select signature from authenticated_no_caller_check);
  if v_unexpected is not null then
    raise exception 'authenticated can EXECUTE SECURITY DEFINER function(s) with no caller check: %. Add an auth.uid()/is_admin() check, revoke EXECUTE from authenticated, or list it in ci/authenticated_rpc_check.sql with a reason.', v_unexpected;
  end if;
end $$;

select 'authenticated RPC check passed' as result;
