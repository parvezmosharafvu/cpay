# Incident response (short)

Full operational procedures live in `docs/RUNBOOKS.md`. This page is the
pager-first index.

1. **Triage** — `health` edge (`?alert=0`), payment-service `/health` + `/ready`,
   Admin → Health. Note time in Asia/Dhaka.
2. **Money at risk?** — Freeze withdrawals / new payments via admin emergency
   stops (server-enforced). Do not delete data.
3. **Stuck `sending` stablecoin** — Do **not** auto-refund cross-chain
   `conversionDetails.status=failed`. Human path in RUNBOOKS.
4. **Double-pay suspicion** — Check withdrawal idempotency key / wallet payment
   id before any manual finalize.
5. **Secrets** — Rotate only with owner; never paste mnemonic, service role, or
   bot token into chat.
6. **Comms** — Owner decides customer messaging; engineers stick to facts in
   audit log / tickets without secrets.

Related: `docs/OPS_OWNER_CUTOVER.md`, `docs/BACKUP-RECOVERY.md`,
`docs/PRODUCTION-READINESS.md`.
