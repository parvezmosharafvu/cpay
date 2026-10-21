# CPAY: current production architecture (verified 2026-10-14)

Evidence comes from the Supabase Management API, read-only SQL on
production, the Cloudflare account listing, and the repository at
`main` 04a4009. Design detail lives in [ARCHITECTURE.md](ARCHITECTURE.md);
this page records what is running now and how that was established.

## What serves what

| Part | Production | Evidence |
|---|---|---|
| Website | Cloudflare Worker `cpay` (static assets from `public/`), deployed by Workers Builds on every merge to `main` | Worker `cpay` modified 2026-10-14 20:18 UTC, right after the merge of #107; hostname from `site_domains`: `pay-cashapp.buzz` |
| Link previews | Cloudflare Worker `cpay-og-preview` (`worker/`) | Worker listing |
| Database and ledger | Supabase project `riumaeihemgznvgattoc` (Postgres 17, ap-southeast-1, **Free plan**) | Management API |
| Server functions | Supabase Edge Functions: create-invoice, user-withdraw, admin-actions, health, daily-report, ledger-backup, telegram-notify, auth-settings, og-image | `list_edge_functions`; versions in [CPAY_TEST_RESULTS.md](CPAY_TEST_RESULTS.md) |
| **Wallet engine** | The wallet Edge Function (Lightning wallet SDK from our payment provider), **v17**, deployed by hand on 2026-10-13 17:28 UTC | `breez_wallet.control`: `enabled = true`, `owner = 'supabase-edge'`; a lease every minute (65 in the last hour); its leases served the last three payments (2026-10-12/13) |
| Self-hosted payment service (`payment-service/`) | **Not running.** Kept as the documented fallback after a seed restore | The control row names the Edge owner; the Azure host was deleted (BACKUP-RECOVERY.md) |
| Scheduled jobs | pg_cron: wallet sync (every minute), Telegram send (every minute), health (every 15 min), receipt-review sweep (every 10 min), daily report, ledger backup | `cron.job`, all last runs `succeeded` |

There is exactly one wallet engine. The SDK's own Postgres lock (advisory
lock in `breez_wallet.lease_log`) ensures one instance holds the wallet at
a time; the control row's `owner` says which host may hold it.

## Payment flow (as implemented)

1. **Invoice.** A payer opens `/<slug>` and enters an amount. The
   create-invoice function rate-limits, stores a `payments` row, and asks
   the wallet engine (signed request to `PAYMENT_SERVICE_URL`) for a
   Lightning invoice. The invoice page shows the QR code.
2. **Settlement.** The wallet engine sees the payment (SDK event, plus a
   catch-up sync every minute) and calls `settle_breez_payment()`. That is
   idempotent on the delivery id and invoice ref, moves only
   `new/pending/expired` to `settled`, and stamps the platform fee once.
3. **Balance.** Always computed: `get_balance_for()` = settled earnings
   minus platform fees, minus withdrawals that are not rejected or failed.
4. **Withdrawal (USDT; USDC only where a route exists).**
   - The desk asks user-withdraw for a quote; the wallet engine prices it.
   - On confirm (passkey session, `strong_session()`) the payout is
     reserved under a profile lock with `reserve_stablecoin_withdrawal()`,
     idempotent on the quote id, and sent once.
   - A failure refunds once. Only a saved address is used; saving one needs a
     passkey session and it is usable at once (20261021020000).
5. **Admin.** admin-actions checks an active admin (aal2 when
   `admin_mfa_required` is on) for wallet sends, mark-paid and reject; each
   is audited with the admin's id.

## Production flags (2026-10-14 20:58 UTC)

`emergency_payments_stop = false`, `emergency_withdrawals_stop = false`,
`admin_mfa_required = false`. Receipt recording is off (the wallet engine
is created with `receiptRecording: "off"`). Health was `200 healthy` at
20:30 UTC with no failing check.

## Direct settlement (not live)

Migration `20261018010000` and the `direct-invoice` and
`settlement-destination` functions add payments that go straight to a
Freelancer's own wallet. They take effect when merged and deployed, but
`direct_settlement_enabled` is `false`, so no link can use them until the
owner turns the switch on. See [NON-CUSTODIAL-ARCHITECTURE.md](NON-CUSTODIAL-ARCHITECTURE.md).

## The standalone CPAY Wallet

A separate, optional phone app in `wallet/`. It is not part of anything
above and is **not deployed**. See [CPAY_WALLET_COMPARISON.md](CPAY_WALLET_COMPARISON.md).
