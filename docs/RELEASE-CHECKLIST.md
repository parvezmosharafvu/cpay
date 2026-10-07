# CPAY release checklist (Chat 5)

Stack tip at release packaging time: branch `release/chat5-qa` from Chat 4 tip.
**main is not updated until the PR stack merges.** Do not pretend otherwise.

## Pre-merge (code)

- [ ] `python3 ci/check_frontend.py` and `ci/check_public_copy.py` pass
- [ ] `node --test tests/frontend/*.mjs` pass
- [ ] `npm run build` pass
- [ ] payment-service `npm test` against migrated DB pass (claim only if run)
- [ ] `ci/financial_invariants_test.sql` pass
- [ ] Deno edge tests pass (CI Deno 1.x or local `--no-check` on Deno 2.9+)
- [ ] Public Playwright smoke pass (static)
- [ ] No verified Critical/High **code** issues open in `docs/AUDIT.md`
- [ ] `RECEIPT_RECORDING` default remains off in config tests
- [ ] Reseller commission/role absent (frontend + SQL guards)

## Deploy order (when cutting a release)

1. **DB** — apply pending migrations forward-only (incl. `20261007040000` if not yet).
2. **Edge** — redeploy changed functions (`user-withdraw` at minimum after Chat 1).
3. **payment-service** — roll host; watch `{"event":"catch-up"}` then
   `{"event":"listening"}`; `GET /health` 200; `GET /ready` 200.
4. **Static** — Cloudflare Workers assets / Pages for `public/`.
5. **Verify** — health edge with `alert=0`; Admin → Health; sample invoice
   create (no forced settle if not approved).

## Rollback notes

- Migrations: forward-only. Prefer compensating migration; do not edit applied files.
- Edge: redeploy previous artifact from git tag.
- payment-service: previous image/binary; keep `BREEZ_DATA_DIR`; mnemonic restores wallet if data dir lost.
- Static: previous Workers deployment.

## Monitoring after cut

- `GET /health`, `GET /ready`, bearer `GET /metrics` on payment-service
- Supabase `health` edge (`x-cron-secret`, `?alert=0`)
- Stuck `sending` withdrawals > 30 min (health already alerts)
- Telegram outbox pending count (if secrets configured)

## Owner ops still required for full GO

See `docs/OPS_OWNER_CUTOVER.md` and `docs/PRODUCTION-READINESS.md`. Open High
**ops** (orphans, Telegram, prod migrate) ⇒ **CONDITIONAL GO** at best.
