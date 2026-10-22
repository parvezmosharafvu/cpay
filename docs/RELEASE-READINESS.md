# Source release-readiness review

Reviewed 2026-10-22 (Asia/Dhaka). Scope: supplied CPAY source ZIP and local test/build evidence. No production release approval is issued by this report.

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
| Release blockers | Source parser finds zero open Critical/High rows; RELEASE-BLOCKERS.md still has owner Medium items | Owner closes or explicitly accepts every outstanding item; do not equate the narrower parser result with all blockers being closed |
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
