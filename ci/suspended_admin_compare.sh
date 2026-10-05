#!/usr/bin/env bash
# ============================================================
# A suspended admin gets no new privilege from 20261005020000.
# ============================================================
# Usage: ci/suspended_admin_compare.sh <db before 20261005020000> <db after>
# Runs ci/suspended_admin_probe.sql on both and fails if:
#   * any probe is allowed after that was not allowed before, or
#   * the new admin_request_withdrawal_for() is allowed to a suspended
#     admin, or any withdrawal/fee/wallet/account probe is allowed after.
# Read-only on both databases (the probe rolls back).
# ============================================================
set -euo pipefail
P="psql -h localhost -U postgres -v ON_ERROR_STOP=1 -q -X"
before=$($P -d "$1" -f ci/suspended_admin_probe.sql)
after=$($P -d "$2" -f ci/suspended_admin_probe.sql)
echo "probe | before | after"
fail=0
while IFS='|' read -r name res; do
  [ -z "$name" ] && continue
  was=$(printf '%s\n' "$before" | awk -F'|' -v n="$name" '$1==n {print $2}')
  echo "$name | ${was:-?} | $res"
  if [ "$res" = allowed ] && [ "$was" != allowed ]; then
    echo "FAIL: '$name' is allowed after 20261005020000 but was ${was:-not probed} before"; fail=1
  fi
  if [ "$res" = allowed ]; then
    echo "FAIL: a suspended admin is allowed '$name' after 20261005020000"; fail=1
  fi
done <<< "$after"
case "$after" in *"admin_request_withdrawal_for(other)|refused"*) ;; *) echo "FAIL: admin_request_withdrawal_for not refused"; fail=1;; esac
# Positive control: the same probes as an ACTIVE admin on the new schema
# must see the admin paths allowed, or a refusal above proves nothing.
control=$($P -d "$2" -v admin_status=active -f ci/suspended_admin_probe.sql)
for name in 'is_admin' 'admin_request_withdrawal_for(other)' 'approve other withdrawal' 'read other withdrawals' \
            'admin_update_creator_fee' 'admin_set_user_usdt_wallet' 'admin_withdraw_fee_overview' 'admin_list_people'; do
  case "$control" in *"$name|allowed"*) echo "control: an active admin is allowed '$name'";;
    *) echo "FAIL: control: an active admin is not allowed '$name'"; fail=1;; esac
done
[ $fail -eq 0 ] && echo "PASS a suspended admin is refused every probe after 20261005020000, and nothing is newly allowed"
exit $fail
