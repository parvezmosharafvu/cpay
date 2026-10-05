#!/usr/bin/env bash
# ============================================================
# 20261005020000 must ABORT, changing nothing, while reseller data exists.
# ============================================================
# Usage: ci/role_removal_abort_test.sh <database>
# The database must be migrated up to, but not including, 20261005020000.
# Throwaway database only: it commits fixtures.
#
# One precondition at a time: the fixture is added, the migration must
# abort with "ABORT 20261005020000" and leave the reseller schema in place
# (no partial migration, no silent deletion or conversion), then the
# fixture is removed. With nothing left the migration applies, and a second
# apply is a no-op.
# ============================================================
set -euo pipefail
DB="$1"
MIG=supabase/migrations/20261005020000_remove_reseller_role.sql
P="psql -h localhost -U postgres -d $DB -v ON_ERROR_STOP=1 -q"

R=ab200000-0000-0000-0000-000000000001   # reseller
F=ab200000-0000-0000-0000-000000000002   # freelancer
$P <<SQL
insert into auth.users (id, email, raw_user_meta_data) values
 ('$R', 'abort2.reseller@cpay.test', '{}'),
 ('$F', 'abort2.freelancer@cpay.test', '{}');
update profiles set account_status = 'active' where id in ('$R', '$F');
update profiles set role = 'moderator' where id = '$R';
update profiles set affiliate_code = null where id = '$R';
insert into reseller_settings (reseller_id) values ('$R') on conflict do nothing;
SQL

# role check still allows 'moderator' / reseller tables / profile columns / reseller role count
still_there() {
  $P -Atc "select (pg_get_constraintdef((select oid from pg_constraint where conname = 'profiles_role_check')) like '%moderator%')::text
                || '/' || (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relname in
                     ('reseller_settings', 'moderator_assignments', 'reseller_notices', 'team_messages', 'reseller_alert_channels'))
                || '/' || (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'profiles'
                     and column_name in ('referred_by', 'affiliate_code', 'cost_locked', 'team_cost_percent'))
                || '/' || (select count(*) from profiles where role = 'moderator')
                || '/' || (to_regprocedure('public.reseller_request_withdrawal_for(uuid,numeric,text,text)') is not null)::text"
}

expect_abort() {
  local label="$1" setup="$2" undo="$3" out
  $P -c "$setup"
  if out=$($P -f "$MIG" 2>&1); then
    echo "FAIL ($label): the migration applied while reseller data exists"; exit 1
  fi
  echo "$out" | grep -q 'ABORT 20261005020000' || { echo "FAIL ($label): wrong error:"; echo "$out"; exit 1; }
  [ "$(still_there)" = "true/5/4/1/true" ] || { echo "FAIL ($label): schema changed after abort: $(still_there)"; exit 1; }
  echo "PASS abort ($label): $(echo "$out" | grep -o 'reseller data exists (.*)\. Nothing' | sed 's/\. Nothing$//')"
  $P -c "$undo"
}

[ "$(still_there)" = "true/5/4/1/true" ] || { echo "FAIL: fixture: $(still_there)"; exit 1; }

expect_abort "team member (referred_by)" \
  "update profiles set referred_by = '$R' where id = '$F'" \
  "update profiles set referred_by = null where id = '$F'"
expect_abort "affiliate code" \
  "update profiles set affiliate_code = 'abort2code' where id = '$R'" \
  "update profiles set affiliate_code = null where id = '$R'"
expect_abort "locked cost rate" \
  "update profiles set cost_locked = true where id = '$F'" \
  "update profiles set cost_locked = false where id = '$F'"
expect_abort "team cost rate" \
  "update profiles set team_cost_percent = 5 where id = '$R'" \
  "update profiles set team_cost_percent = null where id = '$R'"
expect_abort "admin assignment" \
  "insert into moderator_assignments (moderator_id, creator_id) values ('$R', '$F')" \
  "delete from moderator_assignments"
expect_abort "reseller notice" \
  "insert into reseller_notices (reseller_id, title, body) values ('$R', 't', 'b')" \
  "delete from reseller_notices"
expect_abort "team message" \
  "insert into team_messages (reseller_id, freelancer_id, sender_id, body) values ('$R', '$F', '$F', 'hi')" \
  "delete from team_messages"
expect_abort "reseller Telegram group" \
  "insert into reseller_alert_channels (reseller_id, telegram_chat_id) values ('$R', '-1001')" \
  "delete from reseller_alert_channels"
expect_abort "reseller team withdrawal fee" \
  "update reseller_settings set team_withdrawal_fee_percent = 4 where reseller_id = '$R'" \
  "update reseller_settings set team_withdrawal_fee_percent = null where reseller_id = '$R'"
expect_abort "freelancer self-withdraw switch on" \
  "update reseller_settings set allow_freelancer_self_withdraw = true where reseller_id = '$R'" \
  "update reseller_settings set allow_freelancer_self_withdraw = false where reseller_id = '$R'"
expect_abort "pending reseller application" \
  "update account_applications set requested_role = 'reseller', status = 'pending' where user_id = '$F'" \
  "update account_applications set requested_role = 'freelancer', status = 'approved' where user_id = '$F'"
expect_abort "domain assigned to an account" \
  "insert into site_domains (hostname, owner_id) values ('abort2.example.test', '$R')" \
  "delete from site_domains where hostname = 'abort2.example.test'"

# A decided reseller application is history, not a relationship: it does
# not block, and is relabelled 'freelancer' by the migration.
$P -c "update account_applications set requested_role = 'reseller', status = 'approved' where user_id = '$R'"
$P -f "$MIG" >/dev/null
$P -f "$MIG" >/dev/null
[ "$(still_there)" = "false/0/0/0/false" ] || { echo "FAIL: migration did not remove the reseller schema: $(still_there)"; exit 1; }
[ "$($P -Atc "select role || '/' || (select requested_role || ':' || status from account_applications where user_id = '$R') from profiles where id = '$R'")" = "creator/freelancer:approved" ] \
  || { echo "FAIL: reseller account or its application not converted"; exit 1; }
echo "PASS nothing reseller-specific left: migration applies (reseller -> freelancer, decided application relabelled), and applies again as a no-op"
