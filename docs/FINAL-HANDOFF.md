# CPAY source handoff

Date: 2026-10-22 (Asia/Dhaka).

The section-by-section implementation work and recorded local automated review are packaged in this source archive. This is a source handoff, not an assertion of production acceptance.

## Delivered

- Shared design and member, admin, merchant/checkout, store and wallet sections are implemented. Detailed changes and scope are in [CORE-DESIGN-WORKLIST.md](CORE-DESIGN-WORKLIST.md).
- 125 Chromium browser scenarios pass; the last frontend run (Batch 21) passed 255 tests. The browser total includes 19 owner UI scenarios, 62 accessibility scans across 14 scenarios, a keyboard-scroll case and 20 rendered-QR roundtrips; these counts are not additive.
- Bengali fonts and their license are bundled; desktop/mobile and English/Bangla fixtures are documented in [LOCAL-BROWSER-QA.md](LOCAL-BROWSER-QA.md).
- Static upload bundle preparation succeeded in Batch 16. Source ZIP excludes installed dependencies, generated builds and internal screenshots.
- No live deployment, payment, secret or operational setting was changed.

## Owner acceptance still required

| Item | Required evidence / action |
|---|---|
| Legal / Contact | Fill and approve in the dashboard after project work, as requested; retain publication validation |
| Production release | Verify exact Git/deployed SHA and CI through the existing release gate |
| Money and authorization | Reconcile current balances and a low-value withdrawal; verify real role/owner authorization in the intended environment |
| Recovery and operations | Verify independent physical admin passkeys, actual backup/restore readiness, protection and scheduled-task settings |
| Manual acceptance | Check physical mobile/installed PWA, screen-reader use and real account/data states not represented by fixtures |

These are acceptance requirements, not unfinished source edits that local fixtures can truthfully close. The historical restore record and remaining owner blocker items are explained in [RELEASE-READINESS.md](RELEASE-READINESS.md). No release gate was relaxed.

## Local verification

Follow [RELEASE-READINESS.md](RELEASE-READINESS.md) for install, frontend, browser, accessibility and static bundle commands. Follow [LOCAL-BROWSER-QA.md](LOCAL-BROWSER-QA.md) for wallet test prerequisites and limitations. Do not use fixture account/session data in production.

Latest wallet and repository observations: [RELEASE-EVIDENCE-SNAPSHOT.md](RELEASE-EVIDENCE-SNAPSHOT.md). These observations do not close the production acceptance gates.

Batch 19 follow-up: [BACKEND-LOCAL-QA.md](BACKEND-LOCAL-QA.md) records 31 passing payment-service unit tests, the non-passing database suite, and the Deno dependency-download blocker. Deno was runnable through npm; real-RLS integration remains unverified.
