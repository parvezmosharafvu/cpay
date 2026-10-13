# CPAY production-readiness checklist

CPAY is a separate system. Completing this checklist must not require a
change to the previous production project.

**Status 2026-10-14 (Asia/Dhaka):** **CONDITIONAL GO.** Code and CI are
green on main. Of the 2026-10-07 High ops items, the orphan functions (H3),
the production migration and the PR stack are done; Telegram alerting (H4)
works in production but waits for owner confirmation of the channel (see
below). Still open: admin MFA (code, then owner), legal pages, the freeze
test and the small-value mainnet pilot. `docs/RELEASE-BLOCKERS.md` is what
the release gate reads.

History: the 2026-10-07 (Chat 5) review used branch `release/chat5-qa`; that
stack (#28–#33) is merged.

## Repository and database

- [x] `python3 ci/check_frontend.py` passes. *(Chat 5 local run)*
- [x] `npm run build` passes. *(Chat 5)*
- [ ] A backup or snapshot exists for the new CPAY Supabase project. **OPEN (owner)**
- [x] Migrations apply in order on empty/CI DB (122 files; uniqueness check). *(CI + Chat 1/5 local)*
- [x] Migration history and the live **production** schema agree (incl. `20261007040000`). *(read-only check 2026-10-14: latest applied = latest in repo, `20261013090000`)*
- [x] RLS / allowlist / search-path checks pass on privcheck-style DB. *(Chat 5: anon + authenticated allowlists, sweep)*
- [x] Rollback / restore plan documented. *(docs/BACKUP-RECOVERY.md, RELEASE-CHECKLIST.md)*

## Identity and admin control

- [x] Suspended/pending/rejected gates covered in SQL + Deno admin-auth tests. *(unit/SQL; live admin UI exercise still manual)*
- [ ] An admin has exercised approve/suspend on **staging** with a real session. **OPEN (manual)**
- [ ] Emergency suspension verified on staging public pages. **OPEN (manual)**
- [ ] Admin MFA protects sign-in and payouts (aal2), rolled out without lockout. **OPEN (code PRs, then owner enrolment)**
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
- [ ] Daily reconciliation, ledger backup, alert delivery observed. **OPEN (owner confirmation)** — 2026-10-14: `ledger-backup` and `daily-report` crons succeeded 7/7 days, `cpay-health` runs every 15 min since 2026-10-13, Telegram delivers; the owner still has to confirm the alert channel (H4)
- [x] Owner has runbooks + emergency-stop docs. *(RUNBOOKS, INCIDENT, OPS_OWNER_CUTOVER)*
- [ ] Controlled production rollout planned after ops cutover. **OPEN (owner)**

## High ops from 2026-10-07 (block full GO until closed)

| ID | Item | Status |
|---|---|---|
| H3 | Orphan Edge Functions (`reconcile`, `reseller-digest`, `telegram-report`) | Closed 2026-10-07 (AUDIT) |
| H4 | Telegram alert secrets / outbox | Secrets set and delivering (2026-10-14 evidence in OPS_OWNER_CUTOVER §B); **open until the owner confirms the intended admin group received the 2026-10-13 test alert** |
| Mig | `20261007040000` + `user-withdraw` redeploy | Done (verified 2026-10-14) |
| Stack | PR stack #28→#33 | Merged |

Do not call CPAY production-ready until every unchecked item has a named
owner, documented exception or completed test result.
