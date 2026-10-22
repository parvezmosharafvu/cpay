# Source release-readiness review

Reviewed 2026-10-22 (Asia/Dhaka). Scope: supplied CPAY source ZIP and local test/build evidence. No production release approval is issued by this report.

## Later GitHub verification (2026-10-22)

This file started as a local source-ZIP review. Since then, [PR #169](https://github.com/parvezmosharafvu/cpay/pull/169) imported the reviewed changes to a Git branch. GitHub [Verify #604](https://github.com/parvezmosharafvu/cpay/actions/runs/39716367388) succeeded across all seven jobs on commit `cee66091ba537a033e7c5f3be88bd45ff4c8b63f`, including a disposable Postgres/PostgREST stack, payment-service and RLS E2E scenarios, wallet checks and production dependency audits. This **resolves the earlier lack of GitHub CI evidence for that specific SHA**; it does not retroactively make the local ZIP environment capable of running those tests.

Later edits on the same review branch harden the release gate: a future or invalid restore-drill date, invalid age limit, or invalid clock input must refuse release; regression tests cover those cases. Verify #608 subsequently passed on commit `00105405597dc0ad48d5b66fd2f6a5eac6919136`. Later commits strengthen owner acceptance enforcement. **Each new review-branch head needs its own successful Verify run**, and a future `main` merge/release must be checked independently for its exact SHA. The Cloudflare PR preview is not evidence of a production deployment.

The production-only items in the table below and the [open owner blockers](RELEASE-BLOCKERS.md) remain outstanding. In particular, neither synthetic CI nor a preview proves wallet solvency, real reconciliation, independent physical recovery keys, a current restore test, legal publication, or physical device/screen-reader acceptance.

## Connected CPAY Supabase evidence (read-only, 2026-10-22)

The correct connected project was independently resolved as `riumaeihemgznvgattoc` (ACTIVE_HEALTHY, Pro organisation), matching `public/config.js` and `supabase/config.toml`. A new automated frontend check fails if these project references drift. The live metadata query reported 163 recorded migrations, 16 active Edge Functions, and RLS enabled on all 33 ordinary `public` tables. The Security Advisor still reports role-grant/search-path/MFA findings. Full classification and remaining scoped remediation are in [SUPABASE-SECURITY-ADVISOR-REVIEW.md](SUPABASE-SECURITY-ADVISOR-REVIEW.md).

This evidence does **not** prove function-by-function authorization, exact production source SHA, verified passkey recovery, current wallet solvency, restore recoverability, or real reconciliation. No production database writes, financial operations or operational settings were changed. Release approval remains withheld until owner decisions and independent operational acceptance.

## Pending production migration — forward-delete guard search path

The review branch now includes Supabase CLI-generated migration
`20261022051634_pin_forward_delete_guard_path.sql`, which pins the existing
`public.payment_forwards_no_delete()` trigger's search path without altering
its body or privileges. The database CI suite applies it on a disposable
PostgreSQL stack and checks deletion remains prohibited. This **source fix is
not deployed to CPAY's live Supabase project**; the live Advisor warning
requires a separate approved migration deployment and post-deploy read-only
verification. Existing release blockers, including Legal / Contact owner
publication and the independent wallet/restore security checks, remain open.

## Read-only solvency evidence (2026-10-22)

The source now includes `ci/solvency_readonly_snapshot.sql`, a SELECT-only
operator snapshot of non-negative per-account USD available claims, unsettled
withdrawals, owed forwards, and separate recently synced mainnet wallet balance
in satoshis. It was exercised read-only against the correctly connected CPAY
project. No personal or treasury values were committed to the public
repository. The query **always returns `UNVERIFIED`**; it cannot certify
solvency without independent, current wallet proof and a conservative BTC/USD
rate, reconciliation and owner sign-off. The procedures and limitations are in
[SOLVENCY-SNAPSHOT.md](SOLVENCY-SNAPSHOT.md). The corresponding Medium owner
blocker remains open. GitHub CI uses only disposable PostgreSQL to validate
the non-authorizing query shape; a green test is not reserve evidence.

## Turnstile fail-closed configuration hardening (2026-10-22)

The review source now preserves an explicitly configured
`TURNSTILE_MODE=enforce` even when `TURNSTILE_SECRET_KEY` is unset
or blank; `checkTurnstile()` refuses invoice creation with a
`configuration` result before contacting the verifier. Regression tests
also ensure that `off` remains an explicit default and `monitor`
reports the missing configuration without enforcing. The change prevents
an operator typo from silently disabling a requested security gate.
**It does not configure Turnstile on the live project, prove bot
protection for deployed invoices, or authenticate the unsigned proxy IP
header.** Production settings and approval remain owner-controlled.

## Verified locally

| Area | Evidence | Limit |
|---|---|---|
| Frontend behavior | 255 Node tests passed | Mocked API/session responses |
| Public/desk/merchant browser suite | 125 tests passed in Chromium | Includes 62 accessibility scans across 14 scenarios, keyboard scrolling, 19 owner UI scenarios and 20 rendered-QR roundtrips; synthetic data |
| Accessibility scans | Member/admin overviews and 14 internal sections at 390px/1440px; login/register stable forms; WCAG 2 A/AA and 2.1 AA rule tags; zero violations in these scans | Not full compliance certification, all UI states, assistive-technology or physical-device acceptance |
| Static upload packaging | prepare-direct-upload generated dist successfully with Bengali fonts/license | Build only; no upload/deployment |
| Wallet real-SDK regtest build | Previously passed with locked dependencies | Not a mainnet release or live transfer |
| Wallet browser flows | Previously 25 fake-engine tests and 5 real SDK/virtual-passkey tests passed; live-regtest test skipped | Not physical passkey or live payment evidence |
| Source checks | Frontend, public copy, Markdown, legal structure, workflows and generated guide passed | Runtime configuration and live data not established |

The accessibility scans wait for the authentication form's opacity transition to finish; scanning halfway through fade-in produced transient contrast results. No WCAG rule or page element was excluded to obtain the final result. No-JavaScript form visibility remains covered by the existing browser smoke tests, not by these axe scans.

## Production evidence still required

| Gate | What the source currently establishes | Outstanding |
|---|---|---|
| Repository/deploy identity | The archive contains no Git history | Verify exact origin/main SHA, clean worktree, Verify workflow and deployed Workers check for that SHA through the normal release gate |
| Legal / Contact | Owner explicitly deferred dashboard entry until project work is complete | Owner fills and approves fields, then publishes; normal publication/release validation remains unchanged |
| Restore/recovery | BACKUP-RECOVERY.md contains a historical Pass row dated 2026-10-13; the existing parser accepts its date/result within the configured 90-day window | This review did not independently rerun the drill or verify current production backup configuration |
| Release blockers | CI source checks showed no open Critical/High rows. The release gate now separately refuses unresolved Medium owner items | Owner must close every outstanding Medium item or document explicit dated acceptance with an evidence reference in RELEASE-BLOCKERS.md; passing CI alone is insufficient |
| Money/runtime | Local read/decision/UI tests pass | Current solvency comparison, low-value withdrawal reconciliation, real authorization, runtime protection/schedules and physical-device acceptance remain separate evidence |
| Admin recovery | Local passkey UI and virtual-authenticator tests exist | Verify real independent admin passkeys and recovery readiness in the actual environment |

No full production release gate was claimed or bypassed from this archive. It requires Git/GitHub/deployment evidence and legal publication. No production settings, secrets, accounts, ledger rows or payments were changed in this review.

## Reproduce local checks

```sh
npm ci --ignore-scripts
npx playwright install chromium
npm run test:frontend
npm run test:public
npm run test:accessibility
npm run prepare:upload
```

The accessibility script is a subset of test:public, not an extra independent pass count. Playwright starts the local public server by default; Python 3 is needed. For the previously documented wallet suites, also install wallet dependencies and follow LOCAL-BROWSER-QA.md. Generated dependencies, builds and internal screenshots are excluded from the source ZIP.

## Owner UI completion evidence

Batch 17 adds names-only ready state, missing setup, denied access and passkey-required presentation in English/Bangla at two viewport widths. The actual generated Bangla guide passes keyboard section selection and refresh tests at both widths; non-owner navigation is hidden. These fixtures establish UI behavior, not server authorization or real secret configuration. See [FINAL-HANDOFF.md](FINAL-HANDOFF.md) for the handoff boundary.

Latest wallet and repository observations: [RELEASE-EVIDENCE-SNAPSHOT.md](RELEASE-EVIDENCE-SNAPSHOT.md). These observations do not close the production acceptance gates.

Batch 19 follow-up: [BACKEND-LOCAL-QA.md](BACKEND-LOCAL-QA.md) records 31 passing payment-service unit tests, the non-passing database suite, and the Deno dependency-download blocker. Deno was runnable through npm; real-RLS integration remains unverified.

## Rendered QR evidence

Batch 20 verifies successful-library rendering and pixel-decoding at two widths in ten merchant themes, including the central logo. The library bytes match the existing CDN integrity hash; external CDN reachability and physical-camera scanning are not established by local routing. See [LOCAL-BROWSER-QA.md](LOCAL-BROWSER-QA.md).

## Keyboard table access

Batch 21 fixes mobile admin table regions that could not receive keyboard focus. New scans cover populated internal section fixtures, and a keyboard test confirms horizontal ArrowRight scrolling and tab-stop removal after resize. See [LOCAL-BROWSER-QA.md](LOCAL-BROWSER-QA.md) for scope and remaining acceptance.

## Bengali section verification

Batch 22 repeats the 14 internal section scans in Bengali at both widths with zero tagged violations in these fixture states. The last frontend test run remains Batch 21. No production code changed. Physical/manual, translated state completeness and live acceptance are still required.
