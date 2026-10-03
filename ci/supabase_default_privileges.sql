-- Supabase grants every new function, table and sequence in schema public
-- to anon, authenticated and service_role by default. ci/bootstrap.sql does
-- not, so a bare-Postgres CI database under-reports what anon can call.
-- Apply this after bootstrap.sql and before the migrations when a check
-- needs production-like privileges (see ci/anon_rpc_allowlist.sql).
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
