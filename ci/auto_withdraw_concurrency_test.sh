#!/usr/bin/env bash
# Two sessions confirm different quotes for the whole balance at the same
# time: the profile row lock lets exactly one reserve; the other sees the
# reduced balance. Needs a database with every migration applied ($PGDATABASE).
set -euo pipefail
PSQL=(psql -h "${PGHOST:-localhost}" -U "${PGUSER:-postgres}" -d "${PGDATABASE:-postgres}" -v ON_ERROR_STOP=1 -Atq)
U=ea200000-0000-0000-0000-0000000000a1
"${PSQL[@]}" <<SQL
insert into auth.users(id, email) values ('$U', 'aw-conc@test.invalid') on conflict do nothing;
update profiles set account_status = 'active' where id = '$U';
insert into payment_links(id, user_id, slug) values ('ea200000-0000-0000-0000-0000000001a1', '$U', 'aw-conc-link') on conflict do nothing;
insert into payments(id, user_id, payment_link_id, amount_requested, method, status, expires_at, invoice_ref)
values ('ea200000-0000-0000-0000-0000000002a1', '$U', 'ea200000-0000-0000-0000-0000000001a1', 30, 'lightning', 'new', now() + interval '15 min', 'aw-conc-1')
on conflict do nothing;
update payments set status = 'settled', amount_settled = 30, amount_sat = 30000, settled_at = now() where id = 'ea200000-0000-0000-0000-0000000002a1';
SQL
AV=$("${PSQL[@]}" -c "select floor(available * 100) / 100 from get_balance_for('$U')")
FEE=$("${PSQL[@]}" -c "select resolve_withdrawal_fee('$U')")
reserve() {
  "${PSQL[@]}" -c "begin; select pg_sleep(0.2);
    select status from reserve_lightning_withdrawal('$U', '$1', $AV, $FEE, round($AV * (1 - $FEE / 100), 2), 'lnbcrt1u1conc${1//-/}', 1000, 0, now() + interval '1 min');
    select pg_sleep(0.5); commit;" 2>&1 || true
}
reserve conc-1 > /tmp/aw_c1.txt & reserve conc-2 > /tmp/aw_c2.txt & wait
N=$("${PSQL[@]}" -c "select count(*) from withdrawals where user_id = '$U' and status = 'sending'")
"${PSQL[@]}" -c "update withdrawals set status = 'failed' where user_id = '$U'" >/dev/null
if [ "$N" != "1" ]; then echo "expected exactly one reservation, got $N"; cat /tmp/aw_c1.txt /tmp/aw_c2.txt; exit 1; fi
grep -q 'Insufficient balance' /tmp/aw_c1.txt /tmp/aw_c2.txt || { echo "loser did not see Insufficient balance"; cat /tmp/aw_c1.txt /tmp/aw_c2.txt; exit 1; }
echo "auto_withdraw_concurrency_test: ok"
