# CPAY solvency evidence — read-only operator snapshot

**Status: NOT A SOLVENCY CERTIFICATE.** Source tooling only, introduced in PR #169 on 2026-10-22. The pooled-wallet solvency release blocker remains **open** until the owner obtains independent reserve evidence, documents pricing/haircuts and reconciles the ledger.

## Purpose and access

Run `ci/solvency_readonly_snapshot.sql` through a trusted, authorized, **read-only** PostgreSQL connection to the correct CPAY Supabase project (verify project ref `riumaeihemgznvgattoc`). Do not publish real customer/treasury financial totals in a public GitHub issue or CI log. The SQL selects aggregate balances only: no account names, seed secrets, addresses, auth tokens, or payment records.

The report's verdict is **always `UNVERIFIED`**: no automated GO/NO-GO decision or production deployment is provided. Running the query does **not** settle, transfer, reserve or withdraw money. GitHub Verify checks the query on disposable test data and verifies that it cannot produce a passing solvency verdict.

## What the query measures

All amounts are point-in-time, from the same database query snapshot:

- **Available claims (USD):** Sum of `greatest(get_balance_for(profile.id).available, 0)` across **all** profiles. Negative account balances cannot offset positive account claims; unexpected negatives are counted separately.
- **Unpaid withdrawal claims (USD):** Requested amounts with statuses other than `paid`, `failed`, and `rejected`, **including a missing or unknown status**. These were already subtracted by `get_balance_for()`, so they are **added back** separately to avoid under-reporting claims. Unknown statuses are counted conservatively.
- **Unsent forward claims (USD):** `payment_forwards.amount_usd` for anything not explicitly `forwarded` or `released`, including unexpected states, so newly introduced statuses cannot silently disappear from the liability floor. Forwarded payments are **not** also counted as member balance, except when explicitly `released`, where the ordinary balance already covers them.
- **Gross minimum of those three claims (USD):** A screening floor, not a certified total liability. Refunds, disputes, unrecorded payments, fees, FX conversion and any liabilities outside those sources require a separate review.
- **Wallet reserve evidence (sats):** `breez_wallet.wallet_status.balance_sat` for **active mainnet wallets** with a nonnegative balance, no reported error, and a sync time within 15 minutes. Non-mainnet wallets are excluded; missing, negative, future-dated, stale or error-marked reports are counted as unverified. Standby/disabled wallets are not counted as readily spendable. Values are database-reported, not an independently verified provider/on-chain reserve.
- **Cross-currency comparison is deliberately omitted.** A satoshi is not a dollar; treating one as the other, using a stale BTC price, assuming fees are zero or treating a wallet status row as independently verified reserves would yield a misleading green result.

## Owner sign-off required before marking solvency complete

1. Reconcile the SQL output to the Admin balance/withdrawal and Instant Forward screens. Investigate any anomaly count or stale wallet, including the status of non-primary wallets and payments in flight.
2. Independently verify each active wallet's funds with the wallet provider and confirm mainnet, current sync, ownership and whether the balance is spendable after network/service fees.
3. Obtain a documented current USD/BTC conversion with a conservative lower-bound rate and enough fee / volatility buffer for outstanding claims. Recheck if rates or balances change; do not reuse an old snapshot.
4. Independently reconcile pending USDT payouts, external forward liabilities, manual adjustments, refunds and disputes; check there are no unseen outflows or missing debts.
5. Have the owner record a dated decision and private, access-controlled evidence in the release register. If assets do not cover all claims after adjustments, keep payout/settlement expansion disabled and initiate the incident runbook.
6. Re-run the snapshot near the separately approved release time. Even a complete snapshot is not a substitute for legal approval, restore readiness, independent admin recovery or end-to-end payout evidence.

**Never mark `docs/RELEASE-BLOCKERS.md` solvency row closed solely because this query ran or because GitHub CI passed.**

## CI verification

The `Migrations apply to an empty database` job in `.github/workflows/verify.yml` runs the snapshot after applying all migrations to a disposable PostgreSQL instance. It validates the JSON shape and requires `verdict == "UNVERIFIED"`, without printing real financial totals. The query is a SELECT-only statement; no production connection is involved.
