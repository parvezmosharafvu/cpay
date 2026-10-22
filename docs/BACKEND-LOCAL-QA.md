# Backend local verification — batch 19

Date: 2026-10-22 (Asia/Dhaka). All work is local; no production database, settings or payment was used.

## Passed

31 payment-service unit tests pass with no failures or skips, using the new root command:

```sh
npm --prefix payment-service ci --ignore-scripts
npm run test:payment:unit
```

The command selects auth.test.mjs, money.test.mjs, config.test.mjs, hardening.test.mjs and dockerfile.test.mjs. Coverage includes signed-request tampering/replay, admin-token checks with doubles, integer money conversion and fee splits, configuration validation and source hardening checks. It is a deliberately scoped unit suite, not a replacement for the full payment-service or real-RLS tests. No production behavior or financial formula changed.

## Attempted, not passed

| Attempt | Observation | Meaning |
|---|---|---|
| PostgreSQL installation | Package manager failed because required setgroups/setuid operations are not permitted | No local database server was provisioned |
| Full payment-service npm test | Database-backed tests refused connection to localhost:5432; command exited 1 | Full suite did not pass; this does not establish a production defect |
| Deno 2.2.7 via npm exec | Runtime version command succeeded | Runtime can be invoked through npm, but it is not installed globally on PATH |
| Deno function test selection | Required JSR manifest download failed for @std/assert; no successful test summary | Function tests are blocked by dependency retrieval and cannot be counted as passing |
| Disposable browser RLS stack | PostgreSQL/PostgREST prerequisites absent | Not started or verified |

No database access rules, imports, assertions or network permission boundaries were weakened to bypass these failures.

## Integration prerequisite check

```sh
npm run check:integration
```

This read-only command invokes psql, PostgREST and Deno version checks, returning nonzero if one is missing or unusable. POSTGREST_BIN and DENO_BIN overrides match the existing E2E stack. It does not contact a database or validate credentials. A running disposable PostgreSQL server, installed dependencies and Chromium must also be prepared according to the existing CI setup in .github/workflows/verify.yml and e2e/stack.mjs. This runtime correctly reports missing PATH binaries.

In a provisioned environment, the existing commands remain:

```sh
npm --prefix payment-service test
npx playwright test -c tests/e2e/playwright.config.ts
```

Use only a disposable local database configured for these suites. See [RELEASE-READINESS.md](RELEASE-READINESS.md) for separate production gates. Owner Legal / Contact remains deferred.
