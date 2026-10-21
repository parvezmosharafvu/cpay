# CPAY

Payment links for freelancers and online shop owners on
`pay-cashapp.buzz`. A payer pays a Lightning (BOLT11) invoice for a USD
amount; CPAY deducts the platform fee and then, per user, either forwards the
rest at once to the saved Lightning/USDT address (**Auto withdraw ON**) or
credits a balance the user withdraws from the Withdraw page (**Auto withdraw
OFF**). Sign-in is email + password (verified) or passkey.

- Current system: [`docs/SYSTEM-OVERVIEW.md`](docs/SYSTEM-OVERVIEW.md)
- বাংলা সিস্টেম গাইড (account, setup, settings, secret, API): [`docs/SYSTEM-GUIDE-BN.md`](docs/SYSTEM-GUIDE-BN.md) — Admin → System guide-এও দেখা যায়
- Agent / contributor rules: [`AGENTS.md`](AGENTS.md)
- Checkout UI notes: [`docs/UI.md`](docs/UI.md)

Highlights (2026-10-21): **multi-wallet** (owner adds wallets by 12-word seed
kept in Supabase Vault; one primary wallet makes invoices and sends, others
are receive-only — [`docs/MULTI-WALLET.md`](docs/MULTI-WALLET.md)), and every
daily figure uses the **Bangladesh calendar day** (midnight to midnight
Asia/Dhaka, `business_day()`).

## Stack

- **Frontend:** Vanilla HTML/CSS/JS + Supabase JS v2 (no build step)
- **Backend:** Supabase — Postgres, Row Level Security, Edge Functions
- **Payments:** the wallet (our payment provider's Lightning wallet SDK),
  run in production by the wallet Edge Function under `supabase/functions/` (same core as
  `payment-service/`, the self-hosted Node 22 fallback; not a warm
  standby, it needs a seed restore on a new host), holding the cpay wallet. Customers pay a
  standard Lightning invoice (BOLT11) from a wallet that supports it; Cash
  App is tested. Not every wallet can pay every invoice. Payouts go to a Lightning address/invoice or as USDT
  on a supported network (mainnet only).
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
  invoice-cpay-v2.html           → shell for the one-page checkout (invoice-view.js)
  admin.html                     → admin panel
  a11y.css                       → focus, 44px targets, reduced motion
  theme.js                       → checkout designs for the payment page and
                                   the invoice page. A domain does not pick a theme.
  cpay.css                       → design tokens and components

supabase/
  migrations/                    → schema, RLS, RPCs (append-only)
  functions/                     → Deno Edge Functions, incl. the wallet function,
                                   wallet-registry (owner: add/primary/disable wallets),
                                   owner-guide (serves the Bangla guide to the owner only),
                                   user-withdraw, create-invoice, health, btcpay-webhook
worker/                          → Cloudflare link-preview Worker
wallet/                          → CPay Wallet PWA (optional phone wallet)
payment-service/                 → self-hosted Node 22 fallback (not deployed, tested in CI)
scripts/                         → deploy/release tools; build-admin-guide.mjs builds
                                   owner-guide/guide.ts from SYSTEM-GUIDE-BN.md

docs/
  UI.md                          → checkout fixes and what stays flat
  SYSTEM-OVERVIEW.md             → current system (start here)
  SYSTEM-GUIDE-BN.md             → Bangla owner guide (accounts, setup, settings, secrets, APIs)
  ARCHITECTURE.md                → ledger, receive and withdraw
  DEPLOYMENT.md                  → setup checklist
  AUTO-WITHDRAW.md               → Auto withdraw ON/OFF + manual withdraw
  INSTANT-FORWARD.md             → instant forward (held/owed, retries)
  MULTI-WALLET.md                → several wallets, primary routing, per-wallet lease
  MANUAL-DEPLOY.md               → SQL Editor + Termux manual deploy steps
  BTCPAY.md                      → optional BTCPay Server checkout (receive only)
```

## Setup

Read `docs/CPAY-OWNER-GUIDE.md`, then `docs/DEPLOYMENT.md`. Never run CPAY
migrations against the previous production project.

## How the money model works

Every settled payment pays the **platform fee first**. What happens to the
rest depends on `payment_mode_for(user)` (Auto withdraw, global switch in
Admin → Settings plus a per-profile Default/On/Off override; #151,
[`docs/AUTO-WITHDRAW.md`](docs/AUTO-WITHDRAW.md)):

- **Auto withdraw ON** (`instant_forward`): the rest is forwarded at once to
  the user's saved receive address — a Lightning address, or USDT on a
  supported network. With no usable address, or below a minimum, it is held
  as `owed` and retried ([`docs/INSTANT-FORWARD.md`](docs/INSTANT-FORWARD.md)).
- **Auto withdraw OFF** (`balance`): the rest is credited to a balance the
  user withdraws by hand from the Withdraw page — to a Lightning address or
  invoice, or USDT — with a quote, one "You receive" figure, and passkey
  confirmation (`user-withdraw`; `reserve_lightning_withdrawal`,
  `reserve_stablecoin_withdrawal`).

```
available = sum(settled payment − platform fee, excluding payments that have
                a forward row not 'released')
          − sum(withdrawals that are not rejected or failed)
```

`get_balance_for()` computes it (`20261020030000_instant_forward.sql`): a
forwarded payment never counts toward the balance. Under Auto withdraw ON the balance normally
stays near zero; turning Auto withdraw OFF releases waiting forwards
(`queued`, `retry`, `owed`) back into the balance.

## What is deliberately not built

**Payout methods other than Lightning and USDT/USDC.** Not offered.

**A pages/ folder and a split design system.** Slug routing needs
`404.html` at the site root. Themes stay on the payment and invoice pages.
See `docs/UI.md`.

## Docs map (release)

| Doc | Purpose |
|---|---|
| `docs/CPAY-OWNER-GUIDE.md` | Owner onboarding |
| `docs/ARCHITECTURE.md` | Trust boundaries + money flow |
| `docs/AUTO-WITHDRAW.md` / `INSTANT-FORWARD.md` | Auto withdraw ON/OFF, forwarding, manual withdraw |
| `docs/MULTI-WALLET.md` | Several wallets, primary routing |
| `docs/MANUAL-DEPLOY.md` | Manual deploy (SQL Editor, Termux) |
| `docs/BTCPAY.md` | Optional BTCPay Server checkout |
| `docs/DEPLOYMENT.md` / `ENV_VARS.md` | Deploy + env inventory |
| `docs/TESTING.md` | What was run vs manual-only |
| `docs/RELEASE-CHECKLIST.md` | Cut order + rollback |
| `docs/PRODUCTION-READINESS.md` | Honest GO / CONDITIONAL / NO-GO checklist |
| `docs/OPS_OWNER_CUTOVER.md` | Orphans + Telegram (owner only) |
| `docs/RUNBOOKS.md` / `INCIDENT.md` / `BACKUP-RECOVERY.md` | Ops |
| `SECURITY.md` | Reporting + trust notes |


## Deploy order

Migration → Edge Functions (wallet only via the wallet deploy script in `scripts/`)
→ site (Cloudflare Workers Builds from `main`). Checks: see `AGENTS.md`.
