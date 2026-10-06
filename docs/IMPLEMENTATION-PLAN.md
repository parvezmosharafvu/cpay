# CPAY implementation plan (post Chat 1)

**Baseline:** `53bee25` · **Chat 1 branch:** `fix/security/audit-chat1`  
Follow-on chats should start from merged main after this PR, not from stale trees.

## Done in Chat 1

1. Full-repo audit from main; architecture/trust map in `docs/AUDIT.md`.
2. Migration `20261007040000_close_manual_payout_residue.sql`: pin search_path on address validators; keep `request_withdrawal` closed; revoke trigger EXECUTE from browser roles.
3. Close manual payout path in `user-withdraw` (410 for non-instant actions).
4. Remove dead freelancer `submitManual` / `request_withdrawal` UI wiring.
5. CI guard `check_manual_payout_closed` in `ci/check_frontend.py`.
6. Audit + this plan checked in.

## Chat 2 — Ops cutover hygiene (recommended next)

**Goal:** Clear production drift that blocks a calm go-live. No product rewrite.

1. With owner approval: delete orphan Edge Functions `reconcile`, `reseller-digest`, `telegram-report`; save source first (already noted in OPS_DRIFT).
2. Set `ALERT_TELEGRAM_BOT_TOKEN` and `ALERT_TELEGRAM_CHAT_ID` (or mark stale outbox skipped) and confirm telegram-notify 503 rate drops to ~0.
3. Apply `20261007040000` on production; redeploy `user-withdraw` (+ admin-actions if drift).
4. Run live `scripts/check_edge_function_drift.py` with `--allow` empty after deletes; update `ci/fixtures/deployed_functions_*.json`.
5. Confirm `RECEIPT_RECORDING` remains unset/`off` on Azure payment-service host.
6. Update `docs/AUDIT.md` H3/H4 to closed with evidence timestamps (Asia/Dhaka).

**Out of scope for Chat 2:** Azure VM rebuild, GCP work, frontend framework, enabling receipt recording, Lightning payout, traditional payout ads.

## Chat 3 — Staging money path sign-off

1. Staging create-invoice → settle → balance → USDT quote/confirm (small amount).
2. Idempotency: duplicate settle / duplicate confirm.
3. Suspended/pending account cannot create links or withdraw.
4. Emergency stops (payments + withdrawals).
5. Fill `docs/PRODUCTION-READINESS.md` checkboxes with evidence links.

## Chat 4 — Hardening / cleanup (optional)

1. Drop unused historical wallet columns only after confirming no rows and no admin tools need them (historical `wallet_*` traditional-rail columns) — or leave forever.
2. Narrow admin `process-withdrawal` once no non-stablecoin pending rows remain.
3. Fix verify.yml “private repo” hygiene wording for public repo.
4. Node 22 alignment in any local/dev docs.

## Chat 5 — Production rollout

1. Backup / snapshot.
2. Migrate + deploy edge + payment-service image (includes money.mjs/receipts.mjs from PR #27).
3. Controlled small live payment + USDT withdraw.
4. Watch health, telegram, ledger-backup.

## Non-goals (all chats)

- Fake production credentials or simulated balances in prod code.
- Traditional local-rail / exchange **payout** product surfaces, or Lightning **payout** product surfaces.
- Turning `RECEIPT_RECORDING` on without a separate owner decision (default stays **off**).
- Reintroducing reseller commission or reseller role.
- Migrating frontend off Vanilla HTML/CSS/JS.
