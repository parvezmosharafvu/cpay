# CPAY Admin and Reports parity (M13)

This document describes source added in PR #197. It is **not evidence of a production deployment**. Use the normal staging review and deployment checklist.

## Features

- Admin **Overview** extends existing cards with today's platform fees, this month's platform fees, active payment links and 30-day settled success rate. The success denominator includes terminal settled, expired and invalid payments; new and pending are excluded.
- Member **Reports** groups payment attempts by Bangladesh calendar month, returns outcome counts, platform fee, gross/net earnings, top links and up to fifteen recent payment records. The current payment model does not record a payer name or email; the report displays link, time, status and coarse country, not invented customer identities.
- **Admin invoices** are manually entered, non-settlement administrative statement records. They can be drafted, outstanding, paid with a required external reference, or cancelled. Final states cannot be edited. A statement has no ability to generate a BOLT11 invoice, deposit money, change a user's balance, authorize a withdrawal or mark a real payment settled.
- **Invite member** creates a pending application via Supabase Auth email invitation, never a ready-to-use account. The new user follows ordinary email confirmation and manual admin approval.
- **Payment methods** is a typed toggle screen over existing settings. It still requires configured provider credentials, safe operational checks and audited platform-setting writes. The screen does not rotate or import secrets.
- Login and registration get accessible show/hide password buttons. No password is stored by the visibility component.
- Admin **Security** already had passkey enrollment, listing and removal. The new readiness section reports whether the administrator has zero, one or two passkeys registered and offers a manual verification prompt. Authenticators that require legacy one-time codes are not enabled by this work.

## Implementation

- Migration: `supabase/migrations/20261030020000_admin_parity_reports.sql`.
- Admin invite Edge Function: `supabase/functions/admin-user-invite/index.ts` (admin role and active state verified; fresh passkey sign-in required; the service-role key stays on the server).
- UI: `public/admin-parity.js`, `public/monthly-reports.js`, `public/password-visibility.js`, and existing Admin / Dashboard / Security screens.
- CI: `ci/admin_parity_test.sql`, `tests/frontend/admin-parity.test.mjs`; function drift allowlist is updated.

## Security and go-live gates

1. Complete M1 migration and frontend deployment prerequisites. An invited account must remain pending, even if historical automatic approval flags are present.
2. Apply M13 migration to a **disposable or staging** database first. Run the full SQL permission and migration-replay tests.
3. Deploy and configure the new `admin-user-invite` Edge Function with verified site-domain CORS and email invitation templates. Never expose the service-role secret in the browser. Verify the invitation email delivers and that the pending user cannot access active-only pages.
4. Deploy the new public JS/HTML/CSS only after the migration and Edge Function are ready. Verify overview, reports, statement CRUD and method toggles with a non-financial test account.
5. Ensure every active admin has a verified passkey, ideally two independent passkeys, before changing any admin security toggle. Keep server-side `strong_session()` enforcement.
6. Avoid enabling new payment routes from the UI until provider health, routing/liquidity, current open invoices and reconciliation have been checked. **This PR never changes live receiving or settlement.**
7. Verify the manually entered statement is not included in `payments`, balance, platform fees, or payout calculations, and a marked-paid statement requires an external proof reference.
8. Confirm all CI gates are green before merge; do not infer successful operation from a source-code review alone.

## Outstanding separate tasks

The public comparison and this PR cannot establish live-payment compatibility, production email delivery, or completeness of historic invoice reconciliation. Terms/Privacy/Contact placeholders and branding decisions remain separate content-owner tasks. True hosted billing invoices with line items and automated collection would require an additional designed backend, not converting these non-ledger statements into payment rows.
