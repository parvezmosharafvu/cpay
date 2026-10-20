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

## Stack

- **Frontend:** Vanilla HTML/CSS/JS + Supabase JS v2 (no build step)
- **Backend:** Supabase — Postgres, Row Level Security, Edge Functions
- **Payments:** a Lightning/Spark wallet SDK, run in production by the
  wallet Edge Function under `supabase/functions/` (same core as
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

docs/
  UI.md                          → checkout fixes and what stays flat
  SYSTEM-OVERVIEW.md             → current system (start here)
  SYSTEM-GUIDE-BN.md             → Bangla owner guide (accounts, setup, settings, secrets, APIs)
  ARCHITECTURE.md                → ledger, receive and withdraw
  DEPLOYMENT.md                  → setup checklist
```

## Setup

Read `docs/CPAY-OWNER-GUIDE.md`, then `docs/DEPLOYMENT.md`. Never run CPAY
migrations against the previous production project.

## How the money model works

```
available = sum(settled payment − platform fee) − sum(withdrawals that are not rejected or failed)
```

`get_balance_for()` computes it. Payout is USDT only, to an address in
`usdt_wallets`, by threshold or by quote/confirm. `request_withdrawal` is
closed.

## What is deliberately not built

**Lightning payouts and any payout method other than USDT/USDC.** Not offered.

**A pages/ folder and a split design system.** Slug routing needs
`404.html` at the site root. Themes stay on the payment and invoice pages.
See `docs/UI.md`.

## Docs map (release)

| Doc | Purpose |
|---|---|
| `docs/CPAY-OWNER-GUIDE.md` | Owner onboarding |
| `docs/ARCHITECTURE.md` | Trust boundaries + money flow |
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
