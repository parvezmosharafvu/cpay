# Breez wallet on Supabase (Spark) — design and cutover

Status: **built, not deployed, off.** The VM (cpay-pay-ci-vm) still runs the wallet.

## Problem
The owner wants the platform's Breez Lightning wallet to run on Supabase
instead of the Azure VM payment-service, keeping the same seed, API key and
the same API the Edge Functions already call.

## What the VM runs
`payment-service` uses `@breeztech/breez-sdk-spark@0.26.0` (Spark variant),
file storage in /data, one long-running process. API (all but /health,
/ready require an HMAC-signed request with PAYMENT_SERVICE_SECRET;
/admin/wallet/* also needs `x-cpay-admin-token`, ADMIN_JWT_MODE=required):
`POST /invoices`, `GET /withdraw/routes`, `POST /withdraw/quote|confirm`,
`/admin/wallet/*`, `GET /metrics`, `GET /health`, `GET /ready`.

## Solution
`supabase/functions/breez-wallet/` serves the same contract by running the
**same code**: `core/` is a byte-for-byte copy of payment-service's
app/ledger/receipts/withdraw/wallet/auth/money modules (CI fails on drift;
`scripts/sync-breez-core.sh` re-copies). `node-shim.ts` adapts fetch
Request/Response to the Node handler.

- **SDK:** `npm:@breeztech/breez-sdk-spark@0.26.0/deno`, built with
  `SdkBuilder.new(config, seed).withStorageBackend(postgresStorage(...))`.
  `pg-globals.ts` installs the package's own pg-backed stores, which the
  Deno build expects as globals.
- **Storage:** Postgres schema `breez_wallet` (SDK creates its `brz_*`
  tables there through `search_path`). Schema privileges are revoked from
  public/anon/authenticated, and the schema is not exposed to PostgREST.
  Our own tables have RLS on and no policies.
- **One instance only:** before connecting the SDK an isolate takes the
  session advisory lock `breez_wallet.lock_key()` on a dedicated connection.
  It serves requests while busy, then after 5 s idle it drains, disconnects
  and unlocks. A killed isolate drops its connection, so Postgres frees the
  lock. Other isolates wait up to 20 s, then answer 503 `wallet busy`.
  `lease_log` records each holder.
- **Off switch:** every wallet call checks `breez_wallet.control`
  (`enabled=true AND owner='supabase-edge'`): before and after taking the
  lock, and again on each request while a lease is held. A holder that sees
  the switch off answers 503 and releases the lease once in-flight work
  drains. The default is off, owner `azure-vm`.
- **Idempotency:** unchanged from the VM. Invoices use a per-payment
  advisory xact lock plus attach-once. Sends use `idempotencyKey = withdrawal id`,
  and `sending` rows are reconciled after a completed sync.
- **Replay protection across isolates:** the signature is verified, then
  the nonce is claimed in `breez_wallet.request_nonces` (`claim_nonce`).
- **Incoming payments:** SDK events are seen while a lease is held. The
  rest comes from pg_cron, which runs `POST /functions/v1/breez-wallet/cron/sync`
  every minute (`x-cron-secret`, Vault `cpay_cron_secret`) and runs the same
  `catchUp()` (listPayments since the oldest open invoice, expiry,
  withdrawal reconcile). It is scheduled only by `breez_wallet.schedule_sync()`,
  which refuses while the switch is off.
- RECEIPT_RECORDING is hard-coded `off`; REQUEST_AUTH_MODE is hard-coded `signed`.

## Files / DB changes
- `supabase/migrations/20261013010000_breez_wallet_spark_schema.sql`
- `supabase/functions/breez-wallet/{index,runtime,node-shim,pg-globals}.ts`, `core/*.mjs`, `runtime_test.ts`
- `scripts/sync-breez-core.sh`, CI step in `.github/workflows/verify.yml`
- `supabase/config.toml` has `[functions.breez-wallet] verify_jwt = false` (#49, cutover step 5).
  Whether or not it is deployed, it stays off until `breez_wallet.control` is switched on.

## Security
No secret lives in the repo, the migration, or logs (log lines are redacted
for mnemonic, API key, service secret, cron secret and DB URL). Config errors
name variables only. The seed lives in Edge secrets, which is weaker
isolation than the VM's root-only file, because anyone with the project's
management access can read or replace it. Admin sends still need a verified
admin Supabase session.

## Tests
`deno test supabase/functions/breez-wallet/` (Deno 1 and 2) covers:
- off → 503, with no SDK connect and no lock taken
- bearer or bad signature → 401
- signed /metrics → 200, with the same contract as the VM
- a replayed nonce from another isolate → 401
- a second instance → 503 `wallet busy` while the first holds the lease,
  then served after release
- admin send without a verified token → 401
- switch turned off while a lease is held → 503 and the lease is released
- /health never takes the lease
- core/ drift check

The migration applies on the CI-shaped DB, and the anon/authenticated RPC
allowlists still pass. The SDK Deno build and postgres storage were
smoke-loaded, but **not connected to a real wallet** (no seed used).

## Open risks (verify on regtest before mainnet)
1. **Edge limits:** an Edge isolate has a CPU time budget, limited memory
   and a wall-clock cap. A WASM SDK connect + sync per lease may exceed CPU
   or be slow, adding seconds of latency to invoice creation on a cold lease.
2. **State move:** the VM uses file storage. A fresh Postgres store
   re-derives wallet state from Spark operators by seed. Balance should match,
   but local-only data (payment history, metadata) may differ. Check against
   the VM before switching.
3. **Connection mode:** BREEZ_DB_URL must be session mode (direct db host or
   Supavisor session pooler on port 5432). The transaction pooler breaks
   session advisory locks.
4. Leaf optimization interrupted by an isolate kill leaves a ~5 min send
   reservation (same as a VM crash; see RUNBOOKS).
5. Events between leases are not live; settlement latency is up to the cron
   interval (1 min) unless a request holds the lease.

## Cutover (owner, in this order)
1. Regtest dry run with a throwaway seed on a branch project.
2. Merge this PR (migration only; the function stays undeployed and off).
3. Stop the VM wallet: `systemctl stop` / `docker stop` payment-service on
   cpay-pay-ci-vm. Do not delete the VM or /data. Confirm it is stopped.
4. The owner enters Edge secrets via the secure form: `BREEZ_MNEMONIC`,
   `BREEZ_API_KEY`, `BREEZ_NETWORK=mainnet`, `BREEZ_DB_URL`.
   `PAYMENT_SERVICE_SECRET` and `CRON_SECRET` already exist.
5. Add `[functions.breez-wallet] verify_jwt = false` to config.toml and deploy.
6. `update breez_wallet.control set enabled = true, owner = 'supabase-edge', updated_at = now();`
   then `select breez_wallet.schedule_sync();`
7. Set Edge `PAYMENT_SERVICE_URL=https://riumaeihemgznvgattoc.supabase.co/functions/v1/breez-wallet`.
8. Check /metrics (signed), the admin wallet balance vs. the VM's last
   value, and one small owner-run invoice.

## Rollback
1. `select breez_wallet.unschedule_sync();`
2. `update breez_wallet.control set enabled=false, owner='azure-vm';`
3. Wait for `lease_log.released_at`, i.e. no lock holder
   (`select * from pg_locks where locktype='advisory'`).
4. Restore PAYMENT_SERVICE_URL to the VM and start the VM payment-service.

Never run both at once.
