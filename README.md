# CPAY

Lightning Network payment links for freelancers and online shop owners.
Generate a payment link, share it, get paid in Lightning. Balance is kept in
US dollars. Withdraw only as USDT (or USDC where a route exists) to a saved
address on a network Breez can route to.

There is no bKash, Nagad, Binance Pay, bank, or Lightning payout. Those
methods are not offered. See `docs/SIMPLE-MODEL.md`.

Checkout loading, amount chips, focus, and what is intentionally not
restructured are in `docs/UI.md`.

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
  invoice-cpay-v2.html     → customer invoice / QR page
  admin.html                     → admin panel
  a11y.css                       → focus, 44px targets, reduced motion
  theme.js                       → checkout designs for the payment page and
                                   the invoice page. A domain does not pick a theme.
  cpay.css                       → design tokens and components

docs/
  UI.md                          → checkout fixes and what stays flat
  SIMPLE-MODEL.md                → USDT address + threshold
  ARCHITECTURE.md                → ledger, receive and withdraw
  DEPLOYMENT.md                  → setup checklist
```

## Setup

Read `docs/CPAY-OWNER-GUIDE.md`, then `docs/DEPLOYMENT.md`. Never run CPAY
migrations against the previous production project.

## How the money model works

```
available = sum(settled payments) − sum(withdrawals that are not rejected or failed)
```

`get_balance_for()` computes it. Payout is USDT only, to an address in
`usdt_wallets`, by threshold or by quote/confirm. `request_withdrawal` is
closed.

## What is deliberately not built

**bKash, Nagad, Binance Pay, bank and Lightning payouts.** Not offered.

**A pages/ folder and a split design system.** Slug routing needs
`404.html` at the site root. Themes stay on the payment and invoice pages.
See `docs/UI.md`.
