# CPAY: configuration names and keys

No value appears here or anywhere in the repository. Supabase does not
expose secret values or even a secret list through the tools used for
this check, so each row says what was **verified from behaviour** in
production on 2026-10-14, or "not verified". Full per-name notes:
[ENV_VARS.md](ENV_VARS.md).

## Wallet engine (the wallet Edge Function)

The function refuses to start and names the missing variable if a required
one is absent (`configError()` in the wallet function's `index.ts`).

| Name | Purpose | Where | Verified |
|---|---|---|---|
| `BREEZ_MNEMONIC` | The platform wallet's 12/24 words. The only copy outside the owner's offline backup | Edge secret, wallet function only | **Set**: the function runs and holds leases |
| `BREEZ_NETWORK` | `mainnet` or `regtest` | Edge secret | **mainnet**: production invoices start `lnbc` (not `lnbcrt`) |
| `BREEZ_API_KEY` | Wallet SDK vendor key for the website's server wallet | Edge secret | **Set**: required on mainnet, and the function runs on mainnet |
| `BREEZ_DB_URL` | Postgres URL for the SDK's own `breez_wallet` schema | Edge secret | **Set**: lease rows are written every minute |
| `PAYMENT_SERVICE_SECRET` | Shared HMAC secret between the website functions and the wallet engine (≥ 32 chars) | Edge secret, on both sides | **Set and matching**: invoices were created and settled through it on 2026-10-12/13 |
| `CRON_SECRET` | Authenticates pg_cron calls (sync, health, reports, backup, Telegram) | Edge secret + Vault `cpay_cron_secret` | **Set and matching**: cron calls are authorised (health 200 at 20:30 UTC) |
| `ADMIN_JWT_MODE` | `required` (default): admin wallet routes need a real admin session | Edge secret, optional | Default applies unless set; not verified |

## Website functions

| Name | Used by | Verified |
|---|---|---|
| `PAYMENT_SERVICE_URL` | create-invoice, user-withdraw, admin-actions, health. Points at the wallet engine | **Set**: invoices reached the wallet engine |
| `PAYMENT_SERVICE_AUTH_MODE` | `bearer` (default) or `signed` | Not verified |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Every function. Provided by Supabase itself | **Set**: built in |
| `ALLOWED_ORIGINS` | CORS allowlist (also read from `site_domains`) | Not verified |
| `STEP_UP_MAX_AGE_SECONDS` | Recent sign-in window for payouts (default 600) | Default applies unless set |
| `TURNSTILE_SECRET_KEY`, `TURNSTILE_MODE` | Bot check on invoice creation | **Off**: `public/config.js` sets no site key, so the browser sends no token; enforcing now would block every payment |
| `ALERT_TELEGRAM_BOT_TOKEN`, `ALERT_TELEGRAM_CHAT_ID` | Alerts and settled-payment messages | **Set**: health reports `telegram: sent` |
| `ALERT_WEBHOOK_URL` | Second alert channel | **Not set**: health reports `webhook: not configured` |
| `ALERT_ON_SETTLED` | `false` stops settled-payment copies | Not verified |
| `ADMIN_MFA_EXPECTED` | Health warns until admin MFA is on | Not set (MFA rollout pending) |
| `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO` | Nightly ledger backup to a private repo | **Set**: the 18:15 UTC run committed and verified. The target repo is not visible to this audit, so its privacy is **not verified** |
| `CPAY_SUPABASE_ACCESS_TOKEN` / `SUPABASE_ACCESS_TOKEN`, `CPAY_PROJECT_REF` | auth-settings (email-confirmation toggle via the Management API) | Not verified |

## Standalone CPAY Wallet (build-time, not deployed)

| Name | Purpose | Verified |
|---|---|---|
| `WALLET_API_KEY` | A key issued **for the phone wallet** by the SDK vendor. Ships inside the app; it identifies the app and does not protect funds. **Never** the website's `BREEZ_API_KEY` | **Does not exist yet** (owner requests it) |
| `WALLET_NETWORK` | `mainnet` (default) or `regtest`. A mainnet build without `WALLET_API_KEY` is inert ("Not available yet") | Build rule tested in CI |
| `WALLET_LINK` | `off` builds without the optional CPAY account link | Build rule tested in CI |
| `WALLET_SYNC` | `on` re-enables the vendor's real-time sync (off by default) | Build rule tested in CI |
| `WALLET_TEST` / `WALLET_ENGINE` | Test builds only. The build refuses the fake engine without `WALLET_TEST=1` | Tested in CI |
| `CPAY_SUPABASE_URL`, `CPAY_SUPABASE_ANON_KEY` | Public values for the optional account link. The build refuses a service-role key | Tested in CI |

## Public by design

`public/config.js` holds the Supabase URL and anon key (RLS applies). They
are not secrets.
