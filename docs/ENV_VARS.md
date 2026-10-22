# Environment Variables Checklist

No real secret values belong in this repository. Fill these in on each
platform's dashboard.

## Supabase Edge Function secrets

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are
injected automatically into every function. The rest you add yourself under
Dashboard → Edge Functions → Secrets (they are project-wide, not per-function).

Used by `create-invoice`, `user-withdraw`, `admin-actions` and `health`:

- [ ] `PAYMENT_SERVICE_URL` — base URL of the payment service
      (`payment-service/`), e.g. `https://pay.internal.example`.
- [ ] `PAYMENT_SERVICE_SECRET` — long random string, the same value the
      payment service has. Used as the HMAC key for signed requests, or
      sent as `Authorization: Bearer` while `PAYMENT_SERVICE_AUTH_MODE` is
      `bearer`.
- [ ] `PAYMENT_SERVICE_AUTH_MODE` — `bearer` (default, legacy) or `signed`
      (target). `signed` sends `X-Cpay-Timestamp`/`X-Cpay-Nonce`/
      `X-Cpay-Signature` (HMAC-SHA256 over timestamp, nonce, method, path and
      body) and never the secret. Switch only after the running payment
      service reports `requestAuthMode` in `/metrics`. See
      [`RUNBOOKS.md`](RUNBOOKS.md#service-auth-rollout).

- [ ] `ADMIN_MFA_EXPECTED` — optional. Set to `true` once admin two-step
      sign-in is required (RUNBOOKS "Two-step sign-in"); `health` then alerts
      if `admin_mfa_required` is ever switched off.

- [ ] `STEP_UP_MAX_AGE_SECONDS` — optional, default `600`. A payout confirm
      (`user-withdraw` confirm, admin wallet `send-confirm`/`stable-confirm`)
      needs a real sign-in (the `amr` claim) within this many seconds, and an
      `aal2` session when the account has verified MFA; otherwise it answers
      403 `reauth_required` and the page asks for the password. `0` turns the
      check off (rollback only).

- [ ] `TURNSTILE_SECRET_KEY` + `TURNSTILE_MODE` — optional Cloudflare
      Turnstile on `create-invoice`. Off unless both are set. `monitor`
      verifies and logs but never blocks; `enforce` refuses a missing or
      failed token. Turning it on also needs `window.CPAY_TURNSTILE_SITE_KEY`
      in `public/config.js` and `https://challenges.cloudflare.com` in the
      CSP `script-src` and `frame-src` (`public/_headers`). Start with
      `monitor`.

Public invoice limits (create-invoice, table `public_rate_limits`,
migration 20261007120000; fail closed with 503 if the check errors):
60/min per payer address (hashed; proxied payers keyed by the address the
site Worker forwards), 20/min per payment link, plus the existing 30/min per
link owner. The site Worker adds 20/min per address per Cloudflare location
(`INVOICE_RATE_LIMITER` in `worker/wrangler.jsonc`).

The payment service's own settings are listed below under
[Payment service](#payment-service). The mnemonic never goes into Supabase.

Used by `daily-report`, `ledger-backup`, `health` and `telegram-notify`:

- [ ] `CRON_SECRET` — any long random string. These functions refuse all
      requests if it is unset. The same value is stored in Vault as
      `cpay_cron_secret`, which is where pg_cron reads it.

Used by `telegram-notify` (settled-payment messages to the admin group,
queued by migration 0106 in `telegram_outbox`), and by `health`,
`daily-report` and `ledger-backup` for ops alerts:

- [ ] `ALERT_TELEGRAM_BOT_TOKEN` — the cpay bot's token from @BotFather. Add
      the bot to the admin group. Unset = `telegram-notify` answers 503 and
      leaves every message queued.
- [ ] `ALERT_TELEGRAM_CHAT_ID` *(optional)* — the admin group (a negative
      number such as `-1001234567890`). It gets ops alerts and, unless
      `ALERT_ON_SETTLED=false`, a copy of every settled-payment message.
      Unset = admin copies are skipped.
- [ ] `ALERT_ON_SETTLED` *(optional)* — `false` stops the admin group's copy
      of settled-payment messages.

New in this update:

- [ ] `ALERT_WEBHOOK_URL` — a Discord/Slack/Telegram-bot webhook URL. When the
      health check fails, the ledger backup cannot commit, or the daily report skips a day, the function posts a `🚨`
      message here. Payment failures wake a human up instead of sitting in a
      log file. Unset = alerts are silently skipped.

CORS origins — **no secret needed**. The allowed browser origins for
`admin-actions` and `user-withdraw` are read live from the
`site_domains` table — the same registry the admin panel manages. Add a
domain in the admin panel and it is allowed within ~5 minutes (cache
window); deactivate it and it stops working. No secret edit, no redeploy.

- [ ] `ALLOWED_ORIGINS` *(optional, merged on top of site_domains)* —
      comma-separated list, e.g. `https://cpay.example.com,https://pay.example.com`.
      Only use this for a domain you do NOT want visible in the admin
      panel's domain registry. `create-invoice` keeps its wildcard by
      design — payment links are embedded on creator-owned domains, and it
      is defended by a per-link rate limit instead.

Used by `auth-settings` only (the ops panel's **Settings → Sign-up email
confirmation** switch):

- [ ] `CPAY_SUPABASE_ACCESS_TOKEN` — a Supabase **personal access token**
      (Account → Access Tokens), i.e. what the CLI calls
      `SUPABASE_ACCESS_TOKEN`. The function uses it for exactly one thing:
      reading and setting `mailer_autoconfirm` through the Management API
      (`GET`/`PATCH /v1/projects/{ref}/config/auth`).
      **This is a powerful, account-level token.** It is not scoped to this
      project: it can change settings of, or delete, every project and
      organization its owner can reach. It must only ever exist as this
      edge-function secret — never in `public/config.js`, a `.env` that is
      committed, the payment service, a chat or a ticket. Create it from an
      account that is Owner/Admin of this project's organization (ideally a
      dedicated one), give it an expiry, and revoke it in the Supabase
      dashboard if it is ever exposed.
      Why the `CPAY_` prefix: hosted Supabase refuses secret names that start
      with `SUPABASE_` (that prefix is reserved). The function also reads
      `SUPABASE_ACCESS_TOKEN` if present, which only matters for local
      `supabase functions serve`.
      Unset = the switch shows "Not set up" and the setting stays wherever the
      Supabase dashboard has it (Authentication → Sign In / Providers → Email →
      Confirm email).
- [ ] `CPAY_PROJECT_REF` *(optional)* — only needed if `SUPABASE_URL` is not
      `https://<ref>.supabase.co`; the ref is worked out from it otherwise.

Used by `ledger-backup` only:

- [ ] `GITHUB_TOKEN` — a fine-grained token with Contents: write on **one**
      private repository, nothing else
- [ ] `GITHUB_OWNER`
- [ ] `GITHUB_REPO` — must be private. This function commits a full ledger
      snapshot into it.

Used by `direct-invoice` and `settlement-destination` (direct settlement,
20261018010000; off until the owner turns it on):

- [ ] `DIRECT_RECONCILE_SECRET` *(optional)* — a new long random string,
      **not** `CRON_SECRET`. Only the reconcile sweep (`{"action":"reconcile"}`
      with header `x-direct-reconcile-secret`) needs it; unset = the sweep
      refuses and open payments are checked while their payment page is open.
- [ ] `DIRECT_SETTLEMENT_NETWORK` *(optional)* — `bitcoin` (default),
      `testnet`, `signet` or `regtest`: the network merchant invoices must be
      for. Leave unset in production.
- [ ] `DIRECT_PROVIDER_HOSTS` *(optional)* — comma-separated host names
      (exact, no wildcards), e.g. the address domain and callback host of each
      provider the owner accepts. Set = CPAY only talks to these hosts for
      direct settlement; unset = any public host that passes the DNS check.
      CPAY Wallet addresses (`name@ln.pay-cashapp.buzz`) need
      `ln.pay-cashapp.buzz` in the list.
- `E2E_LNURL_GATEWAY`, `E2E_FIXED_BTC_USD` — the local test stack only. Both
  functions ignore them unless `SUPABASE_URL` is a loopback address; never set
  them on the hosted project.
- `TURNSTILE_SECRET_KEY`, `TURNSTILE_MODE`, `STEP_UP_MAX_AGE_SECONDS`,
  `ALLOWED_ORIGINS` — the same values as `create-invoice` / `user-withdraw`.
  `direct-invoice` makes **no new invoice** unless `TURNSTILE_MODE=enforce`
  (with its secret); status checks of existing payments still work.

### BTCPay Server checkout (`create-invoice`, `btcpay-webhook`; [BTCPAY.md](BTCPAY.md))

Only used while Admin → Settings → BTCPay Server (`btcpay_enabled`) is on.

- [ ] `BTCPAY_URL` — `https://` address of the BTCPay Server, no path.
- [ ] `BTCPAY_STORE_ID` — the `cpay` store id.
- [ ] `BTCPAY_API_KEY` — Greenfield key with only *Create an invoice* and
      *View invoices* on the `cpay` store. Never payout or wallet permissions.
- [ ] `BTCPAY_WEBHOOK_SECRET` — the store webhook secret. `BTCPAY_WEBHOOK_SECRET_2`
      … `_5` are also accepted while rotating.
- `SITE_URL` *(optional)* — return link shown on the BTCPay checkout page.

## Payment service

Set on the host that runs `payment-service/` (see
[`payment-service-deploy.md`](payment-service-deploy.md)). `config.mjs` reads
these and nothing else; it refuses to start and names every bad variable
(never its value) if one is wrong. `.env.example` has the same list.

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `BREEZ_NETWORK` | yes | | `mainnet` or `regtest` |
| `BREEZ_MNEMONIC_FILE` | one of these two | | Path to a file holding the platform wallet's 12 or 24 words. Preferred: mount it read-only, mode 600, owned by the service user |
| `BREEZ_MNEMONIC` | one of these two | | The words inline. Setting both is an error |
| `BREEZ_API_KEY` | mainnet only | | Wallet SDK API key. Regtest needs none |
| `BREEZ_DATA_DIR` | yes | `/data` in the Docker image | Wallet cache. Must be on a persistent disk |
| `DATABASE_URL` | yes | | Postgres URL of the Supabase database, a role that can run the settle and withdrawal functions |
| `PAYMENT_SERVICE_SECRET` | yes | | At least 32 characters. Same value as the edge function secret of that name |
| `PORT` | no | `8080` | HTTP port |
| `CATCH_UP_INTERVAL_SECS` | no | `300` | How often the service re-reads recent wallet payments in case an event was missed (30 to 3600) |
| `SHUTDOWN_TIMEOUT_SECS` | no | `90` | On SIGTERM or SIGINT, how long to wait for sends in flight before disconnecting anyway (1 to 600). Give the host's stop timeout at least this plus 10 seconds |
| `REQUEST_AUTH_MODE` | no | `any` | `any` accepts the legacy bearer or a signed request; `signed` accepts signed requests only (5-minute window, single-use nonce). A set but unknown value is a startup error |
| `ADMIN_JWT_MODE` | no | `optional` | Platform wallet routes (`/admin/wallet/*`). `optional` verifies a forwarded admin session (`X-Cpay-Admin-Token`) when present and otherwise trusts the body `adminId` (legacy); `required` refuses any wallet call without a valid session of an active admin. Needs `SUPABASE_URL` and `SUPABASE_ANON_KEY` |
| `SUPABASE_URL` | with `ADMIN_JWT_MODE=required` | | `https://<ref>.supabase.co`, used to ask Supabase Auth whose session a forwarded token is |
| `SUPABASE_ANON_KEY` | with `SUPABASE_URL` | | The public anon/publishable key (not a secret) |
| `RECEIPT_RECORDING` | no | `off` | `shadow` writes every completed receive to `lightning_receipts` (record-only, migration 20261003050000) on a separate 2-connection pool before the unchanged settlement runs. Anything else, including unset or a typo, means `off`. Recording can never stop or change settlement |

The service never logs these values: every log line passes through a redactor
that replaces the secret, the API key, the words, and the database URL and
password.

## public/config.js (client-side, public by design)

- [ ] `SUPABASE_URL`
- [ ] anon key (the `SUPABASE_ANON_KEY` constant inside the file)

Copy `public/config.example.js` to `public/config.js` and fill these in. Both
values are meant to be visible in the browser, so this file is committed —
there is nothing to hide. Everything that actually protects data is an RLS
policy or a `SECURITY DEFINER` function in `supabase/migrations/`.

## Cloudflare Worker

`worker/og-preview-worker.js` has `SUPABASE_URL` and the anon key inline near
the top. Same reasoning as above: safe to keep there, or move to Worker
environment variables under Settings → Variables if you prefer.

## Third-party AI credentials

Never add an API key, cloud access token or AI endpoint to `public/config.js`
or any file under `public/`. Nothing in CPAY calls an AI service.

## Rotation

If any of these has ever been committed, pushed or pasted into a shared
channel, rotate it. In particular, the `CRON_SECRET` that used to be inline in
`supabase/functions/ledger-backup/ledger-backup-trigger.sql` is in this repo's
Git history and must be considered public.

**How to rotate CRON_SECRET (5 minutes):**

1. Generate a new one: `openssl rand -hex 32`
2. Dashboard → Edge Functions → Secrets → update `CRON_SECRET`
3. SQL editor → `select vault.create_secret('<the-same-new-value>', 'cpay_cron_secret');`
   (create it under the same name — `vault.create_secret` upserts by name,
   so both cron triggers keep working with no SQL changes)
4. Confirm the next nightly run in the ledger-backup function logs.


## Scheduled-function credential isolation (source staged 2026-10-22)

This review branch supports optional scoped credentials for `daily-report`
(`DAILY_REPORT_CRON_SECRET`), `ledger-backup` (`LEDGER_BACKUP_CRON_SECRET`),
`health` (`HEALTH_CRON_SECRET`), `telegram-notify`
(`TELEGRAM_NOTIFY_CRON_SECRET`), and the standalone wallet sync endpoint
(`BREEZ_WALLET_CRON_SECRET`). Each uses `CRON_SECRET` only when its dedicated
variable is absent. Once a dedicated variable exists, even when empty, its
endpoint rejects the old shared credential; a bad blank configuration fails
closed. This is source support, **not** an applied production rotation.
Schedulers and the corresponding Vault secrets must be switched together,
with live checks, under the owner's approved change window. Never give a
cron secret to a third-party monitor. See
[CRON-SECRET-CUTOVER.md](CRON-SECRET-CUTOVER.md).


## Signed Worker client-IP attribution — staged (not enabled in production)

The site Worker can sign its `x-cpay-client-ip` header with a fresh
timestamp and HMAC-SHA256 using `INVOICE_IP_SIGNING_SECRET`. Set the
**same high-entropy secret** privately in the Cloudflare Worker and the
Supabase Edge project only during a separately approved rollout; do not
put it in a public client or repository. The Worker adds
`x-cpay-ip-timestamp` and `x-cpay-ip-signature` to proxied
create-invoice requests. Once the Edge value exists, missing, forged or
expired attribution is refused for **per-IP identification** and
requests fall into the shared Worker egress rate-limit bucket.
The function's other per-link/owner rate limits still apply.

When the Edge secret is absent, existing unsigned forwarding remains
temporarily accepted for backward compatibility. **That fallback is not
proof of production protection.** Deploy the matching Worker first,
then enable the matching Edge secret in a coordinated window, check
that real payer invoices still rate-limit by client and forged requests
do not impersonate payers, then rotate per policy. Do not confuse
signed IP metadata with authentication or a completed Turnstile
enforcement rollout.
