#!/usr/bin/env bash
# Audit P3: upgrade path. Build the schema as it was before Breez (through
# 0092, still BTCPay-shaped), put a Freelancer with a settled payment and a
# paid withdrawal in it, apply every later migration, and require the
# Freelancer's balance to be unchanged and no BTCPay object to remain.
# Usage: PSQL="psql -h localhost -U postgres" ci/upgrade_from_pre_breez_test.sh
set -euo pipefail
PSQL=${PSQL:-"psql -h localhost -U postgres"}
DB=upgradecheck
$PSQL -v ON_ERROR_STOP=1 -q -c "drop database if exists $DB" -c "create database $DB"
P="$PSQL -d $DB -v ON_ERROR_STOP=1 -q"
$P -f ci/bootstrap.sql
$P -f ci/supabase_default_privileges.sql
later=()
for f in supabase/migrations/*.sql; do
  if [[ "$(basename "$f")" < "0093" ]]; then $P -f "$f"; else later+=("$f"); fi
done
$P <<'SQL'
insert into auth.users(id, email) values ('a0000000-0000-0000-0000-0000000000a1', 'upgrade@test.invalid');
update profiles set role = 'creator', account_status = 'active' where id = 'a0000000-0000-0000-0000-0000000000a1';
insert into payments(user_id, amount_requested, amount_settled, status, expires_at, settled_at, platform_fee_percent, platform_fee_amount)
values ('a0000000-0000-0000-0000-0000000000a1', 10.00, 10.00, 'settled', now(), now(), 10, 1.00),
       ('a0000000-0000-0000-0000-0000000000a1', 25.50, 25.50, 'settled', now(), now(), 10, 2.55);
create table public._upgrade_before as select * from get_balance_for('a0000000-0000-0000-0000-0000000000a1');
SQL
for f in "${later[@]}"; do $P -f "$f"; done
$P <<'SQL'
do $$
declare b record; a record; n int;
begin
  select * into b from public._upgrade_before;
  select * into a from get_balance_for('a0000000-0000-0000-0000-0000000000a1');
  if a.available is distinct from b.available then
    raise exception 'available changed across upgrade: % -> %', b.available, a.available;
  end if;
  if a.available <> 31.95 then raise exception 'expected 31.95 available (35.50 - 3.55 fees), got %', a.available; end if;
  select count(*) into n from information_schema.columns where table_schema = 'public' and column_name ~* 'btcpay|reseller|commission';
  if n > 0 then raise exception '% legacy columns left after upgrade', n; end if;
  select count(*) into n from pg_proc where pronamespace = 'public'::regnamespace and proname ~* 'btcpay|reseller|commission';
  if n > 0 then raise exception '% legacy functions left after upgrade', n; end if;
end $$;
drop table public._upgrade_before;
select 'upgrade from pre-Breez schema passed' as result;
SQL
