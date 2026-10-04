-- ============================================================
-- Reviewed SECURITY DEFINER functions a signed-in user may execute
-- ============================================================
-- Included by ci/authenticated_rpc_check.sql and
-- ci/authenticated_rpc_sweep_test.sql (\ir). Creates temp tables only.
--
-- STRICT: every SECURITY DEFINER function in public that the
-- authenticated role can EXECUTE must be listed here, and every entry must
-- still exist and be executable. A new function fails CI until someone
-- reviews it and adds a row (or revokes EXECUTE from authenticated).
--
-- kind says which caller check the function is expected to make:
--   public         safe for any caller (public page data, retired stub)
--   self           only the caller's own data (auth.uid())
--   self_or_admin  the caller's own data, or anyone's for an active admin
--   reseller       the caller's own team, as an active reseller (or admin)
--   admin          active platform admin only
-- The kind drives a source-text TRIPWIRE (the expected check appears in
-- the body, comments stripped) and the behavioural sweep. Neither is a
-- proof of correct authorization; reviewing the function is.
-- ============================================================

create temp table authenticated_rpc_allowlist(
  signature text primary key,
  kind text not null check (kind in ('public', 'self', 'self_or_admin', 'reseller', 'admin')),
  reason text not null
);

insert into authenticated_rpc_allowlist(signature, kind, reason) values
  ('cpay_auto_approval_enabled(text)',                                        'public',        'returns the global auto-approve flag for a signup role; no per-user data. Pending review: could be service-role only'),
  ('get_invoice_public(uuid)',                                                'public',        'public invoice page; needs the unguessable payment uuid; presentation fields only'),
  ('get_link_preview(text)',                                                  'public',        'public payment-link page / OG preview by slug'),
  ('get_public_store(uuid)',                                                  'public',        'public creator storefront by user uuid'),
  ('link_style_options(text)',                                                'public',        'slug suggestions for a name; only says whether a slug is taken'),
  ('lookup_payment_status(text)',                                             'public',        'public status lookup by full invoice ref or Lightning invoice'),
  ('public_settled_feed(integer)',                                            'public',        'public settled feed, admin toggle; no ids or emails'),
  ('request_withdrawal(numeric, text, text)',                                 'public',        'retired: always raises'),
  ('admin_assign_creator(uuid, uuid, boolean)',                               'admin',         'admin: assign creator; refuses without an active admin'),
  ('admin_audit_log(integer, integer, text)',                                 'admin',         'admin: audit log; refuses without an active admin'),
  ('admin_customer_directory()',                                              'admin',         'admin: customer directory; refuses without an active admin'),
  ('admin_daily_settled(integer)',                                            'admin',         'admin: daily settled; refuses without an active admin'),
  ('admin_daily_summary(integer, uuid, uuid)',                                'admin',         'admin: daily summary; refuses without an active admin'),
  ('admin_daily_timeseries(integer, uuid, uuid)',                             'admin',         'admin: daily timeseries; refuses without an active admin'),
  ('admin_delete_link(uuid)',                                                 'admin',         'admin: delete link; refuses without an active admin'),
  ('admin_get_profile_limits(uuid)',                                          'admin',         'admin: get profile limits; refuses without an active admin'),
  ('admin_get_profile_workspace(uuid)',                                       'admin',         'admin: get profile workspace; refuses without an active admin'),
  ('admin_global_stats(timestamp with time zone, timestamp with time zone)',  'admin',         'admin: global stats; refuses without an active admin'),
  ('admin_link_payment_count(uuid)',                                          'admin',         'admin: link payment count; refuses without an active admin'),
  ('admin_link_usage()',                                                      'admin',         'admin: link usage; refuses without an active admin'),
  ('admin_list_account_applications(text)',                                   'admin',         'admin: list account applications; refuses without an active admin'),
  ('admin_list_business_profiles()',                                          'admin',         'admin: list business profiles; refuses without an active admin'),
  ('admin_list_creators()',                                                   'admin',         'admin: list creators; refuses without an active admin'),
  ('admin_list_domains()',                                                    'admin',         'admin: list domains; refuses without an active admin'),
  ('admin_list_payment_links()',                                              'admin',         'admin: list payment links; refuses without an active admin'),
  ('admin_list_payments(integer, integer, text)',                             'admin',         'admin: list payments; refuses without an active admin'),
  ('admin_list_people()',                                                     'admin',         'admin: list people; refuses without an active admin'),
  ('admin_list_profile_feature_flags(uuid)',                                  'admin',         'admin: list profile feature flags; refuses without an active admin'),
  ('admin_list_reseller_settings()',                                          'admin',         'admin: list reseller settings; refuses without an active admin'),
  ('admin_list_resellers()',                                                  'admin',         'admin: list resellers; refuses without an active admin'),
  ('admin_list_staff()',                                                      'admin',         'admin: list staff; refuses without an active admin'),
  ('admin_list_user_wallets()',                                               'admin',         'admin: list user wallets; refuses without an active admin'),
  ('admin_live_payments()',                                                   'admin',         'admin: live payments; refuses without an active admin'),
  ('admin_mark_payment(uuid, text, numeric)',                                 'admin',         'admin: mark payment; refuses without an active admin'),
  ('admin_ops_release_gates()',                                               'admin',         'admin: ops release gates; refuses without an active admin'),
  ('admin_ops_snapshot()',                                                    'admin',         'admin: ops snapshot; refuses without an active admin'),
  ('admin_set_auto_approval(text, boolean)',                                  'admin',         'admin: set auto approval; refuses without an active admin'),
  ('admin_set_cost_percent(uuid, numeric)',                                   'admin',         'admin: set cost percent; refuses without an active admin'),
  ('admin_set_creator_amount_display(uuid, text)',                            'admin',         'admin: set creator amount display; refuses without an active admin'),
  ('admin_set_default_platform_fee(numeric)',                                 'admin',         'admin: set default platform fee; refuses without an active admin'),
  ('admin_set_default_reseller_commission(numeric)',                          'admin',         'admin: set default reseller commission; refuses without an active admin'),
  ('admin_set_default_withdrawal_fee(numeric)',                               'admin',         'admin: set default withdrawal fee; refuses without an active admin'),
  ('admin_set_domain_owner(uuid, uuid)',                                      'admin',         'admin: set domain owner; refuses without an active admin'),
  ('admin_set_feature_toggle(text, boolean)',                                 'admin',         'admin: set feature toggle; refuses without an active admin'),
  ('admin_set_hide_small_payments(boolean, numeric)',                         'admin',         'admin: set hide small payments; refuses without an active admin'),
  ('admin_set_link_limit(uuid, integer)',                                     'admin',         'admin: set link limit; refuses without an active admin'),
  ('admin_set_platform_fee(uuid, numeric)',                                   'admin',         'admin: set platform fee; refuses without an active admin'),
  ('admin_set_profile_hide_small(uuid, text)',                                'admin',         'admin: set profile hide small; refuses without an active admin'),
  ('admin_set_reseller_commission(uuid, numeric)',                            'admin',         'admin: set reseller commission; refuses without an active admin'),
  ('admin_set_role(uuid, text)',                                              'admin',         'admin: set role; refuses without an active admin'),
  ('admin_set_user_usdt_wallet(uuid, text, text)',                            'admin',         'admin: set user usdt wallet; refuses without an active admin'),
  ('admin_system_alerts()',                                                   'admin',         'admin: system alerts; refuses without an active admin'),
  ('admin_system_snapshot()',                                                 'admin',         'admin: system snapshot; refuses without an active admin'),
  ('admin_toggle_creator_auto(uuid, boolean)',                                'admin',         'admin: toggle creator auto; refuses without an active admin'),
  ('admin_toggle_link(uuid, boolean)',                                        'admin',         'admin: toggle link; refuses without an active admin'),
  ('admin_update_creator_fee(uuid, numeric)',                                 'admin',         'admin: update creator fee; refuses without an active admin'),
  ('admin_withdraw_fee_overview()',                                           'admin',         'admin: withdraw fee overview; refuses without an active admin'),
  ('handles_creator(uuid)',                                                   'admin',         'returns is_admin() only (20261004010000)'),
  ('revenue_desk()',                                                          'admin',         'platform revenue report, is_admin() (20261003040000)'),
  ('staff_customer_directory()',                                              'admin',         'staff report, admin-only since 20261004010000'),
  ('staff_customer_totals()',                                                 'admin',         'staff report, admin-only since 20261004010000'),
  ('staff_daily_settled(integer)',                                            'admin',         'staff report, admin-only since 20261004010000'),
  ('staff_global_stats(timestamp with time zone, timestamp with time zone)',  'admin',         'staff report, admin-only since 20261004010000'),
  ('staff_list_payments(integer, integer, text, text, text)',                 'admin',         'staff report, admin-only since 20261004010000'),
  ('daily_link_breakdown(integer, uuid)',                                     'reseller',      'own links; a reseller may pass a team member, admin anyone'),
  ('my_affiliate_commission_rows()',                                          'reseller',      'commission rows where the caller is the reseller'),
  ('my_team_members()',                                                       'reseller',      'caller''s own team (referred_by or assignment)'),
  ('my_team_totals()',                                                        'reseller',      'caller''s own team totals'),
  ('post_reseller_notice(text, text)',                                        'reseller',      'reseller posts a notice to its own team'),
  ('reseller_lock_team_cost(numeric, boolean)',                               'reseller',      'reseller sets/locks cost for its own team'),
  ('reseller_request_withdrawal_for(uuid, numeric, text, text)',              'reseller',      'reseller withdraws for its own team member (feature flag)'),
  ('reseller_set_freelancer_cost(uuid, numeric, boolean)',                    'reseller',      'reseller_owns() team member, or admin'),
  ('reseller_set_self_withdraw(boolean)',                                     'reseller',      'reseller''s own team setting'),
  ('reseller_team_daily_summary(integer)',                                    'reseller',      'caller''s own team daily totals'),
  ('send_team_message(uuid, text)',                                           'reseller',      'message between a reseller and its own team member'),
  ('set_link_cost_percent(uuid, numeric)',                                    'reseller',      'own link, a team member''s link for its reseller, or admin'),
  ('set_payment_link_experience(uuid, text, text, text)',                     'reseller',      'own link, a team member''s link for its reseller, or admin'),
  ('set_payment_link_theme(uuid, text)',                                      'reseller',      'own link, a team member''s link for its reseller, or admin'),
  ('set_reseller_telegram(uuid, text, boolean)',                              'reseller',      'reseller''s own alert channel, or admin'),
  ('create_link_variants(text, text[])',                                      'self',          'creates links for auth.uid() only'),
  ('delete_my_usdt_wallet(text)',                                             'self',          'deletes the caller''s own wallet'),
  ('get_my_account_state()',                                                  'self',          'caller''s own data: get my account state (auth.uid())'),
  ('get_my_analytics()',                                                      'self',          'caller''s own data: get my analytics (auth.uid())'),
  ('get_my_balance()',                                                        'self',          'caller''s own data: get my balance (auth.uid())'),
  ('get_my_insights()',                                                       'self',          'caller''s own data: get my insights (auth.uid())'),
  ('get_my_payment_marks()',                                                  'self',          'caller''s own data: get my payment marks (auth.uid())'),
  ('get_my_payments(integer, integer, text, text)',                           'self',          'caller''s own data: get my payments (auth.uid())'),
  ('get_my_totals()',                                                         'self',          'caller''s own data: get my totals (auth.uid())'),
  ('is_admin()',                                                              'self',          'role check of the caller only'),
  ('is_moderator()',                                                          'self',          'role check of the caller only'),
  ('is_reseller()',                                                           'self',          'role check of the caller only'),
  ('mark_payment(uuid, text)',                                                'self',          'owner (auth.uid()) or active admin via handles_creator()'),
  ('my_commission_totals()',                                                  'self',          'caller''s own data: my commission totals (auth.uid())'),
  ('my_daily_settled(integer)',                                               'self',          'caller''s own data: my daily settled (auth.uid())'),
  ('my_daily_summary(integer)',                                               'self',          'caller''s own data: my daily summary (auth.uid())'),
  ('my_dashboard_profile()',                                                  'self',          'caller''s own data: my dashboard profile (auth.uid())'),
  ('my_earnings_split()',                                                     'self',          'caller''s own data: my earnings split (auth.uid())'),
  ('my_payout_book()',                                                        'self',          'caller''s own data: my payout book (auth.uid())'),
  ('my_reseller_id()',                                                        'self',          'caller''s own data: my reseller id (auth.uid())'),
  ('my_withdraw_settings()',                                                  'self',          'caller''s own data: my withdraw settings (auth.uid())'),
  ('onchain_address_create(text, text, text)',                                'self',          'creates an address row for auth.uid()'),
  ('reseller_owns(uuid)',                                                     'self',          'whether the caller (auth.uid()) owns that freelancer; boolean about the caller only'),
  ('set_my_payout_prefs(numeric, text, boolean)',                             'self',          'caller''s own payout preferences'),
  ('set_my_usdt_wallet(text, text)',                                          'self',          'caller''s own USDT wallet'),
  ('unmark_payment(uuid)',                                                    'self',          'owner (auth.uid()) or active admin via handles_creator()'),
  ('update_my_public_profile(text, text, text)',                              'self',          'caller''s own public profile fields'),
  ('admin_bulk_set_account_status(uuid[], text)',                             'admin',         'admin: bulk set account status; refuses without an active admin'),
  ('admin_review_account_application(uuid, text, text)',                      'admin',         'admin: review account application; refuses without an active admin'),
  ('admin_set_ops_release_gate(text, boolean, text)',                         'admin',         'admin: set ops release gate; refuses without an active admin'),
  ('admin_set_profile_feature_flag(uuid, text, boolean)',                     'admin',         'admin: set profile feature flag; refuses without an active admin'),
  ('admin_set_profile_limits(uuid, numeric, numeric, numeric)',               'admin',         'admin: set profile limits; refuses without an active admin'),
  ('admin_set_profile_suspension(uuid, boolean, text)',                       'admin',         'admin: set profile suspension; refuses without an active admin'),
  ('admin_set_profile_verification(uuid, text, text)',                        'admin',         'admin: set profile verification; refuses without an active admin'),
  ('admin_set_reseller_self_withdraw(uuid, boolean)',                         'admin',         'admin: set reseller self withdraw; refuses without an active admin'),
  ('admin_set_reseller_withdrawal_fee(uuid, numeric)',                        'admin',         'admin: set reseller withdrawal fee; refuses without an active admin'),
  ('admin_update_account_control(uuid, text, text, text)',                    'admin',         'admin: update account control; refuses without an active admin'),
  ('clear_message_thread(uuid)',                                              'self_or_admin', 'own support thread, or any thread for an active admin'),
  ('get_message_thread(uuid, integer)',                                       'self_or_admin', 'own support thread, or any thread for an active admin'),
  ('hide_message(uuid)',                                                      'self_or_admin', 'own message, or any message for an active admin'),
  ('onchain_address_delete(uuid)',                                            'self_or_admin', 'own address row, or any for an active admin'),
  ('onchain_address_update(uuid, text, boolean)',                             'self_or_admin', 'own address row, or any for an active admin'),
  ('set_my_cost_percent(numeric)',                                            'self_or_admin', 'caller''s own cost rate; refuses when locked unless admin');

-- Internal functions: never callable by anon or authenticated (or PUBLIC);
-- service_role and SECURITY DEFINER callers only.
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

-- The SECURITY DEFINER functions authenticated can execute right now, with
-- comments stripped from the source for the tripwire.
create temp view authenticated_definer_functions as
select p.oid,
       p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as signature,
       regexp_replace(regexp_replace(p.prosrc, '/\*.*?\*/', '', 'g'), '--[^\n]*', '', 'g') as src
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.prosecdef
   and p.prorettype <> 'trigger'::regtype
   and has_function_privilege('authenticated', p.oid, 'execute');
