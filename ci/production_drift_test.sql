-- Production drift fixes (20261004020000) on the repo-built database.
-- BEGIN/ROLLBACK; leaves nothing behind.
\set ON_ERROR_STOP on
begin;
\ir production_drift_checks.inc.sql
rollback;
