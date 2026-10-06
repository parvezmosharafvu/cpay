# CPAY testing

What to run before merge, and what only an owner can run. Never paste secrets
into logs or tickets. Never move real Lightning / USDT money unless the owner
explicitly approves a staging dry-run. `RECEIPT_RECORDING` stays **off** unless
a separate owner decision turns it to `shadow`.

Timezone for evidence stamps: **Asia/Dhaka (UTC+6)**.

## Automated (run locally or CI)

| Suite | Command | Notes |
|---|---|---|
| Frontend syntax / DOM / RPC / a11y / payout-closed | `python3 ci/check_frontend.py` | Required |
| Public copy hygiene | `python3 ci/check_public_copy.py` | No processor names / traditional payout ads |
| Frontend unit | `node --test tests/frontend/*.mjs` | Desk + design system |
| Analytics bundle | `npm run build` | |
| Public Playwright smoke | Serve `public/` then `npx playwright test -c tests/public-smoke/playwright.config.ts` | Static only |
| payment-service | `DATABASE_URL=postgres://… npm test` in `payment-service/` | Needs Node ≥22 and migrated schema; concurrency 1 |
| Financial invariants | `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f ci/financial_invariants_test.sql` | Settle once, available ≥ 0, `request_withdrawal` closed |
| Role / approval / dashboards / telegram / receipts / sweep | `ci/*_test.sql` on migrated DB | `telegram_test` and `financial_invariants` are isolation-safe on a shared DB |
| Anon + authenticated allowlists | On a DB with `ci/supabase_default_privileges.sql` | `privcheck` in CI |
| Deno edge unit | CI uses Deno 1.x. Local Deno 2.9+: `deno test --no-check --allow-net=127.0.0.1 …` | `auth-settings/`, `admin-actions/`, `telegram-notify/`, `create-invoice/invoice-amount_test.ts` |
| Verify workflow | `.github/workflows/verify.yml` | Migrations, SQL, Deno, payment-service |

`ci/production_drift_test.sql` is **historical**: it runs on a schema stopped
before `20261005020000` (reseller still present). Do not expect it to pass on
today’s full migrated schema.

Abort scripts need a throwaway DB migrated up to, but not including, the
target migration: `ci/commission_removal_abort_test.sh <db>`,
`ci/role_removal_abort_test.sh <db>`.

## Manual / owner-only (not automated here)

1. Delete orphan Edge Functions `reconcile`, `reseller-digest`, `telegram-report`
   per `docs/OPS_OWNER_CUTOVER.md`.
2. Set `ALERT_TELEGRAM_BOT_TOKEN` / `ALERT_TELEGRAM_CHAT_ID` or skip stale
   outbox rows.
3. Apply `20261007040000` on production; redeploy `user-withdraw`.
4. Confirm Azure host `RECEIPT_RECORDING` unset/`off` (read-only).
5. Staging money path: create-invoice → settle → balance → small USDT
   quote/confirm (real sats/USDT; owner approval required).
6. Admin Playwright (`tests/admin.smoke.spec.ts`) against real credentials.
7. Keyboard / screen-reader pass on live invoice and desks.
8. Emergency stop + suspended/pending gates on staging with a real session.
9. Backup / restore drill for Supabase + payment-service data dir.
10. Merge order of stacked PRs once CI is green; do not force-merge red #28.

## What green does **not** mean

- Green unit/SQL tests do not prove production orphans are gone.
- Green payment-service tests use a fake SDK — they do not move mainnet money.
- `GET /ready` and `GET /metrics` coverage does not replace operator review of
  Admin → Health and stuck-`sending` withdrawals.
