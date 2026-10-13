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

## Legal pages release gate

Before a public launch run `python3 ci/check_legal.py --release`. It exits non-zero while any of terms/privacy/refund/contact still contains DRAFT, TODO or `[placeholder]` text. Every PR runs the non-release mode, which only requires draft pages to stay `noindex` and unlinked. Legal approval is an owner task.

## Release gate

`node scripts/release-gate.mjs` must print RELEASE GATE PASSED before a production release. It refuses when the SHA is not origin/main, Verify is not green for it, the site deploy (Workers Builds) did not succeed for it, the latest restore drill failed or is over 90 days old, docs/RELEASE-BLOCKERS.md has an open Critical/High row, or legal pages are still drafts. The wallet deploy script in scripts/ refuses to deploy a SHA that is not origin/main with a green Verify run (override only for a documented rollback).
