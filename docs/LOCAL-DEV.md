# Running cpay locally, and the CI

Nothing here touches the live Supabase project or a mainnet wallet. Use a
local Postgres, a staging Supabase project, and the regtest network.

## Frontend

Static files in `public/`, no framework. Serve them with the same
fallback Cloudflare uses (an unknown path serves `404.html`, the payment
page):

```bash
npx wrangler dev          # reads wrangler.jsonc: assets = public/, 404-page fallback
```

`public/config.js` holds the Supabase URL and anon key (public by design).
For local work point it at a staging project, never at production, and do
not commit that change. The only build step is the home-page analytics
bundle: `npm install && npm run build`.

## Database

Migrations run in numeric order, `0001` → `0100` (0099 lives on the
email-confirm-toggle branch). For a throwaway local database the way CI
does it (Postgres 15):

```bash
psql -v ON_ERROR_STOP=1 -f ci/bootstrap.sql        # Supabase-shaped roles/schemas; CI only, never on a real project
for f in supabase/migrations/*.sql; do psql -v ON_ERROR_STOP=1 -q -f "$f" || break; done
```

## Payment service (regtest)

```bash
cd payment-service
cp .env.example .env      # BREEZ_NETWORK=regtest, a test mnemonic, DATABASE_URL of the local DB
npm ci
node --env-file=.env server.mjs
```

Regtest has Lightning receive but no cross-chain routes, so the instant
withdraw network list is empty there; the withdraw logic is covered by the
tests with a fake SDK.

## Edge functions

```bash
supabase functions serve --env-file <local env file>   # PAYMENT_SERVICE_URL, PAYMENT_SERVICE_SECRET, CRON_SECRET …
deno check supabase/functions/<name>/index.ts
```

## Environment variables and secrets (names only)

| Where | Name | Used by |
|---|---|---|
| Edge function secrets | `PAYMENT_SERVICE_URL`, `PAYMENT_SERVICE_SECRET` | create-invoice, user-withdraw, admin-actions, health |
| | `CRON_SECRET` | health, daily-report, ledger-backup, reseller-digest (cron callers) |
| | `ALERT_WEBHOOK_URL`, `ALERT_TELEGRAM_BOT_TOKEN`, `ALERT_TELEGRAM_CHAT_ID`, `ALERT_ON_SETTLED` | alerts |
| | `ALLOWED_ORIGINS` (optional) | CORS on user-withdraw, admin-actions (on top of `site_domains`) |
| | `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO` | ledger-backup |
| | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | injected by Supabase |
| Vault | `cpay_cron_secret`, `cpay_functions_url` | pg_cron jobs |
| payment-service `.env` | `BREEZ_NETWORK`, `BREEZ_MNEMONIC`, `BREEZ_API_KEY` (mainnet), `BREEZ_DATA_DIR`, `DATABASE_URL`, `PAYMENT_SERVICE_SECRET`, `PORT`, `CATCH_UP_INTERVAL_SECS` | the service |
| `public/config.js` | Supabase URL, anon key | browser (public) |

Details and rotation: `docs/ENV_VARS.md`, `payment-service/.env.example`.

## CI

`.github/workflows/verify.yml` runs on every push and pull request:

| Job | Checks |
|---|---|
| Migrations | unique migration numbers; `ci/bootstrap.sql` then every migration applies to an empty Postgres 15; `ci/cloudai_regression.sql`; 0096-0098 re-apply and `ci/dashboards_test.sql`; `node --test` in `payment-service/` against that database |
| Edge functions | `deno check` on every `supabase/functions/*/index.ts` |
| Frontend | `npm install`, `npm run build`, `python3 ci/check_frontend.py` (inline JS parses, element ids and handlers exist, every `rpc()` matches its SQL signature, payment-page accessibility, release gates, direct-upload guard, processor name absent from non-admin pages) |
| Hygiene (advisory) | reports tracked ledger snapshots |

The same locally, from the repo root, with a scratch Postgres 15 on
`$PGPORT` and Node 22 and Deno on `PATH`:

```bash
psql -v ON_ERROR_STOP=1 -f ci/bootstrap.sql
for f in supabase/migrations/*.sql; do psql -v ON_ERROR_STOP=1 -q -f "$f" || break; done
psql -v ON_ERROR_STOP=1 -f ci/cloudai_regression.sql
for f in supabase/migrations/009[6-8]_*.sql; do psql -v ON_ERROR_STOP=1 -q -f "$f"; done
psql -v ON_ERROR_STOP=1 -f ci/dashboards_test.sql
(cd payment-service && npm ci && DATABASE_URL=postgres://postgres@localhost:$PGPORT/postgres node --test)
for d in supabase/functions/*/; do deno check "${d}index.ts"; done
npm install && npm run build && python3 ci/check_frontend.py
```

`VERIFY-*.sql` in the repo root are read-only checks meant for the live
database (run them in the SQL editor); they are not part of CI.
