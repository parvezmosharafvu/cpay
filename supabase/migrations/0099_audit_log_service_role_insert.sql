-- ============================================================
-- CPAY — 0099: service_role can append to audit_log
-- ============================================================
-- The auth-settings edge function (the ops panel's sign-up email
-- confirmation switch) writes one audit_log row per change through the
-- SERVICE_ROLE key, which maps to the `service_role` database role. The
-- change it records happens in Supabase Auth's config, not in a table, so
-- there is no SECURITY DEFINER function to call record_audit() from.
--
-- Hosted Supabase's default privileges already give service_role every
-- right on public tables, so on a normal project this changes nothing.
-- It is spelled out for the same reason as 0055: not to rely on default
-- privileges that were never guaranteed (the CI database has none).
--
-- INSERT only, plus the id sequence it needs. authenticated and anon get
-- nothing here; the log stays append-only with no client write path.
-- ============================================================

grant insert on table public.audit_log to service_role;
grant usage on sequence public.audit_log_id_seq to service_role;
