# cpay payment service

A long-running Node 22 process that holds the one cpay Breez SDK Spark
wallet. Breez's SDK cannot run inside Supabase edge functions (it fails to
connect under Deno, and it needs a process that stays up to receive
events), so this is the only part of cpay that talks to Breez.

Custody: this wallet receives every creator's payments, the same model
cpay had with its BTCPay store. Whoever holds `BREEZ_MNEMONIC` holds all
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
- `GET /health` returns 200 when the database answers and the wallet has
  synced in the last 10 minutes, 503 otherwise. The `health` edge function
  calls it.

- Instant stablecoin withdrawals (migration 0095), called only by the
  `user-withdraw` edge function after it has checked the user's JWT:
  - `GET /withdraw/routes` lists the coin and network pairs Breez can send
    to right now, from `getCrossChainRoutes` for each address family (EVM,
    Solana, Tron), keeping only routes funded with BTC. Cached 10 minutes,
    so a route Breez adds shows up without a deploy.
  - `POST /withdraw/quote {userId, routeId, address, amountUsd}` checks the
    amount (at least $5, whole cents, within the available balance and the
    route's limits) and that `sdk.parse` reads the address as the route's
    family. It takes the profile's `withdrawal_fee_percent` as the platform
    fee, converts the rest to sats at the Breez BTC/USD rate (rounded
    down), and asks `prepareSendPayment` for a cross-chain quote with fees
    included. The answer shows the amount, platform fee, Breez fee, what
    arrives (and the minimum after 1% slippage) and when the quote expires.
    Quotes live in memory, so a restart makes open quotes expire.
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
  - Cross-chain sends are mainnet only: on other networks the SDK rejects
    `crossChainConfig` and lists no routes, so the list is empty.

All routes need `Authorization: Bearer $PAYMENT_SERVICE_SECRET`.

## Run

```sh
cp .env.example .env   # fill in; .env and .data/ are gitignored
npm ci
node --env-file=.env server.mjs
```

Edge function secrets: `PAYMENT_SERVICE_URL` (where this listens) and
`PAYMENT_SERVICE_SECRET` (same value as here). `DATABASE_URL` must be a
role that can execute `settle_breez_payment`,
`reserve_stablecoin_withdrawal` and `finalize_stablecoin_withdrawal` and
update `payments`; the
Supabase `postgres` connection string works.

Wallet state lives in `BREEZ_DATA_DIR`, so the host needs a persistent
disk. The seed alone restores the wallet if that directory is lost.

## Test

`DATABASE_URL=... node --test` runs against a database with every
migration applied. `ledger.test.mjs` works inside a transaction that is
rolled back. `withdraw.test.mjs` commits (confirm and crash recovery need
several connections), uses fresh users and deletes them at the end; it
drives `withdraw.mjs` with a fake Breez SDK, since regtest has no
cross-chain routes.

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
