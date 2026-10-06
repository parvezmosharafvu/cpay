# CPAY Chat 1 audit — release blockers

**Date:** 2026-10-07 (Asia/Dhaka)  
**Baseline (main):** `53bee2505de2caf14dc473b3dfe06534ba2aed08` (PR #27 Dockerfile fix merged)  
**Branch:** `fix/security/audit-chat1`  
**Scope:** Audit + Critical/High fixes only. No framework rewrite. No real Lightning money moves. No Azure/GCP changes. Reseller commission stays removed (PRs #22/#25).

## Architecture & trust boundaries (summary)

```
browser (Vanilla HTML/CSS/JS, anon key + JWT, RLS)
  → Cloudflare Workers assets (public/)
  → Supabase Postgres (ledger, SECURITY DEFINER RPCs, pg_cron)
  → Edge functions (create-invoice, user-withdraw, admin-actions, …)
       → Bearer PAYMENT_SERVICE_SECRET
  → payment-service (Node 22, Breez Spark wallet, DATABASE_URL service role)
```

| Boundary | Rule |
|---|---|
| Browser | Not trusted. Money rules live in SQL. |
| Anon key | Public by design (`public/config.js`). |
| Service role | Bypasses RLS; only payment-service + selected edge paths. |
| Wallet mnemonic | Only on payment-service host (`BREEZ_MNEMONIC_FILE`). Never in Supabase. |
| Payout product | USDT/USDC to saved address only. `request_withdrawal` closed. `RECEIPT_RECORDING` default `off`. |
| Roles | Freelancer (`creator`) and admin only after `20261005020000`. |

## Baseline checks run (this machine)

| Check | Result |
|---|---|
| All 122 migrations apply to empty DB (`ci/bootstrap.sql` + ordered files) | **PASS** |
| `python3 ci/check_frontend.py` | **PASS** (incl. new manual-payout closed check) |
| `python3 ci/check_public_copy.py` | **PASS** |
| `node --test tests/frontend/app.test.mjs` | **PASS** (7/7) |
| `npm run build` | **PASS** |
| `ci/role_removal_test.sql`, `account_approval_test.sql`, `dashboards_test.sql`, `telegram_test.sql`, `revenue_desk_access_test.sql`, `profile_update_whitelist_test.sql`, `lightning_receipt_*`, `cloudai_regression.sql`, `authenticated_rpc_sweep_test.sql` on migrated DB | **PASS** |
| `ci/anon_rpc_allowlist.sql` + `authenticated_rpc_check.sql` on privcheck (default privileges) | **PASS** |
| Deno: `admin-auth`, `auth-settings`, `telegram-notify` handler tests | **PASS** |
| payment-service `money.test.mjs` + `config.test.mjs` (incl. `RECEIPT_RECORDING` default off) | **PASS** (8/8) |
| payment-service full `npm test` | **NOT RUN to green** — needs `DATABASE_URL` against migrated schema; local attempts failed without configured URL (ECONNREFUSED / auth). Do not claim pass. |

## Findings by severity

### Critical

*(none open after this PR’s code fixes; ops items that block a careful production cutover are listed under High / Remaining)*

### High

| ID | Finding | File refs | Status |
|---|---|---|---|
| H1 | `user-withdraw` still accepted `VALID_METHODS = bkash/nagad/binance/lightning/bank`, validated Lightning payout destinations, and called closed `request_withdrawal`. Product forbids those payouts; SQL already raised, but the edge path advertised and attempted them. | `supabase/functions/user-withdraw/index.ts` | **FIXED** — non-`routes`/`quote`/`confirm` → HTTP 410; methods removed |
| H2 | Address validators missing pinned `search_path` (Supabase advisor WARN `function_search_path_mutable`). | `usdt_address_ok`, `cpay_valid_onchain_address` | **FIXED** in `20261007040000_…` |
| H3 | Orphan Edge Functions still **ACTIVE** in production with `verify_jwt: false`: `reconcile`, `reseller-digest`, `telegram-report`. Not in repo; 0 recent traffic; broken deps. Documented in `docs/OPS_DRIFT_2026-10.md`. | Production function list 2026-10-07 | **OPEN (ops)** — delete needs owner approval; not done in this PR |
| H4 | Telegram notify 503 storm when `ALERT_TELEGRAM_BOT_TOKEN` unset (pending outbox row never claimed). | `docs/OPS_DRIFT_2026-10.md`, cron job `cpay-telegram-send` | **OPEN (ops)** — set secrets or clear/skip stale outbox |

### Medium

| ID | Finding | File refs | Status |
|---|---|---|---|
| M1 | Dead `submitManual` / `request_withdrawal` wiring in freelancer desk (unused by `bindWithdraw`, always would fail). | `public/freelancer-desk.js`, `public/app.js` | **FIXED** |
| M2 | Trigger SECURITY DEFINER helpers still `EXECUTE` for anon/authenticated (PostgREST cannot call `RETURNS trigger`, but advisors flag them). | production advisors + migration | **FIXED** revoke in `20261007040000_…` |
| M3 | Historical `profiles.wallet_bkash` / `wallet_nagad` / … columns remain (unused by queue path). | schema | OPEN — leave for history; no public UI ads (copy checks pass) |
| M4 | Admin `process-withdrawal` still supports `mark_paid_manual` for legacy rows. | `supabase/functions/admin-actions/index.ts` | OPEN — keep for old pending rows; do not expose in freelancer UI |
| M5 | Repo is public; hygiene job comment still assumes private. | `.github/workflows/verify.yml`, `docs/OPS_DRIFT_2026-10.md` | OPEN — docs/comment only |

### Low

| ID | Finding | Notes |
|---|---|---|
| L1 | RLS enabled, no policies on service-only tables (`telegram_outbox`, `webhook_events`, `lightning_receipts`, …) | Intentional deny-all for browser roles (advisor INFO) |
| L2 | `is_admin()` executable by anon (returns false without session) | Allowlisted; intentional |
| L3 | Amplitude write key in `src/home-analytics.js` | Public analytics key by design; not a ledger secret |
| L4 | payment-service `engines.node >=22` vs local Node 20 for some unit runs | CI/production use Node 22 |

## Security impact of this PR

- Narrows withdraw edge surface to USDT quote/confirm only; removes closed-method validation and Lightning-payout address parsing from the browser-facing function.
- Pins `search_path` on address validators; revokes browser EXECUTE on trigger helpers.
- Does **not** weaken auth, RLS, validation, or idempotency (`settle_breez_payment`, `reserve_stablecoin_withdrawal`, `finalize_stablecoin_withdrawal`, `system_claim_withdrawal` untouched).
- Does **not** reintroduce reseller commission or reseller role.

## UI/UX impact

- Freelancer cash tab: same quote/confirm USDT flow; removed dead manual RPC path and “Lightning payouts are off” copy.
- No theme/framework change. Vanilla HTML/CSS/JS preserved.

## Remaining release blockers (not fixed here)

1. Owner: delete orphan Edge Functions `reconcile`, `reseller-digest`, `telegram-report` (after confirming zero callers).
2. Owner: set `ALERT_TELEGRAM_BOT_TOKEN` (+ chat id) or resolve stuck `telegram_outbox` pending row so cron stops 503s.
3. Owner: apply migration `20261007040000` to production and redeploy `user-withdraw`.
4. Staging sign-off still open per `docs/PRODUCTION-READINESS.md` (mainnet wallet custody, small USDT send, limits, health).
5. Full payment-service suite against migrated DB in CI/CD host (Azure) — verify after deploy.

## Incorporates (do not regress)

PRs #16–#27: revenue_desk admin-only, receipt log record-only, checkout UX, reseller authz, production drift, ops drift docs, commission removal, role removal, public branding, suspended-admin gate, payment-service Dockerfile copy.
