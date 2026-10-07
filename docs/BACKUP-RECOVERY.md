# Backup and recovery

## What must exist

| Asset | Where | Owner action |
|---|---|---|
| Postgres ledger | Supabase project backups / PITR | Confirm schedule; keep a recent snapshot before migrations |
| Ledger git snapshot | `ledger-backup` edge → private GitHub repo | `GITHUB_*` secrets; never on a public repo |
| Platform wallet | Mnemonic offline + `BREEZ_DATA_DIR` on payment-service host | Mnemonic never in Supabase or git |
| Orphan function source | Audit box copies under `cpay-audit/orphan-functions/` | Before deleting prod orphans |

## Daily / automated

- `ledger-backup` cron (Vault `cpay_cron_secret`) commits a ledger dump.
- `cpay-health` every 15 minutes; failures → webhook / Telegram when configured.

## Recovery sketches

**Database.** Restore Supabase snapshot or PITR to before the bad event; re-apply
only migrations that are missing. Reconcile payment-service catch-up after DB
restore (startup catch-up settles wallet receives and reconciles `sending`).

**payment-service host.** Redeploy binary/image; restore `BREEZ_DATA_DIR` if
available; otherwise restore from mnemonic and wait for full sync. Open quotes
are memory-only and drop on restart — users re-quote. Confirmed withdrawals
reconcile from the DB + SDK idempotency keys.

**Edge function wrong version.** Redeploy from a known git tag/SHA.

**Accidental orphan delete.** Redeploy from orphan-functions backup with
`--no-verify-jwt` only if you intentionally restore that surface (prefer leave
deleted).

## Drills

Run a restore drill on **staging** before relying on production backups. Record
date (Asia/Dhaka) and who performed it in the staging sign-off ledger.
