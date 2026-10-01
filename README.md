# CPAY

Lightning Network payment links for freelancers and online shop owners.
Generate a payment link, share it, get paid in Lightning. Balance is kept in
US dollars. Withdraw only as USDT (or USDC where a route exists) to a saved
address on a network Breez can route to.

There is no bKash, Nagad, Binance Pay, bank, or Lightning payout. Those
methods are not offered. See `docs/SIMPLE-MODEL.md`.

## Stack

- **Frontend:** Vanilla HTML/CSS/JS + Supabase JS v2 (no build step)
- **Backend:** Supabase — Postgres, Row Level Security, Edge Functions
- **Payments:** Breez SDK Spark, through `payment-service/` (a small
  Node 22 process holding the cpay wallet). Customers pay a Lightning
  invoice (Cash App or any Lightning wallet). Payouts are cross-chain
  USDT/USDC sends from that wallet (mainnet only). Stable Balance is not
  used: sats stay in the wallet until a USDT quote is confirmed.
- **Edge routing:** Cloudflare Worker — renders correct link-preview
  metadata for WhatsApp/Telegram/Facebook when a payment link is shared

For a direct frontend upload, see `docs/DIRECT-UPLOAD.md` and run
`npm run prepare:upload`; it creates a clean `dist/` bundle for the new CPAY
Cloudflare project.

## Repo layout

```
public/                          → static site root
  index.html                     → landing page + logged-in redirect
  login.html / register.html     → auth pages
  404.html                       → not-found page AND the payment page:
                                   any unmatched path is treated as a slug
  dashboard.html                 → creator dashboard
  invoice-cpay-v2.html     → preserved legacy customer-facing payment/QR page
  admin.html                     → admin panel (approvals, stats, settings)
  moderator.html                 → limited staff panel, scoped to assigned creators
  theme.js                       → checkout designs for the payment page and
                                   the invoice page. A domain does not pick a theme.
  theme-preview.html             → preview of the designs with sample data
  cpay.css                       → the one stylesheet: design tokens and components
  config.example.js              → copy to config.js, fill in your keys

supabase/
  migrations/                    → run in numeric order
  functions/
    create-invoice/              → validates and prices a payment, has the payment service invoice it
    admin-actions/               → admin mark-settled + withdrawal actions
    auth-settings/               → admin switch for sign-up email confirmation
    user-withdraw/               → creator USDT quote / confirm
    daily-report/                → nightly rollup into daily_stats
    ledger-backup/               → nightly ledger snapshot to a private repo
    og-image/                    → generated link-preview images
    health/                      → system health checks + alerting

payment-service/                 → Node 22 process holding the cpay Breez wallet

docs/
  SIMPLE-MODEL.md                → current payout model (USDT address + threshold)
  ARCHITECTURE.md                → ledger, receive and withdraw flows
  DEPLOYMENT.md                  → setup checklist
  CPAY-OWNER-GUIDE.md            → owner and staging guide
```

## Setup

Read `docs/CPAY-OWNER-GUIDE.md`, then `docs/DEPLOYMENT.md`. Never run CPAY
migrations against the previous production project.

## How the money model works

There is exactly one definition of a creator's withdrawable balance, and it
lives in SQL:

```
available = sum(settled payments) − sum(withdrawals that are not rejected or failed)
```

`get_balance_for()` computes it. `get_my_balance()` is the creator-facing
wrapper. `system_queue_withdrawal()` and `reserve_stablecoin_withdrawal()`
check it while holding a lock on the creator's profile row.

Payout is USDT only. Each account saves one address per network in
`usdt_wallets`. A threshold plus auto-withdraw files a payout when available
balance reaches it; otherwise the desk quotes and confirms through the
payment service. `request_withdrawal` (the old manual-method request) is
closed.

Nothing else may write to `withdrawals`. An instant stablecoin withdrawal is
inserted as `sending` and leaves it only through
`finalize_stablecoin_withdrawal()` (to `paid`, or `failed`, which refunds),
once.

## What is deliberately not built

**bKash, Nagad, Binance Pay, bank and Lightning payouts.** Not offered.
Creators withdraw USDT to an address they set, by threshold or by calling
withdraw.

The rest of the operational notes (cron, business day, alerting, CI) are
unchanged. See the docs listed above.
