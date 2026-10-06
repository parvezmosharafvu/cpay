# Owner ops cutover — orphan Edge Functions + Telegram (Chat 4)

**Status:** documented only. This chat does **not** delete production functions
or set secrets. Execute only with explicit owner approval.

**Timezone for evidence:** Asia/Dhaka (UTC+6).

Related: `docs/OPS_DRIFT_2026-10.md` (full drift evidence), `docs/AUDIT.md` H3/H4,
backup copies under `/workspace/cpay-audit/orphan-functions/` on the audit box.

---

## A. Orphan Edge Functions (AUDIT H3)

| Slug | Why orphan | Risk if left |
|---|---|---|
| `reconcile` | BTCPay path removed; broken deps | `verify_jwt: false` surface |
| `reseller-digest` | Reseller product removed | `verify_jwt: false` surface |
| `telegram-report` | Superseded by `telegram-notify` + outbox | `verify_jwt: false` surface |

### A1. Pre-checks (all must hold the day of deletion)

1. **No cron** (SQL editor, service role):

```sql
select jobid, jobname, command from cron.job
where command ilike any (array['%telegram-report%','%reseller-digest%','%reconcile%']);
-- expect 0 rows
```

2. **No invocations** in the last 7 days (Logs Explorer / `query_logs`), path similar to
   `/(telegram-report|reseller-digest|reconcile)` — expect 0.

3. **No callers** in repo or automation:

```bash
rg -n "telegram-report|reseller-digest|functions/v1/reconcile" .
# only docs + ci fixtures
```

4. Drift fixture still lists these three as `ORPHAN`.

5. Rollback copies: `sha256sum -c SHA256SUMS` in the orphan-functions backup dir.

### A2. Delete (one at a time; least risky first)

```bash
PROJECT_REF=riumaeihemgznvgattoc   # confirm before running

supabase functions delete reseller-digest --project-ref "$PROJECT_REF"
# wait ~10 min; watch logs for unexpected 404/5xx

supabase functions delete reconcile --project-ref "$PROJECT_REF"
# wait ~10 min

supabase functions delete telegram-report --project-ref "$PROJECT_REF"
```

Dashboard alternative: Edge Functions → Settings → Delete.

After each: `supabase functions list` no longer shows the slug; drift list shrinks by one.

After all three: update `ci/fixtures` deployed list + drift assertion in a small PR
(expect `No drift.`). Optionally unset secrets only those used
(`TELEGRAM_REPORT_SECRET`, legacy `BTCPAY_*`) after `rg` confirms nothing else needs them.

### A3. Rollback (per function)

```bash
mkdir -p /tmp/rb/supabase/functions
cp -r /path/to/orphan-functions/<slug> /tmp/rb/supabase/functions/
cd /tmp/rb && supabase functions deploy <slug> --project-ref "$PROJECT_REF" --no-verify-jwt
```

Project-level secrets survive deletes unless you unset them.

---

## B. Telegram alert secrets / stuck outbox (AUDIT H4)

**Symptom:** `telegram-notify` returns 503 when `ALERT_TELEGRAM_BOT_TOKEN` is unset;
pending outbox rows are never claimed → cron storms.

### B1. Decide about the stale pending row first

```sql
select id, status, attempts, created_at, payload
from telegram_outbox
where status = 'pending'
order by created_at
limit 20;
```

- If the message is obsolete: mark skipped (do this **before** setting the bot token,
  or the next cron tick will send it).

```sql
update telegram_outbox
set status = 'skipped', last_error = 'owner skipped stale row before bot config'
where status = 'pending' and id = '<id>';
```

- If it should send: leave pending, set secrets, wait for cron.

### B2. Set secrets (Dashboard → Edge Functions → Secrets, or CLI)

```bash
supabase secrets set \
  ALERT_TELEGRAM_BOT_TOKEN='<from BotFather>' \
  ALERT_TELEGRAM_CHAT_ID='<admin group id>' \
  --project-ref "$PROJECT_REF"
```

Optional: `ALERT_ON_SETTLED=false` to skip per-payment admin noise (rows still drain as skipped).

Secrets apply to new invocations without redeploying `telegram-notify`.

### B3. Verify within 2–3 minutes

```sql
select status, count(*) from telegram_outbox group by 1;
-- pending should drain toward 0
```

Hit health (no alert spam): 

```bash
curl -H "x-cron-secret: $CRON_SECRET" \
  "$SUPABASE_URL/functions/v1/health?alert=0"
```

Confirm 503 rate on `telegram-notify` drops in logs.

---

## C. Migration + user-withdraw redeploy (still owner)

1. Apply `20261007040000_close_manual_payout_residue.sql` on production (forward-only).
2. Redeploy `user-withdraw` so closed manual methods stay HTTP 410 in prod.
3. Confirm Azure payment-service host: `RECEIPT_RECORDING` unset or `off` (read-only check).

---

## D. What Chat 4 does **not** do

- Delete production Edge Functions
- Set or rotate Telegram / payment secrets
- Enable `RECEIPT_RECORDING`
- Move real Lightning / USDT money
- Force-merge PR #28 while Pages/CI is red

After owner completes A–C, update `docs/AUDIT.md` H3/H4 to **CLOSED** with
Asia/Dhaka timestamps and evidence links.
