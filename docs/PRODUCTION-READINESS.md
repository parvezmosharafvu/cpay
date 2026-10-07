# CPAY production-readiness checklist

CPAY is a separate system. Completing this checklist must not require a
change to the previous production project.

**Chat 5 status (2026-10-07 Asia/Dhaka):** **CONDITIONAL GO** — automated
code/QA on stack tip is green; High **ops** items (orphans, Telegram secrets,
prod migration `20261007040000`, staging money path, PR stack merge) remain
**OPEN**. Do not call production-ready until those are closed or explicitly
accepted by the owner with dated evidence.

Evidence branch: `release/chat5-qa` (from Chat 4 tip `4540043`). main not
updated until stack merges.

## Repository and database

- [x] `python3 ci/check_frontend.py` passes. *(Chat 5 local run)*
- [x] `npm run build` passes. *(Chat 5)*
- [ ] A backup or snapshot exists for the new CPAY Supabase project. **OPEN (owner)**
- [x] Migrations apply in order on empty/CI DB (122 files; uniqueness check). *(CI + Chat 1/5 local)*
- [ ] Migration history and the live **production** schema agree (incl. apply `20261007040000`). **OPEN (owner)**
- [x] RLS / allowlist / search-path checks pass on privcheck-style DB. *(Chat 5: anon + authenticated allowlists, sweep)*
- [x] Rollback / restore plan documented. *(docs/BACKUP-RECOVERY.md, RELEASE-CHECKLIST.md)*

## Identity and admin control

- [x] Suspended/pending/rejected gates covered in SQL + Deno admin-auth tests. *(unit/SQL; live admin UI exercise still manual)*
- [ ] An admin has exercised approve/suspend on **staging** with a real session. **OPEN (manual)**
- [ ] Emergency suspension verified on staging public pages. **OPEN (manual)**
- [x] UI: admin Status control + filters present; server RPCs authoritative. *(Chat 3 + unit tests)*

## Payment provider and events

- [ ] CPAY mainnet wallet custody decision + offline mnemonic recorded by owner. **OPEN (owner)**
- [ ] Invoice → settle → balance → USDT quote/confirm small amount on staging. **OPEN (owner approval; no real money in Chat 5)**
- [x] Public payment a11y / QR ownership guards green in `check_frontend.py`. *(Chat 5)*
- [x] Settle idempotency / duplicate delivery covered by payment-service + financial invariants. *(Chat 5: 119 pass / 1 skip)*
- [ ] Live health function reports provider correctly in production. **OPEN (ops)**
- [x] Stuck-`sending` human path documented (no auto fail+refund). *(RUNBOOKS + hardening tests)*

## Withdrawals

- [x] Product path is USDT/USDC quote/confirm only; manual/`request_withdrawal` closed in edge + SQL + CI guard. *(Chat 1–5)*
- [x] Idempotency, quote expiry re-quote, leaf retry, concurrency, limits covered in payment-service tests. *(Chat 5)*
- [ ] Small mainnet USDT send per offered route. **OPEN (owner)**
- [ ] Per-account limits reviewed in admin for accounts that may withdraw. **OPEN (owner)**
- [x] Withdrawal fee model (override else global; admin-only withdraw-for) tested in SQL/service. *(Chat 5)*

## Cloudflare and public site

- [ ] Cloudflare points at intended `cpay` repo/project for production cut. **OPEN (owner confirm)**
- [x] Build = `npm run build`; wrangler / direct-upload docs present. *(DEPLOYMENT.md, DIRECT-UPLOAD.md)*
- [x] Public smoke (landing/auth/store/invoice/slug/touch) Playwright 7/7 local. *(Chat 5)*
- [ ] Headers/HTTPS/custom domains/OG/CORS checked on live domains. **OPEN (manual)**
- [x] No traditional payout ads / reseller commission in public surface (copy + frontend checks). *(Chat 5)*

## Operational sign-off

- [ ] Admin → Health preflight reviewed on live/staging. **OPEN (owner)**
- [ ] Staging sign-off ledger complete. **OPEN (owner)**
- [ ] Cron health with rotated secret observed. **OPEN (owner)**
- [ ] Daily reconciliation, ledger backup, alert delivery observed. **OPEN — alerts blocked until Telegram secrets (H4)**
- [x] Owner has runbooks + emergency-stop docs. *(RUNBOOKS, INCIDENT, OPS_OWNER_CUTOVER)*
- [ ] Controlled production rollout planned after ops cutover. **OPEN (owner)**

## Remaining High ops (block full GO)

| ID | Item | Doc |
|---|---|---|
| H3 | Orphan Edge Functions still ACTIVE (`reconcile`, `reseller-digest`, `telegram-report`) | OPS_OWNER_CUTOVER.md |
| H4 | Telegram bot secrets unset / outbox 503 risk | OPS_OWNER_CUTOVER.md |
| Mig | Apply `20261007040000` + redeploy `user-withdraw` on production | OPS_OWNER_CUTOVER.md §C |
| Stack | Merge PR stack #28→#29→#30→#32→#33 (chat5) without force-merging red #28 Pages | RELEASE-CHECKLIST.md |

Do not call CPAY production-ready until every unchecked item has a named
owner, documented exception or completed test result.
