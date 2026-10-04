#!/usr/bin/env bash
# ============================================================
# 20261005010000 must ABORT, changing nothing, while commission exists.
# ============================================================
# Usage: ci/commission_removal_abort_test.sh <database>
# The database must be migrated up to, but not including, 20261005010000.
# Throwaway database only: it commits fixtures.
#
#   1. a payment stamped with commission (a freelancer who signed up with
#      a reseller's code, at the 8% default seeded by migration 0092)
#                                                    -> abort
#      The 8% is a historical test fixture: it is what a fresh CI database
#      gets from 0092. It is not production. Production's default was 1.5%
#      and Phase 0 (2026-10-05) set it to 0; no production payment carries
#      commission.
#   2. no payment commission, one profile override  -> abort
#   3. nothing left                                  -> applies, and a
#      second apply is a no-op
# After each abort the commission columns and functions must still be
# there: no partial migration, no silent deletion or conversion.
# ============================================================
set -euo pipefail
DB="$1"
MIG=supabase/migrations/20261005010000_remove_reseller_commission.sql
P="psql -h localhost -U postgres -d $DB -v ON_ERROR_STOP=1 -q"

$P <<'SQL'
insert into auth.users (id, email, raw_user_meta_data) values
 ('ab000000-0000-0000-0000-000000000001', 'abort.reseller@cpay.test', '{}'),
 ('ab000000-0000-0000-0000-000000000002', 'abort.freelancer@cpay.test', '{}');
update profiles set account_status = 'active' where id::text like 'ab000000-%';
update profiles set role = 'moderator' where id = 'ab000000-0000-0000-0000-000000000001';
update profiles set referred_by = 'ab000000-0000-0000-0000-000000000001' where id = 'ab000000-0000-0000-0000-000000000002';
insert into payments (id, user_id, amount_requested, status, expires_at)
values ('ab000000-0000-0000-0000-000000000101', 'ab000000-0000-0000-0000-000000000002', 100, 'new', now() + interval '1 hour');
update payments set status = 'settled', amount_settled = 100, settled_at = now()
 where id = 'ab000000-0000-0000-0000-000000000101';
do $$ begin
  if (select reseller_commission_amount from payments where id = 'ab000000-0000-0000-0000-000000000101') <= 0 then
    raise exception 'fixture error: commission was not stamped';
  end if;
end $$;
SQL

still_there() {
  $P -Atc "select (select count(*) from information_schema.columns where table_schema = 'public'
                     and ((table_name = 'payments' and column_name in ('reseller_id', 'reseller_commission_percent', 'reseller_commission_amount'))
                       or (table_name = 'profiles' and column_name = 'reseller_commission_percent')))
                || '/' || (to_regprocedure('public.my_commission_totals()') is not null)::text
                || '/' || (select count(*) from app_settings where key = 'default_reseller_commission_percent')"
}

expect_abort() {
  local label="$1" out
  if out=$($P -f "$MIG" 2>&1); then
    echo "FAIL ($label): the migration applied while commission data exists"; exit 1
  fi
  echo "$out" | grep -q 'ABORT 20261005010000' || { echo "FAIL ($label): wrong error:"; echo "$out"; exit 1; }
  [ "$(still_there)" = "4/true/1" ] || { echo "FAIL ($label): schema changed after abort: $(still_there)"; exit 1; }
  echo "PASS abort ($label): $(echo "$out" | grep -o 'ABORT 20261005010000[^.]*')"
}

expect_abort "stamped payment commission"

$P -c "update payments set reseller_id = null, reseller_commission_percent = 0, reseller_commission_amount = 0
        where id = 'ab000000-0000-0000-0000-000000000101';
       update profiles set reseller_commission_percent = 5 where id = 'ab000000-0000-0000-0000-000000000001';"
expect_abort "profile commission override"

$P -c "update profiles set reseller_commission_percent = null where id = 'ab000000-0000-0000-0000-000000000001';"
$P -f "$MIG" >/dev/null
$P -f "$MIG" >/dev/null
[ "$(still_there)" = "0/false/0" ] || { echo "FAIL: migration did not remove the commission schema: $(still_there)"; exit 1; }
echo "PASS no commission left: migration applies, and applies again as a no-op"
