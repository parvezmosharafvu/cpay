# Financial invariants (audit P4)

Every invariant is proven by a test that runs in CI against a fully migrated
database ("Payment service against the migrated database" step, `npm test`).

| Invariant | Test |
|---|---|
| Duplicate settlement credits once (8 concurrent sessions, replayed and new provider payment ids) | `payment-service/invariants.test.mjs` |
| Replayed settlement credits nothing | `payment-service/ledger.test.mjs`, `ci/financial_invariants_test.sql` |
| Concurrent invoice creation returns one effective invoice | `payment-service/service.test.mjs` "concurrent invoice requests…", `ci/invoice_idempotency_test.sql` |
| Concurrent withdrawal confirm reserves once | `invariants.test.mjs` (5 sessions, one quote), `withdraw.test.mjs` "confirming the same quote twice at once", "two database sessions reserving the same quote" |
| Available balance never negative | `balance-guard.test.mjs` (concurrent raw inserts and reservations), `invariants.test.mjs` |
| Creator credit + platform fee = settled amount, whole cents | `invariants.test.mjs` (fees 0, 2.5, 7, 10, 12.345 %) |
| Expired quote cannot reserve | `invariants.test.mjs`; `withdraw.test.mjs` "an expired quote is re-quoted at confirm" |
| Failed-before-transfer refunds exactly once | `withdraw.test.mjs` "a send that fails before any transfer…", "crash before any transfer…" |
| Uncertain external sends never auto-refund | `withdraw.test.mjs` "a swap that fails without a refund stays sending", "crash mid-send…", "an ambiguous error with a transfer on record…" |
| Persisted USD is exact (integer cents / numeric) | `ci/money_types_test.sql`, `money.test.mjs`, `withdraw.test.mjs` splitFee sweep |
| Another creator cannot read or change my financial rows | `invariants.test.mjs` (RLS, with an owner positive control), `ci/authenticated_rpc_sweep_test.sql` |
| Public invoice lookup returns only allowlisted fields | `invariants.test.mjs` (`get_invoice_public`, `lookup_payment_status` column sets as anon), `ci/public_exposure_test.sql` |
| A direct payment is paid only with a preimage that hashes to its payment hash; paid is final | `ci/direct_settlement_test.sql`, `supabase/functions/direct-invoice/handler_test.ts`, `tests/e2e/direct-settlement.spec.ts` |
| Direct payments never change a CPAY balance, and a direct link never creates a custodial payment | `ci/direct_settlement_test.sql` (balance compared before/after; payments insert refused), `tests/e2e/direct-settlement.spec.ts` |
