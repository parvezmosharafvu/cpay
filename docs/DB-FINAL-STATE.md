# Database final state (audit P3)

Generated 2026-10-13 from a fresh replay (`ci/bootstrap.sql` +
`ci/supabase_default_privileges.sql` + all migrations) and compared, read-only,
with production using the same query, [`ci/db_inventory.sql`](../ci/db_inventory.sql).
CI re-generates the replay inventory on every run (artifact `db-inventory`).

| Object | Fresh replay | Production | Match |
|---|---|---|---|
| Tables (RLS enabled on all) | 25 | 25 | yes |
| Columns | 287 | 287 | yes |
| Functions (owner, SECURITY DEFINER, search_path, anon/auth EXECUTE) | 159 | 159 | yes, every attribute |
| Policies | 25 | 25 | yes |
| Triggers | 19 | 19 | yes |
| Realtime publication tables | 3 | 3 | yes |
| anon / authenticated table grants | 81 / 85 | 81 / 85 | yes (before 20261013030000) |
| Constraints | 136 | 140 | no: 4 CHECKs only in production, codified by 20261013030000 |
| Leftover BTCPay / reseller / commission / moderator objects | 0 | 0 | yes |
| pg_cron jobs | 0 | 5 | expected: jobs carry project URLs and are created out of band |

Production cron jobs: the wallet sync job (every minute), `cpay-telegram-send`
(every minute), `daily-report-trigger`, `ledger-backup-trigger`,
`receipt-review-sweep` (every 10 min).

## Role model (locked)

| Role value | Meaning | Status |
|---|---|---|
| `creator` | Freelancer (user-facing term) | active |
| `admin` | operator | active |
| `reseller` | — | removed (20261005020000); CHECK rejects it |
| `moderator` | staff role | retired; CHECK `role in ('creator','admin')` rejects new assignment |
| commission | — | removed (20261005010000) |

`moderator` and `reseller` remain only in the reserved-slug list (so nobody can
claim those URLs), not as routes.
