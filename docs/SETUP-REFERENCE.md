# CPAY — full setup reference

Everything CPAY needs configured outside its own code: the payment
provider, Supabase (secrets, Vault, cron), and Cloudflare (domains,
Pages, Worker).

Written to be followed top to bottom on a fresh deployment, and to be
searched when something specific breaks later.

---

## Table of contents

1. [Payment provider](#1-payment-provider)
2. [Supabase — secrets and Vault](#2-supabase--secrets-and-vault)
3. [Supabase — extensions and cron](#3-supabase--extensions-and-cron)
4. [Cloudflare — domains, Pages, Worker](#4-cloudflare--domains-pages-worker)
5. [Order of operations on a fresh deploy](#5-order-of-operations-on-a-fresh-deploy)
6. [Verifying it all works](#6-verifying-it-all-works)

---

## 1. Payment provider

A Lightning/Spark wallet SDK, run by the payment service in `payment-service/` (see
its README). It needs `PAYMENT_SERVICE_URL` and `PAYMENT_SERVICE_SECRET`
as Edge Function secrets (§2.1). Withdrawals are still paid by hand.

---

## 2. Supabase — secrets and Vault

### 2.1 Edge Function secrets

```
Dashboard → Edge Functions → Secrets
```

| Secret | Required | Notes |
|---|---|---|
| `CRON_SECRET` | yes | Guards the scheduled functions |
| `ALLOWED_ORIGINS` | yes | Comma-separated; bare hosts or full URLs both work |
| `GITHUB_TOKEN` | for backups | Repo-scoped PAT |
| `GITHUB_OWNER` / `GITHUB_REPO` | for backups | Where ledger snapshots go |
| `ALERT_WEBHOOK_URL` | optional | Discord/Slack incoming webhook |
| `ALERT_TELEGRAM_BOT_TOKEN` | for Telegram | From @BotFather. Sends ops alerts and settled-payment messages to the admin group |
| `ALERT_TELEGRAM_CHAT_ID` | optional | Admin group, a negative number |
| `ALERT_ON_SETTLED` | optional | `false` stops settled-payment copies to the admin group |
| `PAYMENT_SERVICE_URL` | yes | Base URL of the payment service |
| `PAYMENT_SERVICE_SECRET` | yes | Shared bearer secret, same value as the service |
| `CPAY_SUPABASE_ACCESS_TOKEN` | for the email-confirmation switch | Supabase personal access token (`SUPABASE_ACCESS_TOKEN` in CLI terms; the `SUPABASE_` prefix is reserved for secrets). **Account-level and powerful** — edge-function secret only, never anywhere else. See `docs/ENV_VARS.md` |
| `CPAY_PROJECT_REF` | optional | Only if `SUPABASE_URL` is not `https://<ref>.supabase.co` |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are
injected automatically — do not set them by hand.

### 2.2 Vault (used by cron, not by the functions)

pg_cron runs **inside Postgres**, where Edge Function secrets do not
exist. It reads these from Vault instead:

```sql
select vault.create_secret('https://<project-ref>.supabase.co/functions/v1',
                           'cpay_functions_url');
select vault.create_secret('<the same value as CRON_SECRET>',
                           'cpay_cron_secret');
```

To rotate `CRON_SECRET` later you must change it in **both** places —
Edge Function secrets *and* Vault. Changing only one silently breaks
every scheduled job, because the call is made with one value and
checked against the other.

```sql
-- Check what Vault currently holds
select name, created_at from vault.secrets order by name;
```

---

## 3. Supabase — extensions and cron

### 3.1 Extensions

```
Dashboard → Database → Extensions
```

Enable: **`pg_cron`**, **`pg_net`**, **`pgcrypto`**, **`uuid-ossp`**.

The scheduling migrations check for `pg_cron` and skip silently if it
is missing — so a migration can "succeed" while scheduling nothing.
Enable the extensions *before* running migrations, or re-run the
scheduling ones afterwards.

### 3.2 The scheduled jobs

| Job | Schedule (UTC) | What it does |
|---|---|---|
| `cpay-health` | `*/15 * * * *` | 4 checks; alerts and returns 503 when unhealthy |
| `prune-webhook-events` | `20 3 * * *` | 90-day retention on the dedup table |
| `ledger-backup-trigger` | `5 11 * * *` | Commits a redacted snapshot to GitHub |
| `daily-report-trigger` | `10 18 * * *` | Writes the 5pm–5pm rollup into `daily_stats` |

```sql
-- What is actually scheduled right now
select jobname, schedule, active from cron.job order by jobname;

-- Did the last runs succeed?
select j.jobname, r.status, r.return_message, r.start_time
from cron.job_run_details r
join cron.job j on j.jobid = r.jobid
order by r.start_time desc
limit 20;
```

`daily-report-trigger` at 18:10 UTC is **23:10 in Dhaka** — deliberately
after the 17:00 Dhaka cycle boundary, so the day it writes is complete.
Changing the boundary means changing this schedule too.

---

## 4. Cloudflare — domains, Pages, Worker

### 4.1 Do subdomains need adding separately?

**No.** Once the root domain is on Cloudflare, a subdomain lives in the
same zone. You do **not** create a second zone for `pay.cpay.io`.

What you do is add it as a **custom domain on the Pages project**:

```
Pages project → Custom domains → Set up a domain → pay.cpay.io
```

Cloudflare creates the DNS record itself. Nothing to add by hand.

### 4.2 Do you need a `pay.` subdomain at all?

No — it is a choice, not a requirement. The schema supports it directly:
`site_domains.purpose` is one of `'payment'`, `'site'`, or `'both'`.

- **One domain, `purpose = 'both'`** — simplest. Payment links and the
  dashboard share a hostname.
- **Split** — `cpay.io` as `'site'`, `pay.cpay.io` as `'payment'`.
  Payment links resolve on the payment host only.

Register each hostname in the table so CORS and link resolution know
about it:

```sql
insert into site_domains (hostname, purpose, is_active, theme)
values ('pay.cpay.io', 'payment', true, 'keypad');
```

The hostname must be **bare** — no `https://`, no trailing slash. The
Edge Functions normalize both shapes before comparing, but the database
is the side that has to match a browser's `Origin` header.

### 4.3 Pages settings

```
Build output directory:  public
Build command:           (none — it is static)
```

`public/_headers` carries the security headers. Cloudflare applies it
automatically; no dashboard configuration needed.

### 4.4 The OG preview Worker

`worker/og-preview-worker.js` serves link preview images to social
crawlers. It needs a route, or it never runs:

```
Workers & Pages → your worker → Settings → Triggers → Add route
  Route:  pay.cpay.io/*
  Zone:   cpay.io
```

Add one route per payment hostname.

### 4.5 SSL/TLS

```
SSL/TLS → Overview → Full (strict)
SSL/TLS → Edge Certificates → Always Use HTTPS → On
```

---

## 5. Order of operations on a fresh deploy

Sequence matters — several steps fail silently if done out of order.

1. **Supabase project created**, extensions enabled (§3.1) — *before*
   migrations, or cron scheduling is skipped
2. **Migrations run** in order, `0001 → 0101`
3. **Vault secrets** set (§2.2) — the scheduling migrations read them
4. **Edge Function secrets** set (§2.1)
5. **All 9 functions deployed:**
   ```
   supabase functions deploy admin-actions
   supabase functions deploy auth-settings
   supabase functions deploy create-invoice --no-verify-jwt
   supabase functions deploy user-withdraw
   supabase functions deploy daily-report   --no-verify-jwt
   supabase functions deploy ledger-backup  --no-verify-jwt
   supabase functions deploy og-image       --no-verify-jwt
   supabase functions deploy health         --no-verify-jwt
   ```
6. **Payment provider** configured (§1)
7. **Cloudflare** domain added, Worker route attached (§4)
8. **`site_domains` rows** inserted for every hostname (§4.2)
9. **Admin account** promoted:
   ```sql
   update profiles set role = 'admin' where email = 'you@example.com';
   ```
10. **Global switches** reviewed in the admin panel (§6)

---

## 6. Verifying it all works

### Scheduled jobs

```sql
select jobname, schedule, active from cron.job order by jobname;
```
Five rows, all `active = true`. Fewer means `pg_cron` was off when the
migrations ran.

### Health endpoint

```
https://<project-ref>.supabase.co/functions/v1/health?secret=<CRON_SECRET>
```
200 with every check `ok: true`. A 503 names the failing check.

### The settings toggles

`VERIFY-settings-toggles.sql` reports each toggle's stored value and
its JSON type. The `*_enabled` keys must be `boolean` — a value saved
as the *string* `"true"` fails every check silently, because
`'true'::jsonb` and `'"true"'::jsonb` are different values.

### Pricing end to end

With a user's `cost_percent` at 3:

1. Open their $100 link
2. The invoice should read **$103.00**
3. After settling, their balance should read **$103.00**

### Lightning payouts

Instant payouts are stubbed until the wallet SDK integration lands;
every request currently queues for an admin. Once it
exists:

1. Save a Lightning Address in the dashboard (`you@wallet.com`)
2. Admin → Settings: **Manual withdrawal requests** on, **Instant
   Lightning** on, and the creator's own instant toggle on
3. Request a small withdrawal — it should settle without anyone
   approving it

If it queues instead, one of those three switches is off. All three are
required, by design: two global and one per-user.

---

## Quick reference — the two percentages

Easy to confuse, completely different:

| Setting | Where | Who pays it | Who sets it | Limit |
|---|---|---|---|---|
| `cost_percent` | CPAY profile | The payer | The freelancer themselves, or an admin | None (1000% typo guard) |
| `withdrawal_fee_percent` | CPAY profile | The user | Admin, per profile | None (100% — beyond that payout goes negative) |

**These are not the same thing and never affect each other.** The cost
markup is the user's own pricing, paid by their customer. The withdrawal
fee is what the platform charges that user at payout. A user can price
at 40% while paying a 3% fee, or price at 0% while paying 20% — the two
numbers are independent in both directions.

New accounts get their fee from **Admin → Settings → Default fee for new
creators**. Changing that default only affects accounts created
afterwards; existing users keep whatever they have until you change it
on their own profile.

A $100 link owned by someone on 3% cost and 3% fee:
payer is invoiced **$103.00** → owner is credited **$103.00** → on
withdrawal the owner receives **$99.91** and the platform keeps
**$3.09**.

---

## Pinning the CDN scripts (SRI) — needs one command you must run

Both pages load scripts from a CDN, and neither is pinned or
integrity-checked:

```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
```

`@2` is a floating range — it silently serves whatever the latest v2 is.
If jsDelivr were ever compromised, or a bad v2 published, every page
including the admin panel would execute it.

**This is not fixed in the repo, deliberately.** Subresource Integrity
needs the real SHA-384 hash of the exact file being pinned. A guessed or
stale hash does not degrade gracefully — the browser refuses the script
outright and every page stops working. The hash has to be computed from
the file you are actually going to serve.

Run this yourself, then paste the results in:

```bash
# 1. Find the exact current version
curl -sI https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2 | grep -i x-jsd-version

# 2. Compute its hash (substitute the version from step 1)
curl -s https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4 \
  | openssl dgst -sha384 -binary | openssl base64 -A

# 3. Same for qrcodejs, which is already version-pinned
curl -s https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js \
  | openssl dgst -sha384 -binary | openssl base64 -A
```

Then in every page that loads them:

```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4"
        integrity="sha384-<hash from step 2>"
        crossorigin="anonymous"></script>
```

Note the version must be pinned exactly — SRI on a floating `@2` URL
breaks the moment a new v2 is published, which is the opposite of what
you want.

Eight pages load supabase-js; `invoice-cpay-v2.html` and `404.html`
also load qrcodejs.

**Upgrading later** means repeating this: change the version, recompute
the hash, update both. That cost is the reason it is worth doing
deliberately rather than being talked into it — but on a payments admin
panel, an unpinned third-party script is a real single point of failure.
