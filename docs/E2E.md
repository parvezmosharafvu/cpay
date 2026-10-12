# End-to-end tests

`tests/e2e/` holds eight Playwright suites that run against a disposable local
stack started by [`e2e/stack.mjs`](../e2e/stack.mjs):

| Part | What runs |
|---|---|
| Database | a fresh local Postgres database: CI bootstrap, Supabase default grants, every migration, then [`e2e/shim.sql`](../e2e/shim.sql) (auth helpers that read the JWT) |
| REST | PostgREST 12 with real row-level security |
| Auth | a small local stand-in for password sign-up, sign-in, refresh, user and recovery mail |
| Functions | the real `create-invoice` and `user-withdraw` Edge Functions under Deno |
| Payments | the real payment service with a fake wallet SDK; incoming payments are simulated through `/__e2e/pay` |
| Site | the built `dist/` bundle with a local `config.js` |

Nothing touches production. Tokens are signed with a local test secret.

Run locally (needs Postgres on localhost, `postgrest` and `deno` on PATH):

```sh
npm ci && (cd payment-service && npm ci)
npm run build && npm run prepare:upload
PGPASSWORD=postgres npx playwright test -c tests/e2e/playwright.config.ts
```

| Suite | Covers |
|---|---|
| `auth.spec.ts` | registration (pending), short password, login/logout, wrong password, pending account, password recovery |
| `slug-routing.spec.ts` | active link, trailing slash, unknown/reserved paths, disabled link, suspended Freelancer, lookup outage retry |
| `public-payment.spec.ts` | typed and prefilled amounts, range checks, double-click, link cost, operator pause |
| `invoice-lifecycle.spec.ts` | waiting → paid (credited once), refresh/second-device resume, underpayment, expiry and regenerate, unknown invoice |
| `creator-dashboard.spec.ts` | balance, payments list, create/turn off links, credit after payment, refresh on every tab |
| `withdrawal.spec.ts` | fee-transparent quote, masked destination, countdown, single send on double-click, cooldown, limits, quote expiry |
| `authorization.spec.ts` | anonymous, own vs other Freelancer, self-promotion, admin desk, retired roles, suspended account |
| `responsive-accessibility.spec.ts` | 320 px layouts, keyboard payment, dialog focus, reduced motion, accessible names |
