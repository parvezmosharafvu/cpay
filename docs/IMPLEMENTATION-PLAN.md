# CPAY implementation plan (post Chat 1)

**Baseline:** `53bee25` · **Chat 1 branch:** `fix/security/audit-chat1` · **Chat 2 branch:** `feature/ui/design-system-chat2`  
Follow-on chats should start from merged main after prior PRs land (or from the prior tip if merge is blocked).

## Done in Chat 1

1. Full-repo audit from main; architecture/trust map in `docs/AUDIT.md`.
2. Migration `20261007040000_close_manual_payout_residue.sql`: pin search_path on address validators; keep `request_withdrawal` closed; revoke trigger EXECUTE from browser roles.
3. Close manual payout path in `user-withdraw` (410 for non-instant actions).
4. Remove dead freelancer `submitManual` / `request_withdrawal` UI wiring.
5. CI guard `check_manual_payout_closed` in `ci/check_frontend.py`.
6. Audit + this plan checked in.

## Done in Chat 2 — Design system and public journey

1. Refined design tokens (spacing, type, touch, z-index) on `public/cpay.css`.
2. Shared alerts, skeleton loading, payment status timeline, skip links, 320px+ responsive polish.
3. Landing, auth, store, `404.html` payment slug, and invoice public journey improvements (copy/share/QR download/retry/expiry countdown).
4. Theme apply before paint on invoice/store; `color-scheme: light` to avoid flash.
5. Docs public-copy hygiene so `ci/check_public_copy.py` stays green.
6. No backend contract changes; no processor names/secrets; no traditional payout ads; Vanilla only.

## Chat 3 — Freelancer & admin dashboards / roles

**Goal:** Polish authenticated desks without weakening auth/RLS or reintroducing reseller.

1. Freelancer dashboard: links, storefront, payments history, balance, USDT withdraw quote→confirm UX (loading/empty/error, skeleton where useful).
2. Admin desk: accounts approval/suspend, payments, withdrawals, settings/flags, health — clearer hierarchy, tables, filters; preserve server-backed gates.
3. Role home routing (`roleHome`) and suspended/pending gates remain authoritative.
4. Accessibility and 44px targets in desks; no fake balances; never print secrets.
5. Tests: frontend unit + `check_frontend` + any desk smoke available.

## Chat 4 — Ops cutover hygiene

1. With owner approval: delete orphan Edge Functions `reconcile`, `reseller-digest`, `telegram-report`; save source first.
2. Set `ALERT_TELEGRAM_BOT_TOKEN` and `ALERT_TELEGRAM_CHAT_ID` (or mark stale outbox skipped).
3. Apply `20261007040000` on production; redeploy `user-withdraw`.
4. Confirm `RECEIPT_RECORDING` remains unset/`off` on Azure payment-service host.
5. Update `docs/AUDIT.md` H3/H4 to closed with evidence timestamps (Asia/Dhaka).

## Chat 5 — Staging money path + production rollout

1. Staging create-invoice → settle → balance → USDT quote/confirm (small amount).
2. Idempotency, suspended gates, emergency stops.
3. Fill `docs/PRODUCTION-READINESS.md`; backup; controlled live send.

## Non-goals (all chats)

- Fake production credentials or simulated balances in prod code.
- Traditional local-rail / exchange **payout** product surfaces, or Lightning **payout** product surfaces.
- Turning `RECEIPT_RECORDING` on without a separate owner decision (default stays **off**).
- Reintroducing reseller commission or reseller role.
- Migrating frontend off Vanilla HTML/CSS/JS.
- Deleting orphan edge functions or setting Telegram secrets without owner ops approval.
- Changing Azure production wallet.
