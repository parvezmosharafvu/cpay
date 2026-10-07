# cpay payment service

A long-running Node 22 process that holds the one cpay Breez SDK Spark
wallet. Breez's SDK cannot run inside Supabase edge functions (it fails to
connect under Deno, and it needs a process that stays up to receive
events), so this is the only part of cpay that talks to Breez.

Custody: this wallet receives every creator's payments and holds them
until they are withdrawn. Whoever holds `BREEZ_MNEMONIC` holds all
unwithdrawn creator money. Whether cpay may hold it is a legal question
to settle before mainnet.

## What it does

- `POST /invoices {"paymentId": "<uuid>"}` makes a bolt11 for a `payments`
  row that `create-invoice` inserted. It reads the USD amount from the row,
  prices it with the Breez BTC/USD rate (rounded up to whole sats), and
  stores `invoice_ref` (payment hash), `lightning_invoice`, `amount_sat`
  and `btc_usd_rate`. A second call for the same row returns the same
  invoice.
- Every `paymentSucceeded` event is passed to `settle_breez_payment()`
  (migration 0094), which credits a row at most once.
- On startup and every `CATCH_UP_INTERVAL_SECS` it lists completed
  receives since an hour before the oldest unsettled invoice (last 7 days) and passes
  each to the same function, so payments received while the service was
  down or an event was missed still settle. The same pass marks unpaid
  invoices past `expires_at` as `expired`.
- Receipt log, record-only (migration 20261003050000), only when
  `RECEIPT_RECORDING=shadow` (default `off`): before each completed receive
  goes to `settle_breez_payment()`, `receipts.mjs` records it with
  `record_lightning_receipt()` on a separate pool (2 connections, 1 s connect
  wait, 2 s statement timeout, 2.5 s client timeout), then copies the legacy
  outcome next to it. Settlement itself is unchanged, and any recording
  failure (missing function, constraint, timeout, connection error, mapping
  error) is logged as `receipt-record-failed` and settlement runs exactly as
  without recording. The stored payload is an allowlist of plain fields
  (never the invoice, description, preimage or any key material). Nothing in
  it credits, evaluates or changes a payment.
- `GET /health` needs no secret, so a host's health check can call it. It
  returns 200 when the database answers, the SDK answers, the wallet has
  synced in the last 10 minutes and the service is not shutting down, 503
  otherwise. The body is only `ok`, `sdkConnected`, `db`, `synced`,
  `lastSyncedAt` and `shuttingDown`: no balance, id or setting. The `health`
  edge function calls it.
- `GET /ready` needs no secret. It returns 200 only after the startup
  catch-up has finished and while the process is not draining (503
  otherwise). Prefer this for load-balancer readiness probes; keep
  `/health` for ongoing liveness/sync freshness.
- `GET /metrics` requires `Authorization: Bearer $PAYMENT_SERVICE_SECRET`.
  Process counters only (`invoicesAttached`, settle/withdrawal outcome
  tallies, `catchUps`, `withdrawalStuck`, `inflight`, `authRejected`, …)
  plus `singleWallet: true`. No balances, payment ids, invoices or
  configuration secrets. Custody model: one Breez Spark wallet holds all
  unsettled creator funds.
- On SIGTERM or SIGINT the service stops taking requests (new ones get 503
  and the listener closes), waits up to `SHUTDOWN_TIMEOUT_SECS` for work in
  flight (requests, creator withdrawal sends, admin sends, settles, leaf
  optimization), then disconnects the SDK and closes the database pool. It
  exits 0 if everything finished and 1 if the timeout cut something off. A
  send cut off that way stays `sending` and the next start reconciles it
  against the wallet; it is never sent twice.

- Instant stablecoin withdrawals (migration 0095), called only by the
  `user-withdraw` edge function after it has checked the user's JWT:
  - `GET /withdraw/routes` lists the coin and network pairs Breez can send
    to right now, from `getCrossChainRoutes` for each address family (EVM,
    Solana, Tron), keeping only routes funded with BTC. Cached 10 minutes,
    so a route Breez adds shows up without a deploy.
  - `POST /withdraw/quote {userId, routeId, address, amountUsd}` checks the
    amount (at least $5, whole cents, within the available balance and the
    route's limits) and that `sdk.parse` reads the address as the route's
    family. It takes `resolve_withdrawal_fee()` as the platform fee (account
    override, else the global default, 0% since 0100; 20261005020000),
    converts the rest to sats at the
    Breez BTC/USD rate (rounded down), and asks `prepareSendPayment` for a
    cross-chain quote with fees included. The answer shows the amount,
    platform fee, `networkFeeUsd` (the swap plus network fee, exact: what is
    sent minus what arrives), what arrives (and the minimum after 1%
    slippage) and when the quote expires. A prepare error is logged and the
    user gets a generic message, never the SDK's text. Quotes live in
    memory, so a restart makes open quotes expire. `user-withdraw` passes
    creators an allowlisted copy of these answers (no processor names,
    ids, sats or rates; see `docs/ARCHITECTURE.md`).
  - `POST /withdraw/confirm {userId, quoteId}` re-quotes and answers 409
    with the new quote if this one expired. Otherwise
    `reserve_stablecoin_withdrawal()` takes the balance and inserts a
    `sending` row in one transaction, then `sendPayment` runs with the row
    id as the idempotency key. It answers once the send returns or after
    25 seconds, whichever is first.
  - `finalize_stablecoin_withdrawal()` marks the row `paid` when Breez
    reports the cross-chain delivery complete, or `failed` (which returns
    the balance) when the Spark transfer failed, the swap was refunded, or
    the SDK refused before any transfer. It only moves `sending` rows, so a
    refund happens once. A swap that failed without a refund stays
    `sending` and is logged as `withdrawal-stuck` for a person to resolve;
    the `health` edge function flags `sending` rows older than 15 minutes.
  - Payment events for sends, and every catch-up pass, look up each
    `sending` row with `getPayment(<withdrawal id>)`. A row with no payment
    is refunded only after a completed sync and once its quote expired 10
    minutes ago; the SDK refuses to start an expired quote, so no transfer
    can appear after that. This is what makes a crash mid-send safe.
  - A send that fails with `Failed to select leaves` (a stale `Swap`
    reservation left in the SDK's local tree store by a process that died
    mid leaf-optimization; the store drops it after 5 minutes, on the next
    sync) is retried: back off 5 s doubling to 60 s, `syncWallet`, check
    `getPayment(<key>)` and stop if the last attempt made a payment, then
    send again with the same idempotency key. Retries stop after about 6
    minutes or at the quote's expiry, whichever is first; the row stays
    `sending` meanwhile and is then failed, which returns the balance.
    Admin wallet sends retry the same way.
  - Cross-chain sends are mainnet only: on other networks the SDK rejects
    `crossChainConfig` and lists no routes, so the list is empty.

- The platform wallet for the admin Wallet tab (`wallet.mjs`), called only
  by the `admin-actions` edge function at `/admin-wallet` after
  `verifyAdminCaller` has checked the JWT belongs to an admin. Every
  `POST /admin/wallet/<action>` carries `adminId`, and the service answers
  403 unless that profile's role is `admin`, so the secret alone cannot
  move money.
  - `info`: `balanceSats` from `getInfo`, USD at the `listFiatRates` rate,
    what the platform owes creators (every available balance plus
    withdrawals not yet paid, `owedToCreatorsUsd`) and `spendableSat`, the
    balance minus that.
  - `payments {offset, limit}`: `listPayments`, newest first, up to 50 a
    page. Amounts are strings (the SDK returns bigints).
  - `receive {amountSat, memo}`: a bolt11 from `receivePayment`, one hour.
    A payment into it matches no `payments` row, so
    `settle_breez_payment()` answers `unknown` and no creator is credited.
  - `addresses`: the Spark address (`receivePayment` with `sparkAddress`)
    and the Lightning address from `getLightningAddress`, if one is
    registered.
  - `send-prepare {destination, amountSat?}` then `send-confirm
    {prepareId}`: `parse` picks the path. A bolt11 or Spark address goes
    through `prepareSendPayment`/`sendPayment`; a Lightning address or LNURL
    through `prepareLnurlPay`/`lnurlPay`. Prepare shows the Breez fee and
    holds for 10 minutes.
  - `stable-routes`, `stable-quote {routeId, address, amountUsd}`,
    `stable-confirm {quoteId}`: the route catalog, `validateAddress` and
    `prepareCrossChain` from `withdraw.mjs`, without the creator ledger.
  - `fiat`: `listFiatCurrencies` joined with `listFiatRates`, USD first. A
    rate of 0 (regtest lists BGN and VES at 0) shows as no rate.
  - Every send is refused if amount plus fee is more than `spendableSat`,
    checked at prepare and again at confirm. Confirm writes
    `platform_wallet.send` to `audit_log` before the send and
    `platform_wallet.send.result` after, with the prepare id as the
    subject and the Breez idempotency key. It never writes `withdrawals`
    or `payments`, and the withdrawal reconciler ignores these sends.

Every route except `/health` needs `Authorization: Bearer
$PAYMENT_SERVICE_SECRET`, compared in constant time. Log lines are JSON, one
per line, and pass through a redactor that removes the secret, API key,
wallet words and database URL.

## Run

```sh
cp .env.example .env   # fill in; .env and .data/ are gitignored
npm ci
node --env-file=.env server.mjs
```

Every setting is in `docs/ENV_VARS.md` (Payment service). Put the wallet
words in a file only the service user can read and set
`BREEZ_MNEMONIC_FILE` to it. `Dockerfile` builds a non-root image with
`/data` as the wallet volume; `docs/payment-service-deploy.md` covers Fly.io,
Railway and a VPS with systemd.

Edge function secrets: `PAYMENT_SERVICE_URL` (where this listens) and
`PAYMENT_SERVICE_SECRET` (same value as here). `DATABASE_URL` must be a
role that can execute `settle_breez_payment`,
`reserve_stablecoin_withdrawal`, `finalize_stablecoin_withdrawal`,
`resolve_withdrawal_fee` and `self_withdraw_allowed` and update `payments`; the
Supabase `postgres` connection string works.

Wallet state lives in `BREEZ_DATA_DIR`, so the host needs a persistent
disk. The seed alone restores the wallet if that directory is lost.

## Test

`DATABASE_URL=... npm test` runs against a database with every migration
applied, one file at a time (a service start reconciles every `sending`
withdrawal in the database, so files must not overlap).
`service.test.mjs` starts the real service over HTTP with a fake SDK: auth,
input checks, `/health`, log redaction, and graceful shutdown with a send,
an admin send and leaf optimization in flight. `balance-guard.test.mjs`
checks migration 0105: no withdrawal row may take a balance below zero,
including two at once. `receipts.test.mjs` covers the receipt log: every
recording failure mode leaves settlement as on main, a golden fixture set
answers identically with recording off and on, repeat deliveries make one
receipt, recording changes no balance or payment, and the payload allowlist. `config.test.mjs` covers every variable. `ledger.test.mjs` works inside a transaction that is
rolled back. `withdraw.test.mjs` commits (confirm and crash recovery need
several connections), uses fresh users and deletes them at the end; it
drives `withdraw.mjs` with a fake Breez SDK, since regtest has no
cross-chain routes. `wallet.test.mjs` does the same for `wallet.mjs`: 403
for every action unless `adminId` is an admin, the secret compared exactly,
admin sends audited twice and leaving creator balances and `withdrawals`
alone, and sends above the spendable balance refused.

## Lightning addresses (designed, not built)

The Breez-hosted LNURL server gives one address per wallet per domain,
and cpay has one wallet, so per-creator addresses (`slug@cpay-domain`)
have to be answered by cpay itself (LUD-16):

1. `GET https://<domain>/.well-known/lnurlp/<slug>` returns
   `{tag: "payRequest", callback, minSendable, maxSendable, metadata}`.
   The Cloudflare worker routes it to a new edge function.
2. The wallet calls `callback?amount=<msat>`. The edge function runs the
   same checks as `create-invoice` (emergency stop, active link, profile
   limit, rate limit), inserts a `payments` row and calls
   `POST /invoices` with a new `amountSat` field, because LUD-06 requires
   the invoice to be for exactly the msat the wallet asked for.
   `amount_requested` is that amount in USD at the quoted rate. It returns
   `{pr: bolt11, routes: []}`.
3. Settlement is unchanged: the payment hash is on the row.

Blocker found while designing it: LUD-06 requires the invoice's
description hash to equal `sha256(metadata)`, and SDK 0.26
`receivePayment` only sets a plain memo (`crates/breez-sdk/core/src/sdk/payments/receive.rs`
in github.com/breez/spark-sdk passes `InvoiceDescription::Memo` on both
paths). The Spark layer underneath supports a description hash; the
public SDK does not expose it. Strict wallets would reject cpay's
invoices. The ways forward are asking Breez to expose it, or self-hosting
Breez's LNURL server (`crates/breez-sdk/lnurl`), which also allows one
username per wallet and would need changing.

Not built in this phase because of that blocker, because payer-chosen
amounts need a pricing rule (does the link markup apply?), and because the
regtest network has no Lightning network to test it against.
