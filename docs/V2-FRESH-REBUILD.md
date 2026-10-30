# CPAY v2 — Fresh LND-only rebuild

**Status:** implementation branch, not live and not a migration of existing balances.
This replaces the product's code and UI flow, not the accounting history. Existing
Blink, BTCPay and custodial wallet engines are NOT called by the new v2 checkout.
Once the new checkout is reconciled and tested, the older functions and pages can
be retired in separate reversible deploy steps. Do not delete a live financial
record or seed during the transition.

## Target (functionality parity, original branding)

1. Landing: CPAY branded hero, steps, feature tiles, FAQ, register and login.
2. Register: name, email, phone, optional Telegram, password + confirmation.
   New accounts pending; active only after admin review.
3. Login: waiting/rejected/suspended screens, reset password, passkey security.
4. Member: overview, create/edit links, amount chips ($10–$1000), notes, search
   and payment records, 19:00 Dhaka daily statements, withdrawals and reports.
5. Checkout: display name, note, amount/chips, validation, rate quote in USD,
   provider-issued Lightning invoice, QR, Cash App button, copy, expiry
   countdown, 3-second status polling, success/failure/expired screens.
6. Admin: approval, users, links, payout queue, payment methods (LND only),
   monthly income/fees, reconciliation and node status, domains and audit.
7. Telegram + brand-safe OpenGraph metadata, multi-domain routing.
8. Real settlement: LND reports SETTLED, transition is exactly once. No action
   labelled paid can credit balances without node confirmation.

## New architecture

- Web: newly authored CPAY pages/modules, static Cloudflare Workers build.
- Auth: Supabase Auth; strict server-side active-account authorization.
- Database: new \`v2_links\`, \`v2_invoices\`, \`v2_payment_events\`, plus a
  default-OFF \`v2_settings.checkout_enabled\` kill switch and rate buckets.
- Edge: \`v2-payments\` public create/status and cron-only watch endpoints.
- Network: \`_shared/lnd-v2.ts\` only calls LND \`POST /v1/invoices\` and
  \`GET /v1/invoice/{payment_hash}\`. Configured via a HTTPS Cloudflare Access
  protected tunnel and an invoice-limited macaroon. No sending permission.
- Pricing: 2 agreeing exchange spot quotes with at most 60-second cache,
  dollar cents → integer satoshi conversion; 3600-second invoices, no private
  route hints.
- Public security: Turnstile is required for invoice creation, per-IP and
  per-link atomic minute-rate caps, strictly validated USD range, random
  request UUID idempotency key and staged creation (no repeat on network
  uncertainty). Anonymous link preview contains presentation data only.
- Settlement: pending → settled only after confirmed LND response with paid
  amount >= invoice sats. Events are appended once. DB function is executable
  by service_role only. Watcher handles pending invoices and on-demand status
  checks use a throttle. This foundation never sends a payout.

## Current first stage (PR)

The SQL migration adds isolated v2 objects. The standalone `public/v2-pay.html` checkout and its JS/CSS demonstrate amount chips, QR, deep links, and invoice state polling via v2-only endpoints. This page is **staging-only** and is not routed to `/<slug>` on public domains. It does not remove existing
payments, flip receiving routes, or enable \`v2-payments\`. The Edge function
is included in source but deliberately listed as **undeployed**.

Environment names (secrets, never commit actual values):

- \`SUPABASE_URL\`
- \`SUPABASE_SERVICE_ROLE_KEY\`
- \`LND_REST_URL\` (an HTTPS origin)
- \`LND_INVOICE_MACAROON_HEX\` (invoices:read/invoices:write only)
- \`CF_ACCESS_CLIENT_ID\`
- \`CF_ACCESS_CLIENT_SECRET\`
- \`TURNSTILE_SECRET_KEY\`
- \`CRON_SECRET\`
- \`PAYLINK_V2_ENABLED\` (default **false**)

NOTE: both the environment flag and the DB \`v2_settings.checkout_enabled\`
must remain false until staging passes. A later deploy must check both flags
before enabling live invoice issuance.

## Build phases

A. Foundation: isolated schema, LND transport, idempotent issue/lookup,
rate limits, a secure cron watcher, mocked LND and SQL tests.
B. Fresh CPAY UI and sign-up/approval/creator/admin screens. Match the
reference functionality without copying its visual brand.
C. Extend fresh v2 ledger with independently tested commission, derived
balance, withdrawal reservations, payout approval and reconciliation.
D. Daily 19:00 Dhaka cycle, Telegram, domains, previews and admin statistics.
E. Real LND integration in staging (including node inbound liquidity),
10 USD controlled end-to-end trial, alerting, audit and recovery.
F. After rollback readiness, switch the public domain to v2, disable old
new-invoice routes, archive legacy code and back up legacy accounting data.

## Gates blocking live cutover

- Owner-controlled LND node/Tunnel/Access configured and reachable.
- Verified inbound Lightning channels/liquidity, invoice receipts and cash
  app wallet compatibility in test conditions.
- Every v2 invoice has a recoverable journal entry and a matching node
  settlement; historical paid/withdrawn balances reconcile separately.
- No private key, full macaroon or token in GitHub, frontend or logs.
- Migration/replay, role/anon RPC allowlists, typed Deno and browser tests all
  green. Never cut over merely because a PR has been merged.

## Explicitly not finished by stage A

This is **not** yet a finished parity product: v2 payout ledger/withdrawal,
daily cycle, user/admin interface, Telegram, OG, account application and
production LND connection still need full implementation and end-to-end tests.
