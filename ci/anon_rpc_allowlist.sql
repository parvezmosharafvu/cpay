-- ============================================================
-- Which SECURITY DEFINER functions can the public anon key call?
-- ============================================================
-- A SECURITY DEFINER function runs as its owner and skips RLS. If anon can
-- EXECUTE it, anyone with public/config.js can call it through
-- POST /rest/v1/rpc/<name>. revenue_desk() leaked platform revenue this
-- way (fixed in 20261003040000).
--
-- Run this against a database built with Supabase's default privileges
-- (every new function in public is granted to anon, authenticated and
-- service_role), so it sees what production sees. The job fails when
-- anon can execute a SECURITY DEFINER function not listed below. Trigger
-- functions are skipped because PostgREST cannot call them.
--
-- To add an entry, the function must be safe for logged-out callers OR
-- check auth.uid() / is_admin() itself. Say which in the PR.
-- ============================================================
\set ON_ERROR_STOP on

create temp table anon_rpc_allowlist(signature text primary key, reason text not null);

insert into anon_rpc_allowlist(signature, reason) values
  -- Public by design (checkout, invoice page, store, link previews).
  ('get_invoice_public(uuid)',               'public invoice page'),
  ('get_link_preview(text)',                 'public payment link page / OG preview'),
  ('get_public_store(uuid)',                 'public creator store'),
  ('public_settled_feed(integer)',           'public settled feed (admin toggle)'),
  ('lookup_payment_status(text)',            'public payment status lookup'),
  ('is_admin()',                             'returns false for callers without a session'),

  -- PENDING REVIEW: already present before this check existed. Each checks
  -- is_admin() / auth.uid() inside, so anon gets an error or nothing, but
  -- EXECUTE should still be revoked from anon in a follow-up.
  ('admin_customer_directory()',                           'pending review: guarded by is_admin()'),
  ('admin_list_payment_links()',                           'pending review: guarded by is_admin()'),
  ('admin_list_payments(integer, integer, text)',          'pending review: guarded by is_admin()'),
  ('admin_list_people()',                                  'pending review: guarded by is_admin()'),
  ('admin_list_user_wallets()',                            'pending review: guarded by is_admin()'),
  ('admin_live_payments()',                                'pending review: guarded by is_admin()'),
  ('admin_set_user_usdt_wallet(uuid, text, text)',         'pending review: guarded by is_admin()'),
  ('staff_list_payments(integer, integer, text, text, text)', 'pending review: guarded by is_admin()/moderator'),
  ('create_link_variants(text, text[])',                   'pending review: uses auth.uid()'),
  ('get_my_payments(integer, integer, text, text)',        'pending review: uses auth.uid()'),
  ('my_reseller_id()',                                     'pending review: uses auth.uid()'),
  ('my_payout_book()',                                     'pending review: uses auth.uid()'),
  ('set_my_payout_prefs(numeric, text, boolean)',          'pending review: uses auth.uid()'),
  ('set_my_usdt_wallet(text, text)',                       'pending review: uses auth.uid()'),
  ('delete_my_usdt_wallet(text)',                          'pending review: uses auth.uid()'),

  -- PENDING REVIEW, PRIORITY: no auth.uid()/is_admin() check visible in
  -- the body. Look at what each returns or writes for an anon caller.
  ('system_link_for_invoice(text)',          'pending review: no caller check (used by create-invoice via service role)'),
  ('cpay_make_affiliate_code(uuid)',         'pending review: no caller check'),
  ('cpay_reseller_commission_percent(uuid)', 'pending review: no caller check'),
  ('cpay_reseller_for(uuid)',                'pending review: no caller check');

create temp view anon_definer_functions as
select p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as signature
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.prosecdef
   and p.prorettype <> 'trigger'::regtype
   and has_function_privilege('anon', p.oid, 'execute');

\echo 'SECURITY DEFINER functions anon can execute:'
select f.signature, coalesce(a.reason, '*** NOT ALLOWLISTED ***') as status
  from anon_definer_functions f
  left join anon_rpc_allowlist a using (signature)
 order by (a.reason is null) desc, f.signature;

do $$
declare
  v_unexpected text;
  v_stale text;
begin
  select string_agg(signature, ', ' order by signature) into v_stale
    from anon_rpc_allowlist
   where signature not in (select signature from anon_definer_functions);
  if v_stale is not null then
    raise notice 'Allowlist entries anon cannot execute in this database: %', v_stale;
  end if;

  select string_agg(signature, ', ' order by signature) into v_unexpected
    from anon_definer_functions
   where signature not in (select signature from anon_rpc_allowlist);
  if v_unexpected is not null then
    raise exception 'anon can EXECUTE SECURITY DEFINER function(s) not on the allowlist: %. Revoke EXECUTE from anon (and public), or add it to ci/anon_rpc_allowlist.sql with a reason.', v_unexpected;
  end if;
end $$;

select 'anon RPC allowlist check passed' as result;
