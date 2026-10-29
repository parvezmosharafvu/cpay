# Payment-link rebuild — M0 repository gap audit

**Audit date:** 2026-10-30  
**Repository:** `parvezmosharafvu/cpay`  
**Audited base:** `main` at `5a0c4849e6e0fd3d58ca3823c1c24d38a8583366`  
**Scope:** Source and documentation review only; no deployments, database queries against production, live invoices, real credentials, or CI execution.  
**Target:** The owner-supplied payment-link functional specification (M0–M12). This audit describes gaps, not approval to change production behavior.

## Source of truth and important constraints

1. Read `AGENTS.md` and `docs/SYSTEM-OVERVIEW.md` as the current rules and behavior; older architecture notes can be historical or stale.
2. `AGENTS.md` prohibits changes to fees, forwarding, or settlement without explicit owner approval; it also says no reseller/commission features. The supplied target deliberately adds per-user commission. **This conflict must be resolved and documented before M5.**
3. Existing payments may flow through the platform wallet, or the owner-controlled BTCPay receiving route when its setting is enabled. Direct-to-merchant and manual payout/auto-withdraw paths also exist. **Do not replace existing settlement writers, payout reservation rules, or financial ledger semantics.**
4. The target requests a new public LND receiving node. A deployed, reachable and funded LND node is **not established by this repository audit**. A feature flag set to false by default is mandatory; source code or a test mock cannot prove live routing or payer compatibility.
5. All migration changes must be append-only. All future changes go through separate reviewable PRs, and no PR may be merged or deployed without owner approval.
6. Public files and `docs/` are scanned by `ci/check_public_copy.py`; avoid prohibited provider or payout names and broad wallet-compatibility promises.

## Functional gap matrix

| Target capability / milestone | Existing state in audited code | Change needed / proposed ownership | Risk |
|---|---|---|---|
| Landing page, FAQ and CTA (M11) | `public/index.html` already markets payment links and routes to registration; current messaging describes the existing balance/auto-withdraw model. | Review against target journey, add any missing FAQ or steps, preserve own branding and bilingual strings. | Low — messaging can disagree with the live payout model if prematurely changed. |
| Sign-up and approval (M1) | `public/register.html` collects account type, business name where relevant, display name, email and password. `account_applications`, pending/approved/rejected states and an admin review queue exist; `ci/account_approval_test.sql` covers the approval path. | Add phone, optional Telegram username and password confirmation; server validation, profile guards and pending/rejected experiences; extend tests. | Medium — current `admin_set_auto_approval` allows auto-activation. Target requires manual approval always, including for future sign-ups. |
| Login, reset, role guard (M1/M12) | Existing email/password, email verification, passkeys, dashboard and admin guard logic. | Verify active-only data access and rejection/suspension behavior in SQL and Edge Functions; do not weaken existing passkey step-up for sensitive actions. | High if enforcement is only in the UI. |
| Link slugs, metadata, options (M2) | `payment_links` exists with slug, display name, status, layout, per-link cost and wallet-mode fields. Dashboard can create, search and disable links. | Add/verify `note`, per-link min/max and per-link `quick_amounts`; implement edit UI and enforce tighter-of-global-and-link limits on the server. | Medium — existing link variants, cost markup and direct settlement must remain valid. |
| Checkout amount enforcement (M2/M4) | `public/404.html` uses `MIN_AMOUNT=1`, `MAX_AMOUNT=5000`; `create-invoice/index.ts` independently permits $1–$5000 before profile and markup limits. Fixed quick chips already exist. | New configurable global $10–$1000 bounds, max two decimals, per-link narrower bounds and matching server/UI error messages. | High — change both client and server in the same milestone; determine whether old active links need grandfathering. |
| Invoice creation / expiry (M3) | `create-invoice` currently branches to the platform wallet engine or BTCPay, with a five-minute expiry (`INVOICE_MINUTES=5`). Request IDs and public rate limits already exist. | Add `lnd_checkout_enabled=false`, an LND-only authenticated REST client and 3600-second expiry on that route; persist hash, sats, rate and origin. Keep existing routes intact. | Critical — existing invoices and gateway-specific settlements must not be retroactively reinterpreted. |
| Exchange-rate conversion (M3) | `_shared/btc-rate.ts` already fetches cross-checked BTC/USD prices, with a 60-second in-process cache, for direct settlement. Existing wallet invoice pricing has its own path. | Reuse or adapt the rate utility with integer-cents/sats arithmetic; persist the precise quoted rate and validate small-amount rounding on the LND path. | High — reconciliation and amount consistency. |
| LND settlement watcher (M3) | Wallet settlement and `btcpay-webhook` exist; LND-specific `lnd-watcher`, `payment-status` and the requested `_shared/lnd.ts` are not present in the inspected function directory. | Add narrow invoice-only LND REST access, hash-keyed idempotent settlement, late-settlement reconciliation, watcher authorization and monitored cron. | Critical — duplicate credit, early expiration and missed payments. |
| Checkout UX (M4) | `public/invoice-view.js` already has a Cash App deeplink, `lightning:` URI, QR, copy, countdown, status screens, Realtime and a 3000 ms polling fallback. When hidden, polling currently reschedules at 3000 ms without a status read. | Reuse rather than rebuild. Make the new LND route show exactly its invoice expiry; implement explicit 10-second hidden polling if still desired and verify terminal-state behavior. | Medium — late payments and accessibility. |
| Commission and balance (M5) | Current platform fee is stamped on settlement (`platform_fee_percent`, `platform_fee_amount`). `ci/commission_removal_*.sql` preserves a prior deliberate removal of reseller commission. Links also have `cost_percent` markup. SQL derives balances and protects withdrawal reservations. | Owner must decide whether new per-user `commission_pct` **replaces** or coexists with platform fee and link markup. Add distinct stamped numeric fields and update all affected read paths only after invariants are approved. | **Critical / owner decision** — double charges, historical balances, precision, payout liabilities. |
| Daily statements at 19:00 Dhaka (M6/M7) | `daily-report`, `daily_stats`, daily dashboard summaries and cron already exist. `20261021030000_dhaka_calendar_day.sql` deliberately uses midnight-to-midnight Dhaka (formerly a 17:00 boundary). | Add a separate, explicitly named 19:00–19:00 **statement cycle** and unique per-user cycle key. Do **not** silently change global `business_day()`: it also influences existing daily metrics and limits. Make generation idempotent and add boundary tests. | High — timezone boundary and historical reporting drift. |
| Dashboard payments, invoices, charts and CSV (M7) | Dashboard includes overview, links, payments, withdraw, account and related sections; existing `daily-desk.js` reports daily figures, but a dedicated target `daily_invoices` statement model is not established. | Add statement tab/detail, 30-day chart, top links, search/filter/CSV in stages. Reuse current paginated payment queries. | Medium — privacy, row limits, old-vs-new day definitions. |
| Withdrawal approvals (M8) | Auto-withdraw, balance/manual withdrawal and admin payout flows already exist; `manual_payouts_only` supports requested/paid/rejected manual decisions and locks auto-withdraw off. | Define exact transition mapping to requested→approved→paid; preserve existing reservation and refund semantics, auditing, strong-session checks and optional off-by-default auto-approval. | Critical — balance liabilities and concurrent reservations. |
| Telegram linking and alerts (M9) | `telegram-notify` and SQL outbox exist for admin-group events; the inspected functions directory has no `telegram-webhook` handler for user `/start` linking. | Add one-time code, expiry, chat link/disconnect, notification preferences, webhook secret-header verification and tests. Reuse the existing outbox delivery path. | High — account-link hijack and webhook spoofing. |
| Active domains and alternate link route (M10) | `site_domains`, owner domain management and a domain-agnostic preview worker already exist. Checkout uses `/<slug>`; support for `/pay/<slug>` and unknown-host denial is **not verified** by this audit. | Add alias routing without breaking static assets; verify active-host allowlist and both routes in Worker tests. | High — accidental cross-domain exposure. |
| OG metadata and per-link image (M10) | `worker/og-preview-worker.js` and `supabase/functions/og-image` already generate crawler metadata and branded 1200×630 images. | Check requested title/description variants, image cache-busting and exact crawler/normal-user routing; reuse current Worker. | Low to medium. |
| Admin settings, audit and node status (M1–M12) | Admin already manages approvals, users, per-user platform fees, gateway settings, payouts, active domains and audit records; passkey step-up is required for protected writes. | Add target-specific link/commission/statement settings and read-only LND health (synced, channel count, inbound liquidity), without exposing macaroons. | High if a node-health probe gets privilege to issue payments. |
| Security and CI (M12) | Existing RLS, RPC allowlists, `strong_session()`, public-exposure checks, frontend checks, SQL invariants and GitHub Actions verification. | Keep the current tests; extend for LND-only credentials, server-side limits, payment status projection, webhook protection, idempotent settlement, scan for credentials and test the new feature flag default. | Critical — no weakening of existing permissions. |
| Separate wallet app / dormant paths (all milestones) | `wallet/`, current wallet functions, BTCPay receive, forward workers and `payment-service/` have separate operational roles. | Leave all in place; switch only the operator-selected receive route after stage verification and a small live invoice. | Critical if reused or deleted without a migration plan. |

## Design blockers requiring owner sign-off before code changes

### D1 — Choose the intended primary receiving rail

The target explicitly specifies an **operator-owned public LND node**; the existing system supports an operator-controlled BTCPay receive path as well as the platform wallet. These are not interchangeable from an operations or payment-routing perspective. Confirm whether LND is an optional future rail, or meant to replace the current primary receiving path. Initial implementation should be additive and default **off** either way.

Before a live switch, verify node sync, advertised public channels, sufficient inbound liquidity, exact invoice expiry, payer-wallet compatibility and settlement evidence. The code audit cannot assert these operational facts.

### D2 — Define one money model

The new `commission_pct` model, existing platform fee and per-link `cost_percent` may all affect payer and creator totals. Agree on a precise formula for: payer charge, gross, platform income, creator net, owed forwards, available balance, withdrawals and refunds. Decide how historical payments remain immutable. Do not merely add a column or rename the fee.

### D3 — Keep statement time distinct from business-day semantics

The target statement window starts at **19:00 Asia/Dhaka**, whereas current `business_day()` is midnight-based and used in several other contexts. Introduce an explicit statement-cycle function rather than replacing the global business-day helper. Cover both 18:59 and 19:01 boundary cases.

### D4 — Decide approval and withdrawals policy

The target says no automatic activation, but auto-approval currently has an admin switch. The target also presents manual payout approval as the primary withdrawal path, while current automated and manual paths coexist. Decide if new policy is enforced for all users or only for the new checkout mode. Preserve existing balances and existing obligations.

## Recommended execution sequence

- **M0 (this PR):** document the above differences only; no migrations, API changes, UI changes or production writes.
- **M1–M2:** account form/approval and per-link amount options, including server-side enforcement and CI.
- **M3:** additive LND client + flag default false, invoice persistence, watcher, rate precision, simulated settlement and concurrent idempotency tests. Existing providers remain available.
- **M4:** reuse current checkout UI, align the expiry/timer and wallet handoff with the actual LND invoice.
- **M5:** fee/commission migrations **only after D2 approval**, with old/new balance parity tests.
- **M6–M8:** separate 19:00 statements, dashboard and withdrawal state model with concurrency tests.
- **M9–M12:** Telegram linkage, multi-domain/OG verification, branding, security hardening and acceptance gate.
- **Go-live:** staging migrations, green CI, inspected secret configuration, operator's explicit switch approval and a small end-to-end payment/receipt reconciliation. Do not infer successful settlement from invoice creation alone.

## M0 verification and handoff

- **Files changed in M0:** `docs/PAYLINK-GAP.md` only (plus an optional cross-reference in the current overview).
- **Migrations:** none.
- **New tests:** none; this is a documentation-only source audit, so there is no runtime behavior to test. Normal PR documentation/public-copy CI should still run.
- **Staging verification:** not applicable to M0; use a fresh staging database and mocked provider calls beginning with M1/M3.
- **Not claimed:** deployed settings, LND/node health, live wallet routes, actual payer acceptance, or successful CI after this audit.
- **Evidence reviewed:** `AGENTS.md`; `docs/SYSTEM-OVERVIEW.md`, `docs/CPAY_CURRENT_ARCHITECTURE.md`, `docs/ARCHITECTURE.md`, `docs/FINANCIAL-INVARIANTS.md`, `SECURITY.md`; relevant `public/` screens, `create-invoice`, `daily-report`, Telegram/OG functions, representative migrations, CI suites and `.github/workflows/verify.yml`.

**Release rule:** Do not merge, deploy, switch invoice providers, or rewrite historical ledger rows until the owner reviews the relevant milestone PR and signs off on D1–D4.
