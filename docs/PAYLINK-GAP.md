# Payment-link implementation gap audit (M0)

Audit date: 2026-10-30 (Asia/Dhaka). Source: `main` at
`5a0c4849e6e0fd3d58ca3823c1c24d38a8583366` (175 migrations).
Target: the owner's supplied `chatgpt-cpay.md`, milestones M0–M12.

This is a source audit and implementation plan, not verification of deployed
settings, live funds, node connectivity or payer acceptance. M0 changes documentation
only. No migration, production setting, payment, notification or deployment is part
of this milestone. The existing checkout remains the active implementation.

## Evidence and precedence

Read [AGENTS.md](../AGENTS.md), [SYSTEM-OVERVIEW.md](SYSTEM-OVERVIEW.md),
[CPAY_CURRENT_ARCHITECTURE.md](CPAY_CURRENT_ARCHITECTURE.md),
[ARCHITECTURE.md](ARCHITECTURE.md),
[FINANCIAL-INVARIANTS.md](FINANCIAL-INVARIANTS.md) and
[SECURITY.md](../SECURITY.md), then checked the implementing files and later
migrations. Historical prose is not evidence of today's deployment.

Examples of documentation drift: ARCHITECTURE describes a single payout method
and Realtime invoice tracking, while the current overview describes manual payouts
and `invoice-view.js` polls. SECURITY still describes anonymous access to recent
payments; migration `20261007110000_public_payment_exposure.sql` revokes that
access. Correct those statements during M12; do not restore the old access.

The new specification deliberately authorizes a per-user commission, overriding
the older blanket prohibition for this project. M5 must update that instruction
explicitly while keeping removed reseller/team features removed. Passkey step-up,
append-only migrations, wallet leases, exact amounts and idempotency remain.
The specification's “MFA recommended” is not permission to weaken step-up.

## Gap matrix

| Item | Current source evidence | Required change | Risk / milestone |
|---|---|---|---|
| Landing and legal | `public/index.html`, `legal-fields.js`; legal publication is gated by owner-entered fields. | Align hero, features, FAQ and CTAs with CPAY branding. Retain draft legal handling until owner provides content. | Medium; M11/M12. Do not publish empty legal pages. |
| Registration | `public/register.html` has display name, email, password and individual/business selection. It submits metadata inline; `auth-ui.js` is presentation only. Phone, optional Telegram username and password confirmation are missing. | Add validated fields and bilingual strings; preserve email confirmation, CAPTCHA and account type. Store private contact fields separately from public display data. | Medium; M1. Do not put private fields in public link RPCs. |
| Mandatory approval | `20261017010000_account_type.sql` defines `handle_new_user()` using `cpay_auto_approval_enabled`; `20261028030000_auto_approval_switch.sql` lets a strong-session admin toggle it. `login.html` already handles inactive statuses. | Make every new ordinary account pending regardless of metadata or the old auto-approval setting; retire the UI toggle for this policy without changing existing users' status. Improve rejected/suspended support wording. | High; M1. Test signup with the old flag both true and false. |
| Approval queue and guards | `admin-desk.js`, `ci/account_approval_test.sql`, profile whitelist in `20261005020000_remove_reseller_role.sql`, and later step-up migrations exist. | Extend existing queue with contact fields, retain audited approve/reject/suspend/reactivate and strong-session checks; test all protected fields and pending reads/writes. | High; M1. Keep role `creator` internally; do not rename it to `user` across the schema. |
| Links and amounts | `create-invoice/index.ts` accepts $1–$5000 and mixed-case slugs. Per-profile ceilings and emergency stops exist. No target per-link `min_usd`, `max_usd`, `quick_amounts` fields were found. | Add bounded link settings and note, server-enforced global $10–$1000 defaults, valid chips and matching form. Reject excess decimal places rather than relying on the shared parser's rounding. | High; M2. Keep existing stricter profile limits. |
| Slug compatibility | Checkout explicitly treats mixed-case links as distinct; `404.html` rejects paths containing `/`. | Add `/pay/<slug>` routing and lowercase rules for new links. Inventory case-fold collisions before any backfill; preserve existing links with a deliberate compatibility policy. | High; M2/M10. Blind lowercasing can point a payment at a different merchant. |
| Invoice provider | `create-invoice` routes to the wallet service or BTCPay. Current `INVOICE_MINUTES = 5`. No LND client, watcher or LND flag exists in the source tree. | Add LND as an explicit provider behind `lnd_checkout_enabled=false`; use one-hour expiry only for that path. Preserve provider identity and all legacy settlement routes. | High; M3. Old invoices must reconcile after switching providers. |
| Rate and amount conversion | `_shared/btc-rate.ts` already provides a 60-second cache, multi-source agreement and integer conversion; `_shared/money.ts` handles cents. | Reuse helpers after reviewing rounding, store the exact quote/rate/time/sats used on the payment, and validate the returned BOLT11 amount/hash/network/expiry. | High; M3. Do not trust browser rates or reprice settlement. |
| LND security and status | No LND tunnel client or node-status function exists. | Server-only invoice-scoped macaroon and Access headers, TLS verification, bounded timeouts, no redirects to untrusted hosts, redacted errors. Add admin read-only node health. | High; M3/M12. No cloud spending capability or public node-health secrets. |
| Public invoice lookup | `get_invoice_public(uuid)` and `lookup_payment_status(text)` exist; anonymous payment-table access is revoked. | Add the specified `/payment-status?id=...` contract returning only status, USD amount and settlement time; rate-limit and coalesce provider lookups. Keep a separately reviewed invoice bootstrap response for QR data. | High; M3/M4. Avoid making each browser poll an unbounded node request. |
| Settlement | Existing delivery-id/payment-reference guards and financial invariant suites cover current providers; states include `new`, `pending`, `expired`, `invalid`, `settled`. | Add provider-scoped hash uniqueness and guarded LND transitions. Normalize public status without globally renaming legacy states. Test concurrent watcher/on-demand checks, retries and delayed observations. | High; M3. Expiry must not discard a real receipt. |
| Checkout | `invoice-view.js` already has an encoded Cash App deeplink, wallet URI, QR/copy, countdown, success/failed/expired states and 3-second polling. QR currently uses bare lowercase invoice; hidden tabs skip fetching; expiry starts a 3-minute late-check loop. | Render uppercase `LIGHTNING:` QR, show sats beside USD, use the new endpoint and 10-second hidden polling; define terminal behavior consistently with server reconciliation. | Medium; M4. Do not lose existing late-payment protection accidentally. |
| Commission and balance | `stamp_payment_platform_fee()` stamps on settlement; link `cost_percent` can change payer charge. `get_balance_for()` subtracts fees, excludes unreleased forwards and releases failed/rejected withdrawals. | Introduce creation-time per-user percentage snapshot, exact commission/net and unchanged historical fees. Reuse fee columns where compatible; prohibit charging both the old fee and new commission. | High; M5. New gross must equal the amount shown to the payer. |
| Daily statements | `business_day()` is midnight Asia/Dhaka (`20261021030000`); `daily-report` upserts global `daily_stats`; `daily-desk.js` already displays daily aggregates. No target `daily_invoices` table exists. | Add per-user statements, explicit 19:00 boundaries, unique user/cycle, open/closed/paid-out lifecycle, admin Run now and 13:05 UTC cron. | High; M6. Do not silently rewrite old reports or change withdrawal-limit windows. |
| Dashboard | Existing desk covers balance, links, payments, withdrawals and profile; daily view supports selectable ranges. | Add statement detail, cycle commission, 30-day earnings/top links and safe CSV export with server pagination/date filters. | Medium; M7. Existing page limits must not truncate exports silently. |
| Withdrawal queue | `20261028050000_manual_payouts.sql` already reserves under a profile lock, checks active account/step-up/balance/limits, and creates pending requests; admin payout actions exist. Minimum is $5 and methods are restricted in SQL. | Reuse reservation and claim mechanisms; add configurable minimum/method definitions, saved destination snapshots, reference/reason and required lifecycle. Keep auto-approval off. | High; M8. Test two sessions, failed/uncertain sends and reject-once behavior. |
| Telegram | `telegram-notify` and an idempotent `telegram_outbox` exist. Current settled trigger queues an admin message; no `telegram-webhook` or user one-time-code linking flow exists. | Add hashed single-use 15-minute codes, atomic consume, fail-closed webhook secret check, `/stop`, user preferences and specified events. Reuse dispatcher and dedupe keys. | High; M9. Do not expose chat IDs, codes or user emails publicly. |
| Domains and OG | `site_domains`, OG Worker and image function exist. Worker handles single-segment slugs and intentionally lets unregistered hosts pass through its root resolution. | Enforce active hostname at the request boundary for normal and crawler requests, add `/pay/` aliases, consistent versioned per-link image URLs and per-domain link copy. | High; M10. Client `location.hostname` alone cannot enforce this policy. |
| Copy and branding | `check_public_copy.py` already checks pages, scripts, README, SECURITY and docs, including admin files. It does not implement the exact Cash App label/color exception policy. | Define public/private bundles, extend checks for factual-button-only usage and brand colors, audit actual rendered pages and images. | Medium; M11. A hidden dashboard label in a shared public bundle still ships publicly. |
| Hardening and CI | Existing `verify.yml` has fresh DB migration replay, SQL suites, Deno checks/tests, frontend tests, E2E and full-history gitleaks. RPC allowlists exist but enumerate SECURITY DEFINER functions. | Extend tests for new paths and all exposed callable functions, verify RLS/grants and column leaks, reconcile docs and secrets examples. | High; M12. Do not replace existing tests with the new acceptance list. |

## Design decisions needed in implementation

1. **New receipt custody and payout funding.** LND receipts are held by the
   operator's node; the existing sending wallet does not automatically gain that
   balance. An invoice-only macaroon cannot fund withdrawals. Keep the new flag
   off until manual payout funding and reconciliation are operationally proven.
   Enabling LND must not enqueue unfunded automatic forwards. Preserve the old
   engines and existing liabilities; do not call an inter-wallet transfer revenue.
2. **Commission is a platform fee, not a revived reseller ledger.** Default plus
   per-user override is snapshotted on creation. Existing settled rows retain their
   recorded fee. Old open invoices retain their original policy when paid later.
   The new $100 at 5% example must yield $100 payer gross, $5 fee and $95 net.
   Current markup semantics and withdrawal fees need explicit compatibility tests.
3. **Expiry versus settlement evidence.** Query authoritative node state before
   deciding expiry; an unavailable node is not proof of expiry or failure. Handle
   OPEN/ACCEPTED/SETTLED/CANCELED explicitly. Keep unresolved records eligible for
   reconciliation. The spec's pending-only transition must be designed alongside
   late observation recovery so a page countdown cannot permanently lose credit.
4. **Creation retry recovery.** The existing request-id mechanism must also cover a
   successful node call followed by a database write failure. Design a durable
   creation attempt and recoverable hash linkage before returning a payable QR;
   do not blindly create another invoice on a timeout.
5. **Cycle date convention.** Proposed `cycle_date` is the closing Dhaka date:
   `[previous date 19:00, cycle_date 19:00)`. Thus a receipt at 18:59 is in today's
   closing cycle; 19:00 and 19:01 are in tomorrow's. Test midnight, month/year edges,
   reruns, late receipts, reversals and paid-out immutability. Use separate cycle
   helpers instead of silently changing calendar-day security limits.
6. **Public access has multiple legitimate consumers.** Keep explicit allowlisted
   link/OG/legal-setting bootstrap contracts while narrowing payment status.
   The target's two-entry example cannot simply replace the current allowlist
   without migrating all callers. Prove unknown-ID and cross-user behavior too.
7. **Cash App acceptance is a live release check.** A deeplink or invoice without
   private-channel hints is not payment-success evidence. Confirm the deployed
   node is synced and publicly reachable with inbound capacity, then obtain the
   owner's authorized $10 receipt matched to the payment hash and settled ledger.
   No live node or payment test was performed for M0.

LND API references checked for the proposed adapter:
[AddInvoice](https://lightning.engineering/api-docs/api/lnd/lightning/add-invoice/),
[LookupInvoice](https://lightning.engineering/api-docs/api/lnd/lightning/lookup-invoice/),
and [receiving guide](https://docs.lightning.engineering/lightning-network-tools/lnd/receiving).
The create response uses a byte hash (base64 in REST); the legacy lookup path uses
a hex hash. Normalize and validate that boundary. `private` controls inclusion of
private-channel hints; do not pass caller-supplied route hints. These API references
do not establish this installation's connectivity or payer compatibility.

## Ordered PR and acceptance plan

Each branch starts from the reviewed predecessor (or an explicitly stacked base)
and runs Verify. No merge or deployment is implied by a branch or PR.

| Milestone / suggested branch | Main files / additive migration scope | Verification |
|---|---|---|
| M0 `audit/paylink-gap-20261030` | This report and overview pointer; no migration or runtime code. | Public-copy and Markdown-link checks. |
| M1 `feat/paylink-approval` | Register/login/admin/i18n; additive profile/contact and mandatory approval migration; guard RPCs. | Acceptance 2–3; auto-approve flag bypass attempts, metadata escalation, inactive reads/writes, strong-session admin path. |
| M2 `feat/paylink-amounts` | Link SQL/RPCs, `404.html`, desk and i18n; additive bounds/chips/note migration. | Acceptance 4; decimal rejection, chip validation, narrowed bounds, existing case-sensitive links. |
| M3 `feat/paylink-lnd` | Shared REST adapter, create/status/watcher/node-status functions, additive provider/quote/flag/cron SQL. | Acceptance 5/7; mocked credentials, hash conversion, retry recovery, concurrent reconcile, flag off, no production calls. |
| M4 `feat/paylink-checkout` | Invoice view, checkout templates, i18n, Playwright. | Acceptance 6; exact deeplink, uppercase QR, foreground/hidden intervals, network errors and terminal states. |
| M5 `feat/paylink-commission` | Additive snapshot/fee migration, admin UI/RPC, guards, AGENTS and financial tests. | Acceptance 8; percentage change between creation/settlement, rounding and legacy rows; preserve historical commission-removal tests. |
| M6 `feat/paylink-statements` | Additive statements/cycle helpers/cron, daily function, admin Run now. | Acceptance 9; boundary fixtures and two concurrent generators; do not overwrite paid-out statements. |
| M7 `feat/paylink-dashboard` | Desk/daily view/i18n and scoped reporting RPCs if required. | Owner-only reports, export beyond one page, CSV formula-injection handling, empty/error states and chart totals. |
| M8 `feat/paylink-withdrawals` | Additive payout configuration/destination snapshot and queue adaptation. | Acceptance 10; real concurrent DB sessions, immutable snapshots, reject once, audited decisions and reference. |
| M9 `feat/paylink-telegram` | Additive link-code/event SQL, webhook, dispatcher extensions and settings UI. | Acceptance 11; mock delivery only, missing/wrong secret, expired/replayed code, chat replacement and `/stop`. |
| M10 `feat/paylink-domains-og` | Worker routes, OG function, domain RPC/cache and dashboard links. | Acceptance 12/16; real request boundary, unknown/inactive host, crawler/normal UA and both slug routes. |
| M11 `feat/paylink-brand-copy` | Public templates/assets, CSS/i18n and scoped copy checks. | Acceptance 14; rendered public pages, shared bundles, color/image review and keyboard/mobile QA. |
| M12 `chore/paylink-hardening` | Allowlists, RLS/security tests, headers, secrets docs/examples and release checklist. | Acceptance 1/13/15 plus the complete 1–16 matrix; full CI and staging evidence. |

No migrations are added in M0. Future filenames must sort after the latest main
migration at implementation time (currently `20261028050000_manual_payouts.sql`).
Do not edit old migrations or treat old data as safe to rewrite.

## Validation and staging handoff

M0 local checks: `python3 ci/check_public_copy.py` and
`python3 ci/check_md_links.py`. These check the documentation changes; they do not
prove the requested application exists or that production is healthy. No new test
is needed for a documentation-only inventory. The PR still runs the existing Verify
workflow; its result must be recorded separately from local checks.

For each implementation PR, use a disposable staging project and fake provider
responses first. Replay the entire migration chain using the workflow's bootstrap,
apply-order and SQL test steps. Run the existing frontend/Deno/payment-service
suites and the new milestone tests; run Playwright on the disposable stack. Do not
use production data or real Telegram deliveries for automated tests.

On staging, verify registration with both values of the legacy auto-approval flag,
approve a test account using a passkey session, and confirm a second account cannot
read or mutate its links/payments/statements. Verify all money fixtures with exact
cents and controlled timestamps. Keep `lnd_checkout_enabled=false` throughout
unrelated milestones and document the staging switch when testing the LND adapter.

Before go-live, record the tested commit, green checks, applied migrations,
deployed functions, owner-completed legal fields, credential scope, node and payout
funding evidence, and an owner-authorized $10 live acceptance test. Turning off the
LND creation flag must stop new LND invoices while keeping outstanding ones under
reconciliation. Merge, production changes and the final activation remain owner
actions requiring explicit go-ahead.
