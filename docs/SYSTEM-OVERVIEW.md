# CPAY system overview (current, 2026-10-21, main @ 0d634e5)

This is the single source of truth for how CPAY works **today**. Older design
documents carry a "Historical document" banner; where they disagree with this
file, this file wins. Agent rules are in [../AGENTS.md](../AGENTS.md).

## What CPAY is

Payment links for freelancers and shop owners. A payer (no account) opens a
link on `pay-cashapp.buzz/<slug>`, enters an amount in **USD**, and pays a
Lightning **BOLT11** invoice (Cash App is the tested payer wallet). CPAY's
wallet receives the payment, the **platform fee is deducted first**, and the
remainder goes to the freelancer according to their **Auto withdraw** setting.
The payer and the freelancer see one figure: **"You receive X"**.

## Components

| Part | Where | Notes |
|---|---|---|
| Static site | `public/` (no build step), served by Cloudflare Workers (`wrangler.jsonc`) | `404.html` + `invoice-view.js` = the one-page checkout/invoice for any slug |
| Link previews | `worker/og-preview-worker.js` | OG metadata; forwards coarse geo headers |
| Database | `supabase/migrations/` (Postgres, RLS, `SECURITY DEFINER` RPCs) | append-only history |
| Edge Functions (Deno) | `supabase/functions/*` | `create-invoice`, `direct-invoice`, `user-withdraw`, `admin-actions`, `auth-settings`, the wallet function, `settlement-destination`, `owner-config`, `telegram-notify`, `daily-report`, `ledger-backup`, `health`, `og-image` |
| Wallet function | the wallet directory under `supabase/functions/` | runs as a **single instance** via an advisory lease; deploy **only** with the wallet deploy script in `scripts/`; `RECEIPT_RECORDING` is hard-coded off |
| Self-hosted fallback | `payment-service/` (Node 22) | not deployed; still tested in CI (core parity with the wallet function) |
| CPay Wallet PWA | `wallet/` | separate optional phone wallet on its own hostname |

## Money flow

1. `create-invoice` validates the link and amount (USD) and asks the wallet
   for a BOLT11 invoice. Amount and fee are computed server-side.
2. On settlement the platform fee (`platform_fee_amount`) is recorded first.
3. `payment_mode_for(user)` (`supabase/migrations/20261021010000_auto_withdraw.sql`)
   decides per user:
   - **Auto withdraw ON** (`payment_mode = instant_forward`): the remainder is
     enqueued (`instant_forward_enqueue`) and forwarded to the user's saved
     receive address — a Lightning address, or USDT on a network the wallet
     swap supports. A forward that cannot go out at once is **held/owed**
     (`payment_forwards.status`) and retried by the forward workers; admins
     see it in Admin → Forwards. A user with no usable address cannot take
     payments when `instant_forward_no_address = refuse`.
   - **Auto withdraw OFF** (`payment_mode = balance`): the remainder is
     credited to the user's **custodial balance**. The user withdraws by hand
     on the **Withdraw** page in the desk (`public/freelancer-desk.js`,
     `supabase/functions/user-withdraw/`): Lightning address, Lightning
     invoice, or USDT; amount or "Withdraw all"; confirm with a passkey
     session; history shows pending/sent/failed; a failure returns the money
     once (`reserve_lightning_withdrawal`, `reserve_stablecoin_withdrawal`).
     Admins see every withdrawal in Admin → Payouts.
4. **Switches:** global switch in Admin → Settings → Auto withdraw
   (`admin_set_auto_withdraw_global`); per-profile override Default/On/Off in
   Admin → Manage users (`admin_set_auto_withdraw`, table
   `auto_withdraw_overrides`). Switching a user OFF releases their waiting
   forwards into their balance (`auto_withdraw_release_waiting`).
5. **Only an admin may reverse a settled payment**
   (`20261013090000_payment_state_transitions.sql`).
6. Direct payment links (merchant's own wallet, no fee) exist in
   `direct-invoice` / `settlement-destination` and are off unless enabled.

## Locations (`20261020090000_locations.sql`)

Country/region/city come only from Cloudflare request headers
(`supabase/functions/_shared/geo.ts`). No GPS, no device location, no IP
address stored. Payer location is visible to the **link owner** on their own
payments (`get_my_payment_details`) and to **admins** (`admin_locations`).
An optional account location lives in `profile_locations` (own row only).
Locations are display-only: never used for fees, limits, routing or accepting
a payment (headers can be spoofed).

## Auth (`20261021020000_passkey_step_up.sql`)

- Sign-up/sign-in: email + password with **email verification**, or a
  **passkey**. Google sign-in is removed. Authenticator codes (TOTP) are fully off since 2026-10-21 (enrol and verify; factors kept). New authenticator (TOTP) enrolment
  is off; previously enrolled codes still verify during the switch-over.
- Daily figures use the Bangladesh calendar day, midnight to midnight Asia/Dhaka (`business_day()`, 20261021030000).
- `public.strong_session()` = passkey session (or legacy aal2, kept as a fallback; unreachable now that TOTP verify is off). Required for
  admin actions, settings, withdrawals and payout-address changes.
- A payout address can be saved/changed **only** from a passkey session and is
  usable **at once** (the old 24 h cooldown is gone). Admins cannot delete
  their last passkey.

## Legal pages

`public/terms.html`, `privacy.html`, `refund.html` are filled from legal
fields in Admin → Settings by `public/legal-fields.js` and shown only when
the `legal_published` setting is on. `python3 ci/check_legal.py --release`
refuses a release while any field is empty.

## Release and deploy

- Deploy order: **migration → Edge Functions (wallet only via
  the wallet deploy script in `scripts/`) → site**. The site deploys from `main`
  through Cloudflare Workers Builds.
- `node scripts/release-gate.mjs` is the read-only release gate (verified SHA,
  site build, restore drill, no open Critical/High in
  [RELEASE-BLOCKERS.md](RELEASE-BLOCKERS.md), legal fields).

More detail: [ARCHITECTURE.md](ARCHITECTURE.md), [AUTO-WITHDRAW.md](AUTO-WITHDRAW.md),
[INSTANT-FORWARD.md](INSTANT-FORWARD.md), [PAYMENT-STATES.md](PAYMENT-STATES.md),
[FINANCIAL-INVARIANTS.md](FINANCIAL-INVARIANTS.md), [DEPLOYMENT.md](DEPLOYMENT.md),
[TESTING.md](TESTING.md).
