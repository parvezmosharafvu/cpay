# Ops drift, October 2026: Telegram 503s, admin-wallet 404s, orphan Edge Functions

Status: findings and plans only. **This PR changes no production state.** No secret
was set, no function deleted or deployed, no SQL write. All evidence below comes from
read-only queries (catalog, `cron.job`, aggregate `SELECT`s with no message content,
the Supabase log API, `list_edge_functions` and `get_edge_function`), run on
2026-10-04 at about 19:40 Asia/Dhaka. All times are Asia/Dhaka (UTC+6) unless they say UTC.

## 1. Findings

### F1. telegram-notify answers 503 to every cron call (confirmed, with corrections)

| What | Evidence |
|---|---|
| Cause | `ALERT_TELEGRAM_BOT_TOKEN` is not set for Edge Functions. `function_logs`, last 24 h: **1,440** lines `{"event":"telegram-notify","error":"ALERT_TELEGRAM_BOT_TOKEN is not set"}`, one per minute. |
| 503 count | `function_edge_logs`, POST `/functions/v1/telegram-notify` → 503: **1,391** (3 Oct 19:41 → 4 Oct 19:40). The edge log drops some rows; the function log's 1,440 is the true count (one every minute). Earlier 24 h windows: 1,361, 1,343, and 870 in the first window. |
| Start | First 503: **1 Oct 04:17:01** (30 Sep 22:17 UTC), one minute after the outbox row below was written. No telegram-notify request appears before that. |
| Cron | Job 3 `cpay-telegram-send`, `* * * * *`, active. 1,440 runs in 24 h, all `succeeded`. pg_net fires and the cron run doesn't wait for the HTTP result, so a 503 still counts as a successful run. |
| Outbox | `telegram_outbox` has **1 row**: id 1, kind `payment_settled`, recipient `admin` (chat `admin`), status `pending`, **attempts 0**, `claimed_at` null, created **1 Oct 04:16:05** (30 Sep 22:16 UTC), the moment its payment settled. No other rows, and 0 reseller groups are enabled. |

**Corrections to the original account.**

- **The row isn't retried every minute. It has never been claimed.**
  - The handler (`supabase/functions/telegram-notify/handler.ts`) checks the bot token *before* calling `telegram_claim`. It returns 503 and doesn't touch the outbox, so `attempts` stays 0. The 5-attempt and backoff logic in `telegram_finish` never runs.
- **The single row is what keeps the storm going.**
  - Job 3 only calls the function `where exists (select 1 from telegram_outbox where status = 'pending' and next_attempt_at <= now())`.
  - With nothing pending there would be no calls. With one row that can never be claimed, there's a call every minute, forever.
- **"30 Sep" is the UTC date.** In Dhaka the row is from 1 Oct 04:16.
- **Setting only the bot token would not deliver this row.**
  - The row is addressed to `admin`, so it also needs `ALERT_TELEGRAM_CHAT_ID`.
  - With the token set but no chat id, the row is marked `skipped` with `ALERT_TELEGRAM_CHAT_ID is not set`. The 503s still stop.
- **Side effect worth knowing:** `health`, `daily-report` and `ledger-backup` also send their ops alerts via `ALERT_TELEGRAM_BOT_TOKEN` + `ALERT_TELEGRAM_CHAT_ID`. Until those are set, Telegram ops alerts are silent. A webhook (`ALERT_WEBHOOK_URL`) may still deliver them.

### F2. admin-actions root POST 404, then fallback to /admin-wallet (confirmed; counts corrected)

Last 24 h (3 Oct 22:20 → 4 Oct 19:22), `function_edge_logs`:

| Request | Status | Count |
|---|---|---|
| POST `/functions/v1/admin-actions` (root) | 404 | **52** |
| POST `/functions/v1/admin-actions/admin-wallet` | 200 | **45** |
| OPTIONS `/functions/v1/admin-actions` | 200 | 39 |
| OPTIONS `/functions/v1/admin-actions/admin-wallet` | 200 | 37 |

- **Cause:**
  - `public/admin.html` loads `admin-wallet.js`, then `admin-wallet-route.js`. The later file's `walletCall()` replaces the first.
  - That `walletCall()` POSTs to `admin-actions` first. On a 404 or "not found" it retries `admin-actions/admin-wallet`.
  - `supabase/functions/admin-actions/index.ts` only routes paths ending in `/admin-wallet`, `/process-withdrawal` and so on. The bare root falls through to `404 Not found`.
  - Every wallet call (Wallet tab, and the USDT tile on the admin home via `admin-home-live.js`) therefore costs a 404, an extra CORS preflight and an extra round trip.
- **Correction:** the 45 is the count of successful fallbacks. The root 404s number 52 in the same window, so 7 probes had no matching fallback in the log, probably from an older cached script or a page closed mid-call. Earlier windows show the same pattern (58 × 404 / 102 × 200, 89 × 404 / 93 × 200).
- **Fixed in this PR:** see §3.

### F3. Three orphan Edge Functions (confirmed; provenance corrected)

| | telegram-report | reseller-digest | reconcile |
|---|---|---|---|
| Deployed version | v13 | v12 | v24 |
| First deployed | 22 Sep 07:22 | 24 Sep 04:17 | 22 Sep 00:15 |
| Last deployed | **24 Sep 03:03** | 26 Sep 16:40 | 24 Sep 04:17 |
| Deployed from | a local checkout (`/Users/<owner>/Downloads/cpay-github/…`) | `/app/supabase/functions/…` (container/CLI build) | `/app/supabase/functions/…` |
| In repo now | no | no | no |
| Ever in git | **never** | yes: removed in `a71fff6` (28 Sep, the 0106 commit); the deployed code is byte-identical to `a71fff6^` | yes: stubbed in `f9a79c1`, removed in `ba2c48f` (25 Sep); the deployed code is the **pre-stub baseline** `d14b708` (live BTCPay calls) |
| verify_jwt | false | false | false |
| Auth | `x-telegram-report-secret` = `TELEGRAM_REPORT_SECRET` | `x-cron-secret` = `CRON_SECRET` | `x-cron-secret` = `CRON_SECRET` |
| DB dependencies | `telegram_find_payments` (**missing**: dropped by 0106), `telegram_context` (**exists**: adopted service_role-only by `20261004020000`) | `list_reseller_alert_targets`, `reseller_cycle_digest` (**both missing**: dropped by 0106) | table `btcpay_shops` (**missing**: dropped by **0093**, not 0106), `payments.btcpay_invoice_id` (renamed by 0093), rpc `daily_totals_for_cycle` (exists) |
| Would work if called? | partly: `health` and default report actions work; `verify_payment` fails | no: 500 on the first RPC | no: 500 on the first query |
| Cron | none | none | none (`cpay-reconcile` from 0045 is gone; the only jobs are 1–4) |
| Invocations | **0** in every window checked: 29 Sep 19:40 → 4 Oct 19:40 (5 × 24 h, all retained edge logs) | 0 | 0 |
| Callers in repo | none (only a comment in `ci/authenticated_rpc_allowlist.sql` naming it as `telegram_context`'s user) | none | none |

- **Correction:** only `telegram-report` was never in the repo. The other two were in the repo and were removed from it; their deployments were never deleted.
- **Correction:** `reconcile`'s table went in migration 0093 (remove BTCPay), not 0106.
- Rollback copies of all three deployed sources are saved outside the repo; see §5.

### F4. Other observations

- **Repository visibility.** `parvezmosharafvu/cpay` is **public**. The `hygiene` job in `verify.yml` still says "the repository is private". No ledger snapshots are tracked (0 files under `ledger-backups/`), so nothing is exposed today, but that comment's premise no longer holds. For this reason the doc and fixtures avoid local paths, chat ids and payment details.
- **`telegram_context`** is called only by `telegram-report`. Once `telegram-report` is deleted, a later migration can drop it, along with its allowlist entry and the drift-check line.

## 2. Edge Function inventory (repo vs production vs last 24 h)

Production list from `list_edge_functions`, 4 Oct ~19:40. Activity counts all requests, including OPTIONS, from 3 Oct 19:41 to 4 Oct 19:40.

| Function | In repo | In production | 24 h activity | Verdict |
|---|---|---|---|---|
| admin-actions | yes | yes | root POST 404 × 52, `/admin-wallet` 200 × 45, OPTIONS 76 | keep; frontend root probe removed (F2) |
| auth-settings | yes | yes | 0 (2 on 29 Sep) | keep |
| create-invoice | yes | yes | 0 (1 on 1 Oct) | keep |
| daily-report | yes | yes | 1 × 200 (cron 1) | keep |
| health | yes | yes | 0 | keep (no cron schedules it now; called by `telegram-report`'s `health` action and by hand) |
| ledger-backup | yes | yes | 0 in this window; 1 × 200 daily in the earlier windows (cron 2) | keep |
| og-image | yes | yes | 0 (1–70/day earlier) | keep |
| telegram-notify | yes | yes (v6) | 503 × 1,391 (edge) / 1,440 (function log) | keep; **set secrets** (F1, §6) |
| user-withdraw | yes | yes | OPTIONS × 4 | keep |
| **reconcile** | **no** | yes (v24) | 0 (0 in 5 days) | **delete** (§5) |
| **reseller-digest** | **no** | yes (v12) | 0 (0 in 5 days) | **delete** (§5) |
| **telegram-report** | **no** | yes (v13) | 0 (0 in 5 days) | **delete** (§5), then drop `telegram_context` |

## 3. Frontend fix in this PR

- `public/admin-wallet-route.js`: `walletCall(action, body)` now POSTs once to `admin-actions/admin-wallet` (`WALLET_ROUTE`). There's no root probe and no fallback. The request body, headers, auth and error shape (`Error` with `.status`) are unchanged, and so is the returned JSON.
- `public/admin-wallet.js`: `WALLET_FN` is now `admin-actions/admin-wallet`, so the overridden copy is correct too if the load order ever changes.
- `public/admin.html`: cache-buster `?v=25` → `?v=26` for those two scripts, so browsers drop the probing version.
- `tests/frontend/app.test.mjs`: three tests.
  - `walletCall` makes exactly one POST, to `…/functions/v1/admin-actions/admin-wallet`, with the expected body and auth.
  - A 404 surfaces as an error without a second request.
  - No admin page script names the bare `admin-actions` root.
  - Against the old file, these three tests fail.
- **Expected effect after deploy:** POST `/functions/v1/admin-actions` 404s drop to ~0 (stragglers until cached pages reload), and the OPTIONS count on the root falls with them. `/admin-wallet` 200s stay at the same volume.

## 4. Deployed-vs-repo drift check

`scripts/check_edge_function_drift.py` compares deployed slugs with `supabase/functions/*/index.ts`. It exits 1 on drift and 2 on an error, and it only issues GET requests.

- **CI (no secrets):**
  - The `functions` job runs the script against `ci/fixtures/deployed_functions_2026-10-04.json`, the production list saved today.
  - It asserts that exactly the three orphans are flagged, that no repo function is missing, and that `--allow` for the three yields exit 0.
  - This tests the script and prints the repo set on every run.
  - A live comparison in CI would need a Supabase personal access token as a repo secret. It is deliberately not added: that token can deploy and delete functions for the whole account.
- **Live check (owner, by hand). Pick one:**

  ```bash
  # a) Management API with your own token (read-only GET; the token is never printed)
  SUPABASE_ACCESS_TOKEN=... python3 scripts/check_edge_function_drift.py --project-ref riumaeihemgznvgattoc

  # b) CLI, logged in
  supabase functions list --project-ref riumaeihemgznvgattoc -o json > /tmp/deployed.json
  python3 scripts/check_edge_function_drift.py --deployed-json /tmp/deployed.json
  ```

  - Today the expected output is `ORPHAN reconcile / reseller-digest / telegram-report`, exit 1.
  - After the deletions in §5 it should be `No drift.`, exit 0. Then refresh the fixture (drop the three entries) and change the CI assertion to expect exit 0.
- **When to run it:** after every manual deploy, and monthly.

## 5. Controlled deletion plan for the three orphans (not executed)

### Rollback material, already saved (outside the repo)

`/workspace/cpay-audit/orphan-functions/` on the audit box, saved read-only via `get_edge_function` on 4 Oct, contains:

- `<slug>/index.ts`: the deployed source, single file each;
- `<slug>/metadata.json`: id, version, verify_jwt, entrypoint, ezbr_sha256;
- `SHA256SUMS` and a `README.md`.

Two more fallbacks exist: `reseller-digest` equals `git show a71fff6^:supabase/functions/reseller-digest/index.ts`, and `reconcile` equals `git show d14b708:supabase/functions/reconcile/index.ts`.

### Pre-checks (run the day of deletion; all must hold)

1. **No cron.**
   - `select jobid, jobname, command from cron.job where command ilike any (array['%telegram-report%','%reseller-digest%','%reconcile%']);` returns 0 rows.
2. **No invocations.**
   - Logs Explorer (or `query_logs`) over the last 7 days, one 24 h window at a time:
     `select log_attributes['request.pathname'] p, count(*) from logs where source='function_edge_logs' and log_attributes['request.pathname'] similar to '%/(telegram-report|reseller-digest|reconcile)%' group by p`
   - Expect 0.
3. **No callers.**
   - `rg -n "telegram-report|reseller-digest|functions/v1/reconcile" .` in the repo shows only docs and the fixture.
   - Nothing external you control (bots, n8n/Zapier flows, the Cloudflare worker, uptime monitors) targets them. Check especially any Telegram bot that used `x-telegram-report-secret`.
4. **Drift check** shows exactly these three as `ORPHAN`.
5. **Rollback copies exist:** `sha256sum -c SHA256SUMS` in `orphan-functions/` passes.

### Steps (one function at a time, least risky first)

```bash
supabase functions delete reseller-digest --project-ref riumaeihemgznvgattoc   # broken: its RPCs are gone
# wait 10 min; Logs: no new 404/5xx spikes for anything that might call it
supabase functions delete reconcile --project-ref riumaeihemgznvgattoc         # broken: btcpay_shops is gone
# wait 10 min
supabase functions delete telegram-report --project-ref riumaeihemgznvgattoc   # partly working; last
```

(Dashboard alternative: Edge Functions → function → Settings → Delete.)

**After each step:**

- `supabase functions list` no longer shows it.
- The drift check output shrinks by one.
- Requests to `/functions/v1/<slug>` now answer 404 at the gateway. There should be none.

**After all three:**

- The drift check prints `No drift.` Update the fixture and CI assertion in a small PR.
- Optionally, unset secrets that only these used. Check first with `rg` across `supabase/functions`: `TELEGRAM_REPORT_SECRET` (telegram-report only), and `BTCPAY_URL` and `BTCPAY_API_KEY*` (reconcile only, if no other function still reads them).
- In a later migration PR, drop `public.telegram_context(text, integer)` and remove its line from `ci/authenticated_rpc_allowlist.sql` and the drift checks.

### Rollback (per function)

```bash
mkdir -p /tmp/rb/supabase/functions
cp -r /workspace/cpay-audit/orphan-functions/<slug> /tmp/rb/supabase/functions/
cd /tmp/rb && supabase functions deploy <slug> --project-ref riumaeihemgznvgattoc --no-verify-jwt
```

- Secrets are project-level and survive a function delete, so a redeploy needs nothing else, unless they were unset in the optional step above. Re-set them in that case.
- The URL is the same after redeploy; the function id and version number will differ.

## 6. Runbook: Telegram notifications back on

**Owner actions** (Dashboard → Project Settings → Edge Functions → Secrets, or `supabase secrets set`):

1. `ALERT_TELEGRAM_BOT_TOKEN`: the cpay bot token from @BotFather.
2. `ALERT_TELEGRAM_CHAT_ID`: the admin group id. The bot must be a member. This is required for the pending row (addressed to `admin`) and for ops alerts.
3. Optional: `ALERT_ON_SETTLED=false` if per-payment messages to the admin group are unwanted. Rows still drain, as `skipped`.

Secrets apply to new invocations without a redeploy. **Make the stale-row decision below before step 1**, because the next minute's cron call will process the row.

**Verify (read-only), within 2–3 minutes:**

```sql
-- outbox drained: expect 0 pending; row 1 now sent (or skipped / failed with a reason)
select status, count(*), max(attempts) from public.telegram_outbox group by status;
select id, status, attempts, sent_at, left(last_error, 120) from public.telegram_outbox where id = 1;
```

- **Logs:** the last telegram-notify request is a 200 with `{"ok":true,"sent":1,...}`. After that there are **no further telegram-notify calls at all**, because the cron fires only while a due pending row exists. The function log line `ALERT_TELEGRAM_BOT_TOKEN is not set` stops.
- **Next day:** `query_logs` count of telegram-notify 503 over 24 h is 0. Telegram-notify 200s appear only after settled payments or the 17:00 daily close (if any reseller group is enabled; 0 are today).
- **If the row ends `failed` with `Telegram 400/403`:** the bot isn't in the group or the chat id is wrong. Fix the setting; the row is not resent automatically (by design).

### Decision for the owner: the stale 1 Oct row (id 1). Not touched.

It's a single "payment settled" notice for one payment (settled 1 Oct 04:16) to the admin group. Options:

- **(A) Send it.** Do nothing; it goes out when the secrets are set. Harmless, but it announces a 3+-day-old payment as if new. It's also a free end-to-end delivery test.
- **(B) Expire it.** Before setting the token, the owner approves this one statement (a production write, not run here):
  `update public.telegram_outbox set status='skipped', last_error='Expired: queued before the bot token was configured' where id=1 and status='pending';`
  The 503 storm stops immediately, even before the token is set, because no due row remains.

**Recommendation: (B).**

- It stops the 1,440 calls/day today, independent of when the bot is ready.
- It avoids a stale message.
- Verify delivery afterwards with the next real settlement, or with `health`'s alert path.

If you prefer one real test message, choose (A) and set both secrets together.

## 7. Proposal (not implemented): telegram-notify shouldn't 503-storm when it isn't configured

**Today:** missing token → 503 without claiming → the row stays due → the cron calls again next minute. There's no backoff, the noise is unbounded, and a real 503 (an outage) looks the same as "not configured yet".

**Options:**

1. **Defer, then 503 (recommended).**
   - When the token is missing (or the admin chat id is missing for `admin` rows), call a new service-role RPC `telegram_defer(p_secs int)`. It pushes `next_attempt_at` of due pending rows forward, e.g. 15 min, without counting an attempt.
   - The function still answers 503, so the misconfiguration stays visible, but at most 4 times an hour instead of 60. Rows are kept and go out once configured.
   - Cost: a small migration plus a handler change and tests.
2. **Answer 200 `{ok:false, skipped:"not_configured"}`.** Silences the error rate but hides a real misconfiguration in dashboards. Not recommended on its own.
3. **Make the cron command check configuration.** pg_cron can't see Edge secrets. It would need a mirrored flag in `app_settings` or the vault, which is one more thing to drift.
4. **Surface it in `health`.** Report "telegram: not configured, N pending, oldest age" so the existing health alert says it once (via webhook, if Telegram is the missing piece). Complements option 1.

**Proposal:** option 1, plus option 4, plus a max-age rule in `telegram_claim` (or a daily sweep) that marks `payment_settled` rows older than e.g. 24 h as `skipped` (`expired`). Then a long outage never replays stale "payment settled" messages, and the §6 decision answers itself next time. A separate PR needs approval.

## 8. D8 scope note: `public_settled_feed`

- **What it is:** `public.public_settled_feed(integer)`, SECURITY DEFINER, executable by `anon` and `authenticated`. It's one of six anon SECURITY DEFINER functions left after PR #20.
- **What it returns:** the most recent settled payments' amounts and `settled_at`. The amount is the buyer amount when that creator shows it, otherwise the settled amount. It covers payments at or above `small_payment_threshold()`, at most 50 rows. There are no ids or names.
- **Gate:** it returns nothing unless `app_settings.public_feed_enabled = 'true'`. Production today is `false`, so it returns 0 rows.
- **Callers:** no current page calls it (`rg` over `public/` and `worker/` finds none).
- **D8 questions:**
  - Keep the anon grant at all?
  - Is exact amount + exact timestamp too revealing (correlatable with a buyer's own payment) if the toggle is turned on?
  - Rounding or bucketing amounts, coarsening times, or dropping the function if the home ticker is gone for good.
- This PR doesn't change it.

## 9. Decisions needed

1. Set `ALERT_TELEGRAM_BOT_TOKEN` and `ALERT_TELEGRAM_CHAT_ID` (owner, Dashboard).
2. Stale row id 1: **(A) send** or **(B) expire**. Recommended: (B), approved as the single statement in §6.
3. Approve deleting `reseller-digest`, `reconcile`, `telegram-report` per §5.
4. Approve the telegram-notify behavior change (§7, option 1 + 4 + max-age) as a separate PR.
5. After (3): approve a migration dropping `telegram_context`.
6. D8: scope `public_settled_feed` (§8).
7. The repo is public, but CI's hygiene note says private. Confirm the intended visibility.
