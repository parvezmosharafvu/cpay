# cpay architecture

Internal document. It names the payment processor (Breez SDK Spark); the
freelancer, reseller and customer pages never do (see "What users see").

## Pieces

```
browser ──► public/ (static, Cloudflare Workers assets)
   │           │  supabase-js (anon key + user JWT, RLS applies)
   │           ▼
   │        Supabase ── Postgres: the ledger (payments, withdrawals, profiles …)
   │           │         RLS, SECURITY DEFINER functions, pg_cron jobs
   │           ▼
   │        Edge functions (Deno): create-invoice, user-withdraw, admin-actions,
   │           │                    health, daily-report, ledger-backup, og-image,
   │           │                    reseller-digest
   │           ▼  Bearer PAYMENT_SERVICE_SECRET
   └──────► payment-service/ (Node 22, one long-running process)
               holds the one platform wallet (Breez SDK Spark)
               writes the ledger through DATABASE_URL (service role)
```

- **Static frontend** (`public/`): landing, login/register, the freelancer
  desk (`dashboard.html` + `app.js`, `daily-desk.js`, `freelancer-desk.js`),
  the reseller desk (`reseller.html` + `reseller-desk.js`), the payment page
  (`404.html`: any unknown path is a link slug), the invoice page
  (`invoice-cpay-v2.html`), the storefront (`store.html`) and the admin
  panel (`admin.html`, `admin-classic.html`, `admin-*.js`). No framework; the
  only build step bundles `src/home-analytics.js`.
- **Edge functions** (`supabase/functions/`): the only server code the
  browser calls. `create-invoice` is public (no JWT; rate-limited per link
  owner). `user-withdraw` and `admin-actions` need a JWT; `admin-actions`
  re-checks the admin role in code (`verifyAdminCaller`). Cron-called
  functions need `x-cron-secret`.
- **payment-service** (`payment-service/`): the only process that holds the
  wallet mnemonic and talks to the processor. It cannot run in Deno edge
  functions (the SDK needs a process that stays up for events). Routes:
  `POST /invoices`, `GET /health`, `/withdraw/{routes,quote,confirm}`,
  `/admin/wallet/*`. Details in `payment-service/README.md`.
- **Supabase Postgres** is the ledger. Every balance rule lives in SQL.

## Data shape

| Thing | Where | Key columns |
|---|---|---|
| Payment link | `payment_links` | `slug`, `user_id`, `cost_percent` (payer markup), `wallet_mode`, `invoice_theme` |
| Invoice / payment | `payments` | `id`, `user_id`, `payment_link_id`, `amount_requested` (USD charged), `buyer_amount`, `status` (`new` → `settled` / `expired` / `invalid`), `invoice_ref` (**UNIQUE**, Lightning payment hash), `lightning_invoice` (bolt11), `amount_sat`, `btc_usd_rate`, `expires_at`, `settled_at` |
| Fee on a payment | `payments` | `platform_fee_amount`, `reseller_commission_amount`, `cost_percent`; stamped by `trg_stamp_payment_platform_fee` when a row turns `settled` |
| Balance | computed | `get_balance_for(user)`: settled earnings minus fees and commission, plus commission earned as reseller, minus withdrawals not `rejected`/`failed`. `get_my_balance()` is the signed-in wrapper |
| Withdrawal | `withdrawals` | `amount_requested`, `fee_percent`, `amount_after_fee`, `method` (`stablecoin` or manual `bkash`/`nagad`/`binance`/`lightning`/`bank`), `status` (`pending`/`approved`/`processing`/`paid`/`rejected`, and `sending`/`failed` for stablecoin), `destination` |
| Stablecoin withdrawal extras | `withdrawals` | `quote_id` (unique), `coin`, `chain`, `amount_sat`, `quoted_fee` (network fee, USD), `amount_out` (coins delivered), `quote_expires_at`, `payout_ref` (processor payment id, unique) |
| Withdrawal fee | `profiles.withdrawal_fee_percent` | per account; new accounts copy `app_settings.default_withdrawal_fee_percent`, which is **0** since 0100 |
| Event log | `webhook_events` | `delivery_id` unique: one row per received payment event (`breez:<payment id>`) |

## Ledger idempotency

A retry, a replayed event or a crashed process must never credit or pay
twice. Each money write has one gate that only lets the first attempt
through, inside one transaction:

- **Invoice creation.** `create-invoice` inserts the `payments` row first,
  then asks the service for a bolt11. `attachInvoice` only writes a row that
  has no invoice yet, so two concurrent calls return the same invoice. A row
  whose invoice was never made is deleted.
- **Receive settlement.** `settle_breez_payment(payment_id, hash, sats)` is
  the only code that credits a payment. It inserts `webhook_events` keyed by
  the processor payment id (a repeat returns `duplicate`), then updates only
  a row that is not yet settled, matched by `invoice_ref` (UNIQUE) and with
  enough sats. The service calls it for every payment event and again for
  every completed receive on each catch-up pass (startup and every
  `CATCH_UP_INTERVAL_SECS`), so a missed event still settles and a repeated
  one is harmless.
- **Stablecoin withdrawal.** `reserve_stablecoin_withdrawal()` locks the
  profile, returns the existing row if the quote was already confirmed
  (`quote_id` unique), otherwise checks balance and limits and inserts a
  `sending` row. The send uses the row id as the processor idempotency key,
  so a retried send cannot pay twice. `finalize_stablecoin_withdrawal()`
  only moves `sending` rows, so the refund (`failed`) happens once.
- **Manual withdrawal.** `request_withdrawal()` checks the balance under a
  profile row lock; `system_claim_withdrawal()` moves a row to
  `paid`/`processing`/`rejected` atomically, once.
- **Leaf-error retries** keep the same idempotency key and ask the processor
  whether the last attempt made a payment before sending again (see
  `docs/RUNBOOKS.md`).

## Receive flow

1. A payer opens `https://<site>/<slug>` (`404.html`), types an amount.
2. `create-invoice` checks the emergency stop, the link, the owner's limits
   and the per-owner rate limit, applies the link markup, inserts the
   `payments` row (`new`, 60-minute expiry) and calls `POST /invoices`.
3. The service prices it at the current BTC/USD rate (sats rounded up),
   creates the bolt11 and stores `invoice_ref`, `lightning_invoice`,
   `amount_sat`, `btc_usd_rate`.
4. The invoice page shows the QR (`lightning:` URI for any Lightning
   wallet) and **Open Cash App**, which opens
   `https://cash.app/launch/lightning/<bolt11>` (Cash App's own Lightning
   link, as returned by the SDK's buy-bitcoin helper). The link's "Who can
   pay" setting (`wallet_mode`: Cash App only, or Cash App and any Lightning
   wallet) sets which of the two the payment page leads with.
5. The payment arrives in the platform wallet; the service settles it (see
   above). The invoice page sees the row turn `settled` over Realtime.

Per-creator Lightning addresses (`slug@domain`) are designed but not built;
see `payment-service/README.md`.

## Instant stablecoin withdrawal

1. **Routes.** `user-withdraw {action:'routes'}` → service
   `GET /withdraw/routes`: the USDT/USDC networks the processor can reach
   (mainnet only), cached 10 minutes.
2. **Quote.** `{action:'quote', routeId, address, amount}`: at least $5,
   within the available balance. The service takes the account's platform
   fee (`withdrawal_fee_percent`, default 0), converts the rest to sats and
   prepares a cross-chain send with fees included. The quote carries the
   amount, the platform fee, `networkFeeUsd` (the swap plus network fee,
   exact: what is sent minus what arrives), `receive` (coins that arrive),
   `receiveMin` (floor after at most 1% slippage) and the expiry.
3. **Confirm.** `{action:'confirm', quoteId}` reserves and sends (see
   idempotency). An expired quote answers 409 with a fresh quote to review.
4. The row finishes `paid` (with `amount_out` delivered) or `failed`
   (balance returned). A swap that failed without a refund stays `sending`
   for a person; `health` flags it.

**Fees.** On an instant withdrawal the user pays only the network fee from
the quote. The platform fee code path stays (per-account
`withdrawal_fee_percent`, shown as a separate line only when above 0) but
defaults to 0% (0100). Manual withdrawals use the same platform fee and
have no network fee.

## What users see

Freelancer, reseller and customer pages never name the processor:

- `user-withdraw` forwards an allowlisted copy of each service answer:
  no processor or provider names, payment ids, sats, rates or admin notes;
  the fee travels as `networkFeeUsd`. Service error text that names the
  processor or looks like a raw library error becomes a generic message.
  Quote errors from the SDK are logged, never returned to creators.
- The withdraw review shows **Network fee** as one exact amount and **You
  receive** before confirm; the platform-fee line appears only when the
  account's fee is above 0.
- Rows those pages receive use neutral column names (`invoice_ref`,
  `payout_ref`, `quoted_fee`).
- `ci/check_frontend.py` fails the build if "breez" (any case) appears in
  any non-admin file under `public/`, including the built bundle.

The admin panel (Wallet tab, health, notes) may name it.
