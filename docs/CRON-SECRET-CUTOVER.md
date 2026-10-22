# CPAY scoped cron credential cutover

**Review source only (2026-10-22).** No production secrets, Vault rows,
scheduled jobs, payment flow or deployed function was changed. This is
not a production-ready approval; the shared-cron blocker stays open.

| Endpoint | Optional dedicated Edge secret |
|---|---|
| daily-report | DAILY_REPORT_CRON_SECRET |
| ledger-backup | LEDGER_BACKUP_CRON_SECRET |
| health | HEALTH_CRON_SECRET |
| telegram-notify | TELEGRAM_NOTIFY_CRON_SECRET |
| breez-wallet/cron/sync | BREEZ_WALLET_CRON_SECRET |

Dedicated value takes full precedence over `CRON_SECRET`. Even an empty
configured override blocks requests. Prior legacy callers cannot authenticate
with the common value after a function's dedicated value is set.

## Owner-only operational procedure

1. Inventory **all** live `cron.job` entries, Edge endpoints, Vault secret
   names and external callers using the common value. Historical schedules
   may include another caller not listed above. Inspect without printing
   decrypted secrets.
2. Create one unique, high-entropy secret **per endpoint** in a private
   secret manager. Do not paste secret contents into SQL migrations, source
   code, PR comments, screenshots or chat.
3. After separately authorizing the deployment, cut over **one schedule at
   a time**. Coordinate its Vault request secret and function-specific Edge
   secret; updating only one will temporarily break its job. Do not create
   duplicate money-moving cron schedules. Stage and verify rollback steps.
4. Confirm an obsolete common value gets HTTP 401 and the dedicated value
   authenticates. Check the relevant actual job output and several scheduled
   runs: wallet catch-up, ledger backup, daily statistics, health and alert
   delivery. Never hand either secret to a third-party monitor.
5. After every caller is verified migrated, rotate/remove the shared value
   from Edge secrets, Vault and any external runner. Keep the Medium blocker
   open until private, dated operator evidence documents that completion.

Source tests: `tests/frontend/scoped-cron-secret.test.mjs`. They prove
override precedence and endpoint wiring; they cannot prove a live cutover.
