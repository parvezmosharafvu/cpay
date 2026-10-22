# Backup and recovery

## What must exist

| Asset | Where | Owner action |
|---|---|---|
| Postgres ledger | Supabase project backups / PITR | Confirm schedule; keep a recent snapshot before migrations |
| Ledger git snapshot | `ledger-backup` edge → private GitHub repo | `GITHUB_*` secrets; never on a public repo |
| Platform wallet | Mnemonic offline (owner) + an Edge secret; wallet SDK state in its own locked Postgres schema | Mnemonic never in git; the Azure VM host is gone |
| Orphan function source | Audit box copies under `cpay-audit/orphan-functions/` | Before deleting prod orphans |

## Daily / automated

- `ledger-backup` cron (Vault `cpay_cron_secret`) commits a ledger dump.
- `cpay-health` (cron job `cpay-health`, `*/15 * * * *`, secret read from Vault
  `cpay_cron_secret`). **Scheduled in production on 2026-10-13 11:48 Dhaka.**
  Before that date no health job existed, although an earlier version of this
  page said it did. Failures go to Telegram (`ALERT_TELEGRAM_*`) and/or
  `ALERT_WEBHOOK_URL`. Check the alert path with `health?test_alert=1`, which
  sends one message labelled [TEST] and returns the delivery status.
- `ledger-backup` writes `ledger-backups/YYYY-MM-DD.json` to the private repo
  named by the `GITHUB_OWNER`/`GITHUB_REPO` secrets. It answers 200 only after
  the GitHub commit succeeds, and 500 plus an alert on an incomplete snapshot
  or a failed commit. The function edge log is the proof of a run.

## Recovery sketches

**Database.** Restore Supabase snapshot or PITR to before the bad event; re-apply
only migrations that are missing. Reconcile payment-service catch-up after DB
restore (startup catch-up settles wallet receives and reconciles `sending`).

**Platform wallet.** Since 2026-10-13 it runs as the wallet Edge Function
(see that function's README under `supabase/functions/`). The Azure VM host was
deleted; there is no standby. Recovery = seed restore on a new host (that
README, "Rollback / disaster recovery") and wait for full sync. Open quotes
are memory-only and drop on restart — users re-quote. Confirmed withdrawals
reconcile from the DB + SDK idempotency keys.

**Edge function wrong version.** Redeploy from a known git tag/SHA.

**Accidental orphan delete.** Redeploy from orphan-functions backup with
`--no-verify-jwt` only if you intentionally restore that surface (prefer leave
deleted).

## Drills

Run a restore drill on **staging** before relying on production backups. Record
date (Asia/Dhaka) and who performed it in the staging sign-off ledger.

### Drill log

| Date (Dhaka) | Who | Source | Target | Result |
|---|---|---|---|---|
| 2026-10-13 11:50 | Audit agent | Read-only JSON export from production of auth.users (id, email, created_at), profiles, payment_links, payments, withdrawals, daily_stats | Disposable local Postgres: CI bootstrap + every migration in the repo, rows loaded with triggers off | **Pass.** Rows: users 18, profiles 18, links 1, payments 4, withdrawals 0, daily_stats 24, all equal to production. Every payment field round-tripped with no differences. `get_balance_for()` matched production for **18/18** accounts. Settled: 3 payments, $21.63, fees $0.32, 25,940 sat. Total available $21.31 on both sides. The repo schema had no column drift against production. The DB and the export were destroyed afterwards. |

**Gaps found by the drill:**
- The private ledger-backup repo is not readable with the audit's GitHub
  access. The drill therefore used a fresh export, not the backup file. The last
  run (2026-10-13 00:15 Dhaka) answered 200, which the code returns only after
  the GitHub commit succeeds. The owner should open
  `ledger-backups/2026-10-13.json` once to confirm.
- The ledger backup omits the wallet schema and the audit, receipt and webhook
  tables. Wallet recovery relies on the seed plus SDK sync. A full-database
  restore relies on Supabase backups/PITR (owner to confirm the plan).
- Restoring into staging Supabase (Auth, Edge) is not covered. This drill
  checked data and ledger math only.

## Closing the gaps (owner checklist)

None of these can be done from the repository; each needs the Supabase
dashboard or the private backup repo. Record each in the drill log above.

1. **Confirm PITR / backup plan.** Supabase dashboard → Project → Database →
   Backups. Note the plan, whether *Point in time* is enabled, and the
   retention window. Without PITR the restore point is the last daily
   backup, so a bad event late in the day loses up to 24 h of ledger rows;
   then the ledger git snapshot is the only finer-grained copy of
   payments and withdrawals.
   *Historical verification (2026-10-14):* the organisation was on
   the Supabase **Free plan** at that date. The later
   [release-blockers record](RELEASE-BLOCKERS.md) reports an upgrade to
   **Pro on 2026-10-16**, with daily backups available. Do not reuse
   the earlier "Free plan today" finding as current evidence.
   **Still unverified:** whether PITR is enabled, the actual retention
   and last successful backup in the active project, and a tested
   restoration of current Auth, wallet and ledger state. The earlier
   export drill does not close those gaps. The owner must inspect the
   backup settings and record a separate, safely isolated restore
   rehearsal before approving production release. Keep manual pre-change
   snapshots private until full coverage is independently confirmed.
   The ledger-backup run itself: the 18:15 UTC run answered
   `backed up`, `verified: true` (payments 4, withdrawals 0, payment links 1,
   profiles 18, daily stats 26). No repository visible to the audit's GitHub
   access received that commit, so the target repo's visibility could not be
   checked from here: the owner confirms it is **private** (step 2).
2. **Open the latest snapshot.** In the private repo named by
   `GITHUB_OWNER`/`GITHUB_REPO`, open `ledger-backups/<today>.json` and
   check that the counts match the admin dashboard, and that the repo's
   visibility is **Private** (repo → Settings → General). Do not copy it
   anywhere public.
3. **Staging restore drill (Auth + Edge).** On a staging project only:
   restore the latest backup (or PITR to a chosen time); deploy the Edge
   functions from the git SHA that production runs; set staging's own
   secrets (never production's); sign in as a test user and an admin; check
   `get_my_balance()` and the admin totals match the snapshot. Delete or
   pause the staging project afterwards.
4. **Coverage decision for the git snapshot.** Today it holds payments,
   withdrawals (destination last 4 only), payment links, profiles and
   daily stats. Audit, receipt and webhook tables and the wallet SDK schema
   are not in it, by design: they are large, contain more personal data,
   and the wallet schema is rebuilt from the seed. If PITR is **not**
   available (step 1), extend `ledger-backup` to add the audit table with
   the same redaction rules, as a separate reviewed change.

### Standalone CPAY Wallet (users' own wallets)

Nothing to back up on CPAY's side: CPAY never holds those keys or that
data. Recovery is the user's 12-word phrase (plus, for an operator
outage, the exit backup file); see `docs/WALLET-APP.md` (added with the
wallet, PR #104).
