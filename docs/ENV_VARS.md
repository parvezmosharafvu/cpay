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
      payment service has. Sent as `Authorization: Bearer`.

The payment service's own settings (wallet mnemonic, database URL) are in
`payment-service/.env.example`. The mnemonic never goes into Supabase.

Used by `daily-report` and `ledger-backup`:

- [ ] `CRON_SECRET` — any long random string. Both functions refuse all
      requests if it is unset.

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

## Microsoft Foundry (local development only)

Foundry credentials must stay server-side. Do not add an API key, Azure access
token, or Foundry endpoint to `public/config.js`. See
[`FOUNDRY-LOCAL.md`](FOUNDRY-LOCAL.md) for the `azd` login flow and the
server-side environment variables used by a local proxy.

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
