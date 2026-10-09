# cpay runbooks

Internal. Commands assume the service's host shell for the payment service,
and the Supabase SQL editor (or `psql` on the service-role connection) for
SQL. Never paste a mnemonic, key or secret into a ticket or chat.

## Is everything healthy?

```bash
curl -H "x-cron-secret: $CRON_SECRET" "$SUPABASE_URL/functions/v1/health?alert=0"
```

`health` (every 15 min through `cpay-health`) checks: the payment service
answers `/health` (database reachable, wallet synced in the last 10 min),
cron is alive, no manual withdrawal is pending over 24 h, and no stablecoin
withdrawal is `sending` over 30 min. Failures go to `ALERT_WEBHOOK_URL`
and/or Telegram.

The service's own view: `GET /health` needs no secret and returns only
`ok`, `sdkConnected`, `db`, `synced`, `lastSyncedAt` and `shuttingDown`,
with 200 when all is well and 503 otherwise. `GET /ready` is 200 after
startup catch-up and while not draining. `GET /metrics` (bearer secret)
exposes process counters only — never balances. The wallet balance comes from the admin
wallet `info` action (`POST /admin/wallet/info`) and the withdraw route cache
from `GET /withdraw/routes`, both behind the bearer secret.

Owner cutover steps for orphan Edge Functions and Telegram secrets:
`docs/OPS_OWNER_CUTOVER.md` (do not delete or set secrets without approval).

## Restart the payment service

Safe at any time; nothing is lost.

1. Stop it (`SIGTERM`; it closes the listener, disconnects the SDK and the
   pool). Keep `BREEZ_DATA_DIR` on its persistent disk.
2. Start it: `node --env-file=.env server.mjs` (or the host's service
   manager). On boot it syncs the wallet, runs a catch-up (settles every
   completed receive since an hour before the oldest unsettled invoice, marks
   past-due invoices `expired`, reconciles `sending` withdrawals) and then
   listens. Look for `{"event":"catch-up",…}` then `{"event":"listening"}`.
3. Open quotes are in memory and are gone: users get "Quote not found. Get
   a new quote." and simply quote again. Confirmed withdrawals are in the
   database and are picked up by the reconcile.

If the data directory is lost, the mnemonic alone restores the wallet;
the first sync takes longer.

## Leaf error after a restart ("Failed to select leaves")

Cause: the process died during the SDK's automatic leaf optimisation and
left a `Swap` reservation in the local tree store. Until a sync after the
store's 5-minute reservation timeout clears it, every send fails with
`Failed to select leaves`, before any transfer.

What the service already does: a send hitting it is retried with backoff
(5 s doubling to 60 s), syncing and checking `getPayment(<idempotency
key>)` before each retry, with the same idempotency key, for up to about 6
minutes or until the quote expires. Log lines: `leaf-retry`, then either the
normal `finalize` or `send-error`. If the retries run out the withdrawal is
`failed` and the balance is returned once; the user can quote again.

What to do: usually nothing. If sends keep failing past ~10 minutes after a
restart, restart once more (a clean exit) and wait for the next sync; do
not delete `BREEZ_DATA_DIR`.

## Reconcile

There is no separate reconcile job: the service's catch-up is the
reconcile, every `CATCH_UP_INTERVAL_SECS` (default 300) and at startup.

- **Receives.** A payment that reached the wallet but whose row is not
  `settled` is settled by the next catch-up. To force one, restart the
  service. Check what is waiting:

  ```sql
  select id, status, amount_requested, amount_sat, invoice_ref, created_at
  from payments where status in ('new','pending','expired') and amount_sat is not null
    and created_at > now() - interval '7 days' order by created_at;
  ```

  `settle_breez_payment` answers `underpaid` (fewer sats than invoiced) or
  `not_settleable` (row marked `invalid` by an admin) without crediting;
  those need a person.
- **Stablecoin withdrawals.** Each `sending` row is looked up by its
  `payout_ref`/id. Delivered → `paid`; failed or refunded → `failed` (balance
  returned); no payment at all, after a completed sync and 10 minutes past
  the quote expiry → `failed`. A swap that failed *without* a refund stays
  `sending` and logs `withdrawal-stuck`: the sats left the wallet, so check
  the payment in the admin Wallet tab history before deciding. List them:

  ```sql
  select id, user_id, amount_requested, coin, chain, destination, payout_ref, requested_at, admin_note
  from withdrawals where method = 'stablecoin' and status = 'sending' order by requested_at;
  ```

- **Archive vs ledger.** `VERIFY-daily-stats.sql` compares `daily_stats`
  with the live ledger; `daily-report?days=30` rebuilds the archive.

## Backups

- **Ledger snapshot.** `ledger-backup` (cron `ledger-backup-trigger`, daily)
  commits `ledger-backups/<date>.json` to the private repo in
  `GITHUB_OWNER`/`GITHUB_REPO`: payments and withdrawals (redacted), links,
  profiles (id, name, role, fee) and `daily_stats`. Force one:

  ```bash
  curl -H "x-cron-secret: $CRON_SECRET" "$SUPABASE_URL/functions/v1/ledger-backup"
  ```

  Snapshots must never be committed to this repository (`.gitignore`, and
  CI's hygiene job reports any).
- **Database.** Supabase's own backups (daily, or PITR on paid plans) are
  the restore path for the full database. Take a manual backup before any
  migration.
- **Wallet.** The mnemonic, kept offline, is the wallet backup.
  `BREEZ_DATA_DIR` is a cache of wallet state and can be rebuilt from it.

## Emergency stops

Admin panel (emergency controls): **emergency payments stop** (create-invoice refuses
new invoices) and **emergency withdrawals stop** (every withdrawal path
refuses). Both are checked server-side.

## Service auth rollout

The payment service accepts a static bearer (legacy) and HMAC-signed
requests, and for `/admin/wallet/*` it can require the admin's own Supabase
session (`payment-service/auth.mjs`). Order, so no step can lock the Edge
Functions out:

1. Deploy a payment service that has `auth.mjs`. Add to `/etc/cpay/env`
   `SUPABASE_URL` and `SUPABASE_ANON_KEY` (public key). Leave
   `REQUEST_AUTH_MODE` and `ADMIN_JWT_MODE` unset (`any` / `optional`).
   `/metrics` now shows `requestAuthMode`, `adminJwtMode`,
   `authSigned`, `authBearer`, `adminTokenVerified`, `adminLegacy`.
2. Set the Edge secret `PAYMENT_SERVICE_AUTH_MODE=signed`. Check
   Admin → Health and watch `/metrics`: `authSigned` grows as the Edge
   Functions call in, `authBearer` stops growing.
   Open Admin → Wallet once: `adminTokenVerified` grows.
3. Set `REQUEST_AUTH_MODE=signed` and `ADMIN_JWT_MODE=required` on the host
   and restart (see [Restart the payment service](#restart-the-payment-service)).
   A bearer-only call now gets 401, and a wallet call without a valid
   active-admin session gets 401/403 (logged as `auth-refused` /
   `admin-auth-refused`, with a reason, never a value).

Rollback at any step: unset the variable just set (Edge or host) and
restart; each step only narrows what is accepted.
