# Release evidence snapshot — 2026-10-22

Scope: read-only GitHub metadata and local wallet verification. No deployment, real payment or production settings change.

## Subsequent GitHub and Preview evidence (2026-10-22)

The repository observation below predates the review PR and describes only what was available during the local ZIP review. Later, [PR #169](https://github.com/parvezmosharafvu/cpay/pull/169) was opened as a Draft and the source changes were committed. Its commit `cee66091ba537a033e7c5f3be88bd45ff4c8b63f` passed all seven jobs in [GitHub Verify #604](https://github.com/parvezmosharafvu/cpay/actions/runs/39716367388): pages/frontend, database migrations, edge functions, wallet browser/build, dependency/secrets/public smoke, ledger inventory and disposable-stack Playwright E2E (including real RLS checks).

The GitHub PR bot also reported a successful [Cloudflare Preview deployment](https://review-core-design-handoff-20261022-cpay.taylorjamesbusiness0.workers.dev) for that commit. This preview is **not** the public production environment. Later review commits add stricter restore-drill date validation and tests; each new head requires its own CI verification. Never reuse #604 as evidence for a different SHA.

As of this source review there is still **no owner sign-off for production release**. Legal/Contact entry, current solvency, real transfer/reconciliation acceptance, physical passkeys and devices, restore readiness, protection/schedules, and all open owner Medium blockers remain to be independently accepted. No production actions are asserted by this evidence.

## Repository observation

- Repository: [parvezmosharafvu/cpay](https://github.com/parvezmosharafvu/cpay), default branch main, accessible and not archived.
- main resolved to [4bff0a75d6f44f2759594c89ba0168217d32bd0a](https://github.com/parvezmosharafvu/cpay/commit/4bff0a75d6f44f2759594c89ba0168217d32bd0a), merge of PR #162 (pull-chain authentication lamp).
- Combined commit-status lookup returned an empty statuses list. This is neither a passed nor a failed CI result.
- Commit-workflow lookup returned no runs. The available lookup is explicitly limited to PR-triggered runs and the first page; it cannot establish the presence or absence of push/manual Verify runs.
- The edited ZIP has no Git history, and its contents have not been committed or compared in full with that SHA. The observed SHA is not an identity claim for this archive or a deployed build.
- Deployed Workers SHA/check and exact-SHA Verify run remain unverified. Normal release gates still apply.

## Wallet verification

The final combined wallet suite passed 31 scenarios with one skipped live-regtest scenario. This comprises 26 fake-engine scenarios (one new accessibility scenario), one real-SDK loading/CSP scenario, and four real-library virtual-passkey scenarios. No live payment network was used.

The new accessibility scenario checks welcome, unlocked overview and locked vault at the existing Pixel 7 emulated viewport, using WCAG 2 A/AA and 2.1 AA tags. Zero violations were reported in these three stable states; no rule or element was excluded. This does not establish complete accessibility or physical-phone acceptance.

The existing suite also verifies offline reopening/unlocking under the service worker and local backup/restore flows. These are automated synthetic tests, not an independent production backup drill.

## Integration-suite prerequisite check

psql, postgrest, deno and docker were not available in this runtime. The disposable real-RLS E2E stack therefore was not started or reported as passing. The existing suite and stack remain unchanged. Run tests/e2e/playwright.config.ts in its documented provisioned environment; this is distinct from the public fixtures and wallet suite.

## Remaining release decisions

Follow [RELEASE-READINESS.md](RELEASE-READINESS.md) and [FINAL-HANDOFF.md](FINAL-HANDOFF.md). Owner Legal / Contact remains deferred. Real role enforcement, current solvency and withdrawal reconciliation, physical passkeys/installed PWA, production operations and exact deployment evidence remain open.

Batch 19 follow-up: [BACKEND-LOCAL-QA.md](BACKEND-LOCAL-QA.md) records 31 passing payment-service unit tests, the non-passing database suite, and the Deno dependency-download blocker. Deno was runnable through npm; real-RLS integration remains unverified.
