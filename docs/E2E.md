# End-to-end tests

`tests/e2e/` holds the Playwright suites that run against a disposable local
stack started by [`e2e/stack.mjs`](../e2e/stack.mjs):

| Part | What runs |
|---|---|
| Database | a fresh local Postgres database: CI bootstrap, Supabase default grants, every migration, then [`e2e/shim.sql`](../e2e/shim.sql) (auth helpers that read the JWT) |
| REST | PostgREST 12 with real row-level security |
| Auth | a small local stand-in for password sign-up, sign-in, refresh, user and recovery mail |
| Functions | the real `create-invoice` and `user-withdraw` Edge Functions under Deno, and `direct-invoice` + `settlement-destination` in one Deno process ([`e2e/fn-multi.ts`](../e2e/fn-multi.ts)) |
| Merchant provider | a fake Lightning-address server ([`e2e/fake-lnurl.mjs`](../e2e/fake-lnurl.mjs)): LUD-16/06 invoices (regtest) and LUD-21 confirmation, for direct settlement. The functions reach it only because `SUPABASE_URL` is loopback |
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
| `direct-settlement.spec.ts` | switch off by default; Lightning address checked, saved after a fresh sign-in, 24 h wait; payer pays the merchant's wallet, proof marks it paid, CPAY balance unchanged; forged proof refused; custodial endpoint refuses a direct link; no address → "not taking payments"; isolation |
| `authorization.spec.ts` | anonymous, own vs other Freelancer, self-promotion, admin desk, retired roles, suspended account |
| `responsive-accessibility.spec.ts` | 320 px layouts, keyboard payment, dialog focus, reduced motion, accessible names |
