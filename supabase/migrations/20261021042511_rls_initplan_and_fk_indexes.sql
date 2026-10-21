-- 20261021042511: recorded in production on 2026-10-21 (applied outside the
-- repo). Copied here verbatim from supabase_migrations.schema_migrations so
-- local and remote history match; only its own BEGIN/COMMIT were dropped
-- (each migration already runs in one transaction). Idempotent.
-- =====================================================================
-- CPAY (riumaeihemgznvgattoc) migration DRAFT: 20261021_rls_initplan_and_fk_indexes
-- (a) 19 RLS policies flagged by auth_rls_initplan: auth.uid() -> (select auth.uid())
--     Definitions pulled verbatim from pg_policies on 2026-10-21 (Asia/Dhaka).
--     Semantics unchanged: same cmd, roles, PERMISSIVE, USING / WITH CHECK.
-- (b) 14 covering indexes for unindexed foreign keys (performance advisor 0001).
-- NOT APPLIED. Review before running. Note: CREATE INDEX (non-CONCURRENTLY) takes
-- a SHARE lock; tables are tiny today so this is fine inside one transaction.
-- =====================================================================

-- ---------- (a) RLS policies ----------
DROP POLICY IF EXISTS "application owner read" ON public.account_applications;
CREATE POLICY "application owner read" ON public.account_applications AS PERMISSIVE FOR SELECT TO public
  USING ((user_id = (select auth.uid())) OR is_admin());

DROP POLICY IF EXISTS "direct_payments_own" ON public.direct_payments;
CREATE POLICY "direct_payments_own" ON public.direct_payments AS PERMISSIVE FOR SELECT TO authenticated
  USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "forward_batches_own" ON public.forward_batches;
CREATE POLICY "forward_batches_own" ON public.forward_batches AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = (select auth.uid())) OR is_admin());

DROP POLICY IF EXISTS "onchain owner read" ON public.onchain_addresses;
CREATE POLICY "onchain owner read" ON public.onchain_addresses AS PERMISSIVE FOR SELECT TO public
  USING ((user_id = (select auth.uid())) OR is_admin());

DROP POLICY IF EXISTS "payment_forwards_owner_read" ON public.payment_forwards;
CREATE POLICY "payment_forwards_owner_read" ON public.payment_forwards AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = (select auth.uid())) OR is_admin());

DROP POLICY IF EXISTS "own links insert" ON public.payment_links;
CREATE POLICY "own links insert" ON public.payment_links AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "own links select" ON public.payment_links;
CREATE POLICY "own links select" ON public.payment_links AS PERMISSIVE FOR SELECT TO public
  USING ((user_id = (select auth.uid())) OR is_admin());

DROP POLICY IF EXISTS "own links update" ON public.payment_links;
CREATE POLICY "own links update" ON public.payment_links AS PERMISSIVE FOR UPDATE TO public
  USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "own payments select" ON public.payments;
CREATE POLICY "own payments select" ON public.payments AS PERMISSIVE FOR SELECT TO public
  USING ((user_id = (select auth.uid())) OR is_admin());

DROP POLICY IF EXISTS "profile_locations_owner_read" ON public.profile_locations;
CREATE POLICY "profile_locations_owner_read" ON public.profile_locations AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = (select auth.uid())) OR is_admin());

DROP POLICY IF EXISTS "own profile" ON public.profiles;
CREATE POLICY "own profile" ON public.profiles AS PERMISSIVE FOR SELECT TO public
  USING ((id = (select auth.uid())) OR is_admin());

DROP POLICY IF EXISTS "update own profile" ON public.profiles;
CREATE POLICY "update own profile" ON public.profiles AS PERMISSIVE FOR UPDATE TO public
  USING (id = (select auth.uid()))
  WITH CHECK (id = (select auth.uid()));

DROP POLICY IF EXISTS "receive_settings_own" ON public.receive_settings;
CREATE POLICY "receive_settings_own" ON public.receive_settings AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_id = (select auth.uid())) OR is_admin());

DROP POLICY IF EXISTS "settlement_destinations_own" ON public.settlement_destinations;
CREATE POLICY "settlement_destinations_own" ON public.settlement_destinations AS PERMISSIVE FOR SELECT TO authenticated
  USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "own thread select" ON public.support_messages;
CREATE POLICY "own thread select" ON public.support_messages AS PERMISSIVE FOR SELECT TO public
  USING ((user_id = (select auth.uid())) OR is_admin());

DROP POLICY IF EXISTS "send in own thread" ON public.support_messages;
CREATE POLICY "send in own thread" ON public.support_messages AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((sender = 'creator'::text) AND (user_id = (select auth.uid()))) OR ((sender = 'admin'::text) AND is_admin()));

DROP POLICY IF EXISTS "update own messages or mark read" ON public.support_messages;
CREATE POLICY "update own messages or mark read" ON public.support_messages AS PERMISSIVE FOR UPDATE TO public
  USING (is_admin() OR (user_id = (select auth.uid())))
  WITH CHECK (is_admin() OR (user_id = (select auth.uid())));

DROP POLICY IF EXISTS "usdt_wallets_own" ON public.usdt_wallets;
CREATE POLICY "usdt_wallets_own" ON public.usdt_wallets AS PERMISSIVE FOR ALL TO authenticated
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "own withdrawals select" ON public.withdrawals;
CREATE POLICY "own withdrawals select" ON public.withdrawals AS PERMISSIVE FOR SELECT TO public
  USING ((user_id = (select auth.uid())) OR is_admin());

-- ---------- (b) FK covering indexes ----------
CREATE INDEX IF NOT EXISTS idx_account_applications_reviewed_by ON public.account_applications (reviewed_by);
CREATE INDEX IF NOT EXISTS idx_direct_payments_destination_id ON public.direct_payments (destination_id);
CREATE INDEX IF NOT EXISTS idx_ops_release_gates_completed_by ON public.ops_release_gates (completed_by);
CREATE INDEX IF NOT EXISTS idx_payment_forwards_batch_id ON public.payment_forwards (batch_id);
CREATE INDEX IF NOT EXISTS idx_payment_forwards_destination_id ON public.payment_forwards (destination_id);
CREATE INDEX IF NOT EXISTS idx_payment_forwards_wallet_id ON public.payment_forwards (wallet_id);
CREATE INDEX IF NOT EXISTS idx_payments_marked_by ON public.payments (marked_by);
CREATE INDEX IF NOT EXISTS idx_profile_feature_flags_updated_by ON public.profile_feature_flags (updated_by);
CREATE INDEX IF NOT EXISTS idx_profile_limits_updated_by ON public.profile_limits (updated_by);
CREATE INDEX IF NOT EXISTS idx_profile_suspensions_lifted_by ON public.profile_suspensions (lifted_by);
CREATE INDEX IF NOT EXISTS idx_profile_suspensions_suspended_by ON public.profile_suspensions (suspended_by);
CREATE INDEX IF NOT EXISTS idx_profiles_verified_by ON public.profiles (verified_by);
CREATE INDEX IF NOT EXISTS idx_receipt_reviews_payment_id ON public.receipt_reviews (payment_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_wallet_id ON public.withdrawals (wallet_id);


