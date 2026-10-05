# Security Policy

## Reporting a vulnerability

Email the maintainer directly rather than opening a public issue. Include
enough detail to reproduce (endpoint, payload, expected vs. actual). Expect an
acknowledgement within a few days.

Please do not test against the production instance with real payments. Use a
staging project and test funds only.

## What is and is not a secret in this repo

Safe to commit — these are public by design:

- `public/config.js` — the Supabase project URL and **anon** key. The anon key
  identifies the project; it grants nothing on its own. Every real permission
  boundary is a Row Level Security policy or a `SECURITY DEFINER` function in
  `supabase/migrations/`.
- The same two values inlined at the top of `worker/og-preview-worker.js`.

Never commit:

- `SUPABASE_SERVICE_ROLE_KEY` — bypasses RLS completely.
- Payment provider API keys, wallet seeds and webhook secrets.
- `CRON_SECRET`, `GITHUB_TOKEN`.
- `CPAY_SUPABASE_ACCESS_TOKEN` — a Supabase personal access token. It is
  account-level, not project-level: whoever holds it can change or delete
  every project its owner can reach. It exists only so the `auth-settings`
  function can flip one Auth setting (`mailer_autoconfirm`), and it must only
  ever live as an edge-function secret.

All of the above belong in Supabase Edge Function secrets. See `docs/ENV_VARS.md`.

## Trust boundaries worth knowing before you deploy

- **The browser is not a boundary.** Anything the dashboard or admin panel can
  do, a user can do by hand against PostgREST with the anon key. Every rule
  that matters is enforced in SQL: `request_withdrawal()` owns the balance
  check, `guard_profile_updates()` owns which profile columns a creator may
  change, `enforce_link_limit()` and `validate_link_slug()` own link creation.
- **The service role bypasses RLS entirely.** The `/process-withdrawal` and
  `/admin-mark-settled` routes therefore verify the caller's admin role in
  code, via `verifyAdminCaller()`, before doing anything.
- **`auth-settings` holds a Supabase account token.** It runs the same admin
  check before touching the Management API, sends the token only to the
  fixed `https://api.supabase.com`, and returns a single boolean — never the
  auth config, which contains SMTP and OAuth secrets. Every change writes an
  `audit_log` row (`settings.signup_email_confirmation`).
- **Withdrawal state transitions are claimed atomically.** Moving a withdrawal
  to `paid`, `processing` or `rejected` goes through
  `system_claim_withdrawal()`, which only succeeds from `pending`/`approved`.
  This is what stops a double-click from sending two real Lightning payouts.
- **Instant stablecoin withdrawals send before anyone looks at them.** The
  payment service reserves the balance with `reserve_stablecoin_withdrawal()`
  (same checks as `request_withdrawal()`, plus the quoted fee must still be
  the profile's fee), then calls the wallet SDK's `sendPayment` with the withdrawal id as
  the idempotency key, so a repeated confirm or a restart cannot pay twice.
  `finalize_stablecoin_withdrawal()` only moves `sending` rows, so a refund
  happens once. Both functions are service-role only. The controls that
  remain are the emergency stop, `can_request_withdrawals`, account status
  and the per-profile single and daily limits; set those before mainnet.
  A destination address on the wrong network cannot be recovered.
- **`payments` is readable by anon only inside the payment window** so the
  public invoice page can receive Realtime updates. Rows older than two hours
  are invisible, and the column grant hides `user_id` and internal ids.
- **Creator-supplied text reaches the admin panel.** Display names and
  withdrawal destinations are attacker-controlled; the admin panel escapes
  every one of them before rendering. If you add a new field to that panel,
  escape it.
- **Payment events must stay idempotent.** `payments.invoice_ref` is
  UNIQUE and every received wallet payment goes through
  `settle_breez_payment()` (0094), which logs it to
  `webhook_events.delivery_id` first and settles only a row that is not
  settled yet. Replays and the payment service's catch-up credit nothing
  twice.
  Amounts additionally cannot be negative (or zero when requested) at the
  database level — CHECK constraints, not just application code.
- **Browser origins are restricted on the money endpoints.** `user-withdraw`
  and the admin routes on `admin-actions` only emit CORS headers for
  domains registered (and active) in `site_domains` — the admin panel's own
  domain registry, cached for 5 minutes in the function. An optional
  `ALLOWED_ORIGINS` secret can add hosts that should stay out of that
  registry. `create-invoice` keeps a wildcard on purpose (payment links
  live on creators' own domains) and is defended by its per-link rate
  limit instead. `public/_headers` adds CSP and `frame-ancestors 'none'`
  (anti-clickjacking) to every page.
- **Users never see the payment processor.** `user-withdraw` returns an
  allowlisted copy of each payment-service answer (no processor names,
  payment ids, sats, rates or admin notes) and replaces raw SDK error text
  with a generic message; `ci/check_frontend.py` fails if the processor's
  name appears in any non-admin page. See `docs/ARCHITECTURE.md`.

## After cloning or forking

Rotate every secret. The repository history contains a `CRON_SECRET` that was
committed in `ledger-backup-trigger.sql`, and the `ledger-backups/*.json`
snapshots contain real customer email addresses from the original deployment.
Treat both as public.

**Update (Aug 2026):** the `ledger-backups/` snapshots have been removed from
the working tree and the path is now in `.gitignore`. The nightly backup still
runs — it commits straight to the private GitHub repo configured via
`GITHUB_OWNER`/`GITHUB_REPO`, never into this one. If your fork's Git history
still contains either the snapshots or the old CRON_SECRET, purge the history
(`git filter-repo`) and rotate the secret per `docs/ENV_VARS.md` — deleting
the files from the latest commit does NOT remove them from history.
