# CPAY

Lightning Network payment links for freelancers and online shop owners.
Generate a payment link, share it, get paid. Withdraw instantly as USDT or
USDC on any network Breez routes to, or to bKash, Nagad, Binance Pay or a
bank through an admin-reviewed payout.

## Stack

- **Frontend:** Vanilla HTML/CSS/JS + Supabase JS v2 (no build step)
- **Backend:** Supabase — Postgres, Row Level Security, Edge Functions
- **Payments:** Breez SDK Spark, through `payment-service/` (a small
  Node 22 process holding the cpay wallet). Lightning receive works on the
  Breez regtest network. Instant USDT/USDC withdrawals go through Breez
  cross-chain sends, which exist on mainnet only; bKash, Nagad, Binance Pay
  and bank withdrawals are paid by hand
- **Edge routing:** Cloudflare Worker — renders correct link-preview
  metadata for WhatsApp/Telegram/Facebook when a payment link is shared

For a direct frontend upload, see `docs/DIRECT-UPLOAD.md` and run
`npm run prepare:upload`; it creates a clean `dist/` bundle for the new CPAY
Cloudflare project.

## Repo layout

```
public/                          → static site root
  index.html                     → landing page + logged-in redirect
  login.html / register.html     → auth pages
  404.html                       → not-found page AND the payment page:
                                   any unmatched path is treated as a slug
  dashboard.html                 → creator dashboard
  invoice-cpay-v2.html     → preserved legacy customer-facing payment/QR page
  admin.html                     → admin panel (approvals, stats, settings)
  moderator.html                 → limited staff panel, scoped to assigned creators
  theme.js                       → the ten checkout designs; maps every saved
                                   link, invoice and store theme onto one of them
  theme-preview.html             → preview of all ten designs with sample data
  cpay.css                       → the one stylesheet: design tokens and components
  config.example.js              → copy to config.js, fill in your keys

supabase/
  migrations/                    → run in numeric order, 0001 → 0094
  functions/
    create-invoice/              → validates and prices a payment, has the payment service invoice it
    admin-actions/               → admin mark-settled + withdrawal actions
    auth-settings/               → admin switch for sign-up email confirmation
                                   (Supabase Management API, mailer_autoconfirm)
    user-withdraw/               → creator-initiated withdrawal
    daily-report/                → nightly rollup into daily_stats
    ledger-backup/               → nightly ledger snapshot to a private repo
    og-image/                    → generated link-preview images
    health/                      → system health checks + alerting

payment-service/                 → Node 22 process holding the cpay Breez wallet:
                                   invoices, payment events, catch-up, /health

ci/
  bootstrap.sql                  → Supabase-shaped scaffolding for CI only.
                                   NEVER run this against your real database.
  check_frontend.py              → static checks on the public pages

worker/
  og-preview-worker.js           → Cloudflare Worker for OG tags
  wrangler.jsonc

docs/
  DEPLOYMENT.md                  → full setup checklist
  CPAY-OWNER-GUIDE.md            → new-project owner and staging guide
  ENV_VARS.md                    → what secrets go where
```

## Setup

For the new CPAY project, read `docs/CPAY-OWNER-GUIDE.md` first, then follow
`docs/DEPLOYMENT.md` and `docs/DIRECT-UPLOAD.md`. Never run CPAY migrations
against the previous production project.

## How the money model works

There is exactly one definition of a creator's withdrawable balance, and it
lives in SQL:

```
available = sum(settled payments) − sum(withdrawals that are not rejected or failed)
```

`get_balance_for()` computes it. `get_my_balance()` is the creator-facing
wrapper the dashboard calls. `request_withdrawal()`,
`system_queue_withdrawal()` and `reserve_stablecoin_withdrawal()` all check
against it while holding a lock on the creator's profile row, which
serialises concurrent requests.

Nothing else may write to `withdrawals` — there is no client INSERT policy on
that table, so a browser cannot mint a request that skips the balance check.
Status transitions to `paid`/`processing`/`rejected` go through
`system_claim_withdrawal()`, which is atomic and only fires once. An instant
stablecoin withdrawal is inserted as `sending` and leaves it only through
`finalize_stablecoin_withdrawal()` (to `paid`, or `failed`, which is the
refund), which likewise only fires once.

If you change any of this, change it in one place. Two functions with two
slightly different balance formulas is how the same money gets paid out twice.

## Security notes worth knowing before you deploy

- Migration **0018** is not optional. Before it, any signed-in creator could
  run `update profiles set role = 'admin'` on their own row, insert
  withdrawals directly, and read every payment in the system.
- Migration **0033** is not optional either. It adds the `webhook_events`
  table that makes payment webhook deliveries idempotent (without it,
  concurrent retries of the same event can be processed twice) and CHECK
  constraints that make negative or zero amounts unwritable no matter which
  code path tries.
- The `/process-withdrawal` and `/admin-mark-settled` routes use the service
  role key internally, which bypasses RLS entirely — so the admin check has to
  live in code, not the database. It does, in `verifyAdminCaller()`.
- Creator display names and withdrawal destinations are free text that lands in
  the admin panel. Escape anything you add to that page.
- `payments.method` is constrained to `'lightning'` only at the database
  level — USDC support was intentionally removed.
- Run the regression queries in `docs/DEPLOYMENT.md` §6 after any migration.
- Security headers (CSP, `frame-ancestors 'none'` for clickjacking, nosniff,
  etc.) live in `public/_headers` and are applied automatically by the
  Cloudflare static-assets deploy. Admin-facing edge functions restrict
  browser origins against the `site_domains` registry — the same list the
  admin panel manages, so adding a domain there enables CORS within ~5
  minutes, no secret or redeploy needed. Payment failures push a `🚨` alert
  to the `ALERT_WEBHOOK_URL` secret (Discord / Slack / Telegram-bot
  webhook). See `docs/ENV_VARS.md`.

See `SECURITY.md` for the full trust-boundary write-up.


## Scheduled jobs

All five run through `pg_cron` + `pg_net`, reading their secrets from Vault.

| Job | When (UTC) | What it does |
|---|---|---|
| `cpay-health` | every 15 min | Payment service reachable and synced, cron alive, withdrawals not stuck. Alerts on failure. |
| `prune-webhook-events` | 03:20 | 90-day retention on `webhook_events` |
| `ledger-backup-trigger` | 11:05 | Full ledger snapshot committed to the ledger repo |
| `daily-report-trigger` | 18:10 | Writes the `daily_stats` archive |

Check what is scheduled:

```sql
select jobname, schedule, active from cron.job order by jobname;
```

## What "a day" means here

Every daily figure in this system runs **5:00 PM to 5:00 PM Asia/Dhaka**,
not midnight to midnight, and a cycle is named after the date it *started*.

`business_day(ts)` (migration 0096) is the one definition: day D runs from
`business_day_start(D)` (D 17:00 Dhaka) to `business_day_end(D)`.
`admin_daily_settled()`, `staff_daily_settled()`, `my_daily_settled()`,
`daily_totals_for_cycle()`, `reseller_cycle_digest()` and the dashboard RPCs
below all call it. The `daily-report` cron computes the same date in TypeScript
and then asks `daily_totals_for_cycle()` for the numbers.

Dashboard RPCs (0096), one row per person or link per business day:

| RPC | Who | Rows |
|---|---|---|
| `my_daily_summary(p_days)` | anyone signed in | own book per day |
| `reseller_team_daily_summary(p_days)` | reseller | self + team per day, with email |
| `admin_daily_summary(p_days, p_user_id, p_reseller_id)` | admin | per person per day, with profile, email, reseller |
| `admin_daily_timeseries(p_days, p_user_id, p_reseller_id)` | admin | platform (or filtered) totals per day, for the graph |
| `daily_link_breakdown(p_days, p_user_id)` | self, their reseller, admin | per link per day with cost rate charged |

`earnings` is `settled - platform_fee - reseller_commission`, the same formula
as the balance. The cost rate charged is stored on each payment
(`payments.cost_percent`) from 0096 on; older payments show the link's current
rate.

0098 adds `my_dashboard_profile()` (profile card: email, role, reseller,
links used of the limit) and `admin_link_usage()` (links used and limit per
account for the admin Accounts tab). A name with several variant spellings
counts as one link, and no account can go above 10.

The daily withdrawal cap resets at the same 17:00 Dhaka edge as everything
else since 0097 (`request_withdrawal`, `system_queue_withdrawal`,
`reserve_stablecoin_withdrawal`).

0099 grants `service_role` INSERT on `audit_log` (and its id sequence), so
the `auth-settings` function can record sign-up email confirmation changes.

`public/daily-desk.js` renders these RPCs on the freelancer Overview, the
reseller Overview and Team accounts, and the admin Daily earnings tab.

## Alerting

Set either or both, in Supabase → Edge Functions → Secrets:

```
ALERT_WEBHOOK_URL            Discord or Slack incoming webhook
ALERT_TELEGRAM_BOT_TOKEN     Telegram bot token
ALERT_TELEGRAM_CHAT_ID       Telegram chat to post into
```

`health` uses these. With neither set they log a
warning and carry on — nothing breaks, but nobody is told.

## Checking things by hand

```bash
# Is everything alive? (?alert=0 keeps it out of the alert channel)
curl -H "x-cron-secret: $CRON_SECRET" \
  "$SUPABASE_URL/functions/v1/health?alert=0"

# Force a ledger snapshot and verify it is complete
curl -H "x-cron-secret: $CRON_SECRET" \
  "$SUPABASE_URL/functions/v1/ledger-backup"

# Rebuild the daily archive
curl -H "x-cron-secret: $CRON_SECRET" \
  "$SUPABASE_URL/functions/v1/daily-report?days=30"
```

`VERIFY-daily-stats.sql` in the repo root compares the archive against the
live ledger and flags any row that has drifted.

## Continuous integration

`.github/workflows/verify.yml` runs on every push:

| Job | Blocking | Checks |
|---|---|---|
| Migrations | no | Every migration applies in order to an empty Postgres; migration numbers are unique |
| Edge functions | yes | `deno check` on every function — a real type-check, unlike a bundler — and `auth-settings` tested against a local mock Management API |
| Pages | yes | Inline JS parses; every element id and on-handler exists; every `rpc()` call matches its SQL definition |
| Ledger snapshots | no | Reports whether ledger snapshots are tracked in this repo |

The two non-blocking jobs report without failing the build: one is
environment-sensitive, the other reflects a deliberate choice while this
repository stays private.

## Auditing

`audit_log` records who changed a fee, a role, a moderator assignment, a
creator's instant-payout access, or sign-up email confirmation
(`settings.signup_email_confirmation`, written by `auth-settings`) — with
the old value alongside the new one. It is append-only: there is no update or delete policy for anyone,
including admins.

```sql
select occurred_at, actor_email, action, old_value, new_value
from audit_log order by occurred_at desc limit 50;
```


## Before a migration reaches production

`docs/STAGING.md` covers setting up a second Supabase project to apply
migrations against first. CI proves a migration applies to an *empty*
database; staging is where you find out what it does to one with rows in
it.

## What is deliberately not built

Some things were considered and left out, with reasons, so they are not
rediscovered as oversights:

**Payments archival and a materialised view for the daily rollups.**
At a few thousand payments these solve nothing. Postgres orders and
aggregates this volume without effort, especially with the indexes added
in 0044, and both would add a moving part that can fall out of sync with
the table it summarises. Worth revisiting if the payment count reaches
the low millions or the Earnings tab starts feeling slow — not before.

**Client-side login rate limiting.** It would be theatre. Anything
enforced in the browser is bypassed by calling the API directly.
Supabase enforces auth rate limits server-side; configure them under
Authentication → Rate Limits rather than writing code that only stops
someone using the form.

**Hard deletion of support messages.** Removed on purpose in 0049. A
support thread is often the only record of what was agreed about
someone's money, so each side can hide a message from their own view and
neither can remove it from the other's.
