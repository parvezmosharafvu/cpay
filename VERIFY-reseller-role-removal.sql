-- ============================================================
-- After 20261005020000: the reseller role is gone
-- ============================================================
-- Read-only. Run against the real database after the migration is applied.
-- Expected results are in the comment above each query. No personal data.
-- ============================================================

-- Roles: only creator and admin. Expect no 'moderator' row.
select role, count(*) from profiles group by role order by role;

-- Zero rows: the reseller tables are gone.
select t from unnest(array['reseller_settings', 'moderator_assignments', 'reseller_notices',
                           'team_messages', 'reseller_alert_channels']) t
 where to_regclass('public.' || t) is not null;

-- Zero rows: the reseller columns are gone from profiles.
select column_name from information_schema.columns
 where table_schema = 'public' and table_name = 'profiles'
   and column_name in ('referred_by', 'affiliate_code', 'cost_locked', 'team_cost_percent');

-- Zero rows: the reseller functions are gone.
select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('is_moderator', 'is_reseller', 'reseller_owns', 'my_reseller_id', 'reseller_of',
                     'handles_creator', 'reseller_team_ids', 'reseller_request_withdrawal_for',
                     'admin_set_reseller_self_withdraw', 'admin_set_reseller_withdrawal_fee',
                     'enqueue_daily_close', 'staff_daily_settled');

-- One row, source 'account' or 'global' or 'none' for every account:
-- the fee is the account's override, else the global default.
select source, count(*) from profiles p cross join lateral withdrawal_fee_resolution(p.id)
 group by source order by source;

-- One row: the admin withdraw-on-behalf function, callable by authenticated
-- (it checks is_admin() itself), not by anon.
select has_function_privilege('authenticated', 'admin_request_withdrawal_for(uuid,numeric,text,text)', 'execute') as authenticated,
       has_function_privilege('anon', 'admin_request_withdrawal_for(uuid,numeric,text,text)', 'execute') as anon;

-- Zero rows: the daily-close cron job is unscheduled (needs pg_cron).
select jobname from cron.job where jobname = 'cpay-daily-close';
