-- ============================================================
-- After 0101: reseller self-withdraw switch and withdrawal fee hierarchy
-- ============================================================
-- Read-only. Run against the real database after 0101 is applied.
-- Expected results are in the comment above each query.
-- ============================================================

-- One row. column_default = false, is_nullable = NO.
select column_default, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'reseller_settings'
  and column_name = 'allow_freelancer_self_withdraw';

-- Resellers with self-withdraw on / off / no row (no row counts as off).
-- Right after 0101: on = 0 and no_row = 0.
select
  count(*) filter (where rs.allow_freelancer_self_withdraw) as on_count,
  count(*) filter (where rs.allow_freelancer_self_withdraw = false) as off_count,
  count(*) filter (where rs.reseller_id is null) as no_row
from profiles p
left join reseller_settings rs on rs.reseller_id = p.id
where p.role = 'moderator';

-- Where each account's withdrawal fee comes from (account / reseller /
-- global / none) and the fee each source gives.
select r.source, r.fee_percent, count(*) as accounts
from profiles p cross join lateral withdrawal_fee_resolution(p.id) r
group by 1, 2
order by 1, 2;

-- profiles.withdrawal_fee_percent has no default (NULL = inherit).
select column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'profiles' and column_name = 'withdrawal_fee_percent';

-- Browser roles cannot call the resolvers for arbitrary accounts:
-- every row auth = false, anon = false.
select p.proname,
       has_function_privilege('authenticated', p.oid, 'execute') as auth,
       has_function_privilege('anon', p.oid, 'execute') as anon
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('resolve_withdrawal_fee', 'withdrawal_fee_resolution', 'self_withdraw_allowed', 'reseller_of')
order by 1;

-- RLS is on and only a read policy exists.
select relrowsecurity from pg_class where oid = 'public.reseller_settings'::regclass;
select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'reseller_settings';

-- The insert guard is in place.
select tgname from pg_trigger where tgrelid = 'public.withdrawals'::regclass and tgname = 'trg_guard_withdrawal_self_allowed';
