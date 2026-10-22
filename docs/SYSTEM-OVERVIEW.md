# CPAY system overview (current, 2026-10-21, main @ 0bbda0e)

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
| Edge Functions (Deno) | `supabase/functions/*` | `create-invoice`, `direct-invoice`, `user-withdraw`, `admin-actions`, `auth-settings`, the wallet function, `settlement-destination`, `owner-config`, `telegram-notify`, `daily-report`, `ledger-backup`, `health`, `og-image`, `wallet-registry` (owner only: add/primary/disable wallets), `owner-guide` (Bangla guide, owner only), `btcpay-webhook` |
| Wallet function | the wallet directory under `supabase/functions/` | one or more wallets ([MULTI-WALLET.md](MULTI-WALLET.md)), each a **single instance** via its own advisory lease; deploy **only** with the wallet deploy script in `scripts/`; `RECEIPT_RECORDING` is hard-coded off |
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

## Wallets (`20261021040000_multi_wallet.sql`, [MULTI-WALLET.md](MULTI-WALLET.md))

- Several platform wallets. Wallet #1 is the original one (seed in the Edge
  secret); others are added by the owner in Admin → Wallet → Wallets by
  pasting a 12-word seed, which is stored in Supabase Vault and never shown
  again (only a fingerprint and the node key).
- The **primary** wallet makes every new invoice and pays every forward and
  withdrawal. Other active wallets are synced receive-only each minute.
- `wallet_id` is recorded on payments, forwards and withdrawals (NULL =
  wallet #1). Owner-only management through the `wallet-registry` function
  (passkey session; add/remove need a fresh passkey).

## BTCPay Server checkout (`20261021050000_gateway_checkout.sql`, [BTCPAY.md](BTCPAY.md))

Off by default (`btcpay_enabled` in Admin → Settings). When on, `create-invoice`
makes the invoice on the owner's BTCPay `cpay` store (Greenfield, Lightning +
on-chain, `orderId = cpay:<payment id>`); `btcpay-webhook` verifies
`BTCPay-Sig`, re-fetches the invoice and settles the same `payments` row
(fee, then Auto withdraw or balance). BTCPay only receives; all sends stay
in the CPAY wallet. On-chain receipts land in BTCPay's on-chain wallet, not
the CPAY Lightning balance.

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
  **passkey**. Google sign-in is removed. Authenticator codes (TOTP) are fully off since 2026-10-21:
  both enrolment and verification are disabled; stored factors are retained.
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

## Health check

`health` reports the payment service plus the primary wallet's last sync time
(from `wallet_registry_list()` / the wallet status table), shown
in Dhaka time. Daily figures everywhere use the Bangladesh calendar day
(midnight Asia/Dhaka, #156).

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

## Desk presentation (2026-10-22)

The freelancer overview shows available balance and recent activity before
the daily breakdown completes. Refresh/retry controls are read-only. If
receiving settings cannot be loaded, the mode is shown as unavailable.
Payment links have local search/status filters and a collapsible creation
panel; filtering and confirmed live/off changes preserve its draft. These
presentation changes do not change fees, balances or settlement rules.
See [CORE-DESIGN-WORKLIST.md](CORE-DESIGN-WORKLIST.md) for implementation
status and pending browser/production acceptance.

Payment history uses the existing paginated RPC (50 records per page).
Payment details show recorded timestamps, with read-only retries and
stale-response guards. Withdrawal history refreshes independently of the
quote form; it shows up to the latest 40 matching records. Withdrawal
quote/confirm requests, amounts and passkey requirements are unchanged.

Profile separates public information and private receiving settings, and
reports receiving-mode read failures explicitly. Security provides read-only
refresh and backup-passkey guidance; Add/Remove actions keep the existing
strong-session and last-admin-key guards. Public form drafts are page-local
only. Authentication and payout-address authorization are unchanged.

Member support displays the newest 80 messages; Admin Inbox displays up to
the newest 300, with drafts kept separately per selected account in page
memory. Send/clear requests are not automatically retried. Checkout status
read availability is displayed separately from payment status; receipt
time is labelled as the time confirmation was observed by the page. These
changes do not alter invoice creation, settlement or merchant themes.

## Store and overview presentation — batch 7

Store discovery filters only the already loaded public payment links. Search never creates an invoice. Read failures expose retry; sharing has cancellation and clipboard failure feedback. Merchant theme behavior is preserved. Admin overview reads have bounded waits and response guards; wallet availability does not block the activity boards. Unavailable balances and queues are distinct from zero and empty results. Review shortcuts lead to the existing administrative sections; payment calculations and protected mutation endpoints remain unchanged. Browser and live-service acceptance remain pending.

## Administrative list and review presentation — batch 8

Users and applications preserve search/status state through read refreshes, show explicit read failures and expose references in native details. Optional account reads may fail independently; unknown withdrawal settings are disabled rather than assumed. Application history uses the existing nullable status parameter; review actions appear only on waiting rows. Payout filters cover the latest 120 requests, and forward filters read up to 200 records for the selected status; both limits are visible. Forward search is local to loaded records and does not call a mutation. Existing payout step-up, confirmation prompts, monetary values and administrative endpoints remain. Busy state prevents duplicate application/payout decisions and serializes forward actions in their panels. These guards do not replace server authorization or transaction locking. Browser and live acceptance remain pending.

## Wallet and Locations presentation — batch 9

Platform wallet refresh reads balances, currency rates and history without submitting a quote or send. Failed balance reads clear stale figures; read completion time is separate from registry sync time. Owner registry refresh preserves the existing add-form DOM, shows sync details and removes stale lists on failure; mutation serialization supplements existing server constraints and passkey checks. Location filters preserve drafts and show format validation, bounded read failures, current-profile versus payment-date scope, and detail-list limits. Location references remain display only. No monetary formula, send implementation, schema or authorization rule was changed. Browser and live-service acceptance remain pending.

## Health, audit and receipt review presentation — batch 10

Health and System show partial-read failures independently, preserving successful snapshot evidence without interpreting an absent query as healthy or alert-free. Refreshes read existing endpoints; old responses cannot replace newer reads. Audit shows full references and labels its latest-120-row search scope. Receipt review shows full evidence in native details, labels its latest-200-record status scope and serializes each receipt decision while preserving the note prompt. Resolving/dismissing records an audited flag only; it does not move money. Shared CSS handles operational card layout and scrollable evidence tables. Browser and live backend acceptance remain pending.

## Settings and owner guide presentation — batch 11

Platform Settings preserves ordinary field drafts in memory and serializes its save operations, while read failures remain distinct from real zero-valued fees. Existing grouped owner sections, confirmation prompts, RPC contracts and step-up remain. Owner-config transport failures return explicit uncertainty and secret fields retain post-attempt clearing. Owner guide adds heading navigation and separate guide/status refreshes, with distinct unavailable, owner-only and weak-session feedback. The guide is still owner served; only secret names are displayed. Bangla quick-reference content and its generated function payload were rebuilt together. Live settings were not changed; browser/live acceptance and owner-guide deployment remain pending.

## Wallet PWA workspace and owner-deferred legal input — batch 12

Wallet PWA balances and activity have independent read status, bounded waits and guards against stale/locked-session responses. Local activity filters show loaded-record counts and complete references; pending send checks remain read-only. Receive copy has explicit fallback feedback. Send preparation/confirmation/outcome/retry code, recovery, engine, service worker and custody boundaries remain unchanged. Owner deferred Legal / Contact entry to the dashboard after project completion; publication is not approved by this source update. Wallet build is pending dependency installation, and browser/real-device/offline/live-wallet acceptance remains pending.

## Local browser evidence — batch 13

Public layouts/smoke and wallet browser suites now have local Chromium evidence recorded in [LOCAL-BROWSER-QA.md](LOCAL-BROWSER-QA.md). Login/register put the keyboard skip link before the language switch. The wallet real-SDK regtest build succeeds with locked dependencies installed. Signed-in section visual QA, Bengali typography, physical-device testing, live payment/authorization checks and release acceptance remain pending. No deployment or legal publication was performed.
