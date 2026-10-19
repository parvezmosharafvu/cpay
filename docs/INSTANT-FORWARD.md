# Instant forward: fee deducted, the rest forwarded at once (design)

Status: **owner-approved model (2026-10-20), design for Phase 2.** Supersedes pure direct settlement as
the *target* in [NON-CUSTODIAL-PLAN.md](NON-CUSTODIAL-PLAN.md); direct settlement stays available as
the "Direct (no fee)" mode.

Owner rule: **every payment, the platform fee is deducted, then the rest goes to the user.** No balance
accumulates.

## 1. Flow

```
payer ──pays──► CPAY platform wallet (invoice, as today)
                  │ settle (settle_breez_payment, unchanged) + platform fee stamped (stamp_payment_platform_fee)
                  ▼
        payments row: settled, amount_sat, platform_fee_amount
                  │ trigger (only in payment mode "instant_forward")
                  ▼
        payment_forwards row: queued   (unique payment_id)
                  │ forward worker (wallet function, each 1-minute sync, holds the wallet lease)
                  ▼
        LNURL-pay to the user's saved Lightning address ──► user's own wallet
                  │
                  ▼
        forwarded (sent_sat, routing_fee_sat, payment id) — never part of a CPAY balance
```

1. **Invoice:** unchanged (`create-invoice` → wallet function).
2. **Settle:** unchanged ledger settlement, idempotent per Lightning payment.
3. **Fee:** the existing platform fee configuration (`cpay_platform_fee_percent(user)`: per-account
   `profiles.platform_fee_percent`, else `app_settings.default_platform_fee_percent`). In sats:
   `fee_sat = round(amount_sat × platform_fee_amount / amount_settled)`, `forward_sat = amount_sat − fee_sat`.
   Sats are what the wallet received, so no exchange-rate risk between receive and forward.
4. **Forward:** to the user's newest **active, ready** `settlement_destinations` Lightning address (the
   same verified address flow as direct settlement: provider check, fresh sign-in, 24-hour wait, audited).

## 2. Idempotency (one forward per payment)

- `payment_forwards.payment_id` is **unique**: a payment can never get two forward rows, whatever the
  caller or retry.
- The Lightning send uses the forward id as the wallet library's **idempotency key**, so a retry after a
  crash or timeout returns the first send instead of paying twice.
- A row is claimed with `for update skip locked` and moved to `sending` in the same transaction, and the
  worker only runs while holding the single wallet lease (one instance).
- A row left in `sending` (crash) is resolved by asking the wallet for the payment with that idempotency
  key: found and completed → `forwarded`; found and failed or not found after a completed sync →
  `retry`; pending → wait.

## 3. States

| State | Meaning | Next |
|---|---|---|
| `queued` | Created at settlement | `sending`, `owed` |
| `sending` | Claimed, send in flight | `forwarded`, `retry`, `owed` |
| `retry` | Failed, next attempt at `next_attempt_at` (backoff 1, 2, 4, 8, 16 min…) | `sending`, `owed` |
| `owed` | Held: N failures, no address, over a limit, or below minimum. **Alert** + admin queue. Not in any balance | `sending` (admin retry), `released` |
| `forwarded` | Sent; final | — |
| `released` | Admin moved it to the user's CPAY balance (fallback); final | — |

Enforced by a trigger; tests cover every allowed and refused transition.

## 4. Fees, minimum and dust

- **Routing fee: paid by the user, out of the forward.** The worker prepares the send, reads the routing
  fee, and sends `forward_sat − routing_fee`. If the fee is above `instant_forward_max_fee_pct` (default
  1 %) the attempt is retried later (fees change), then held as `owed`. Any sat left over from
  re-quoting is recorded as `remainder_sat` (CPAY's).
- **Minimum forward:** `instant_forward_min_sat` (default 100 sats). Below it (dust) the row goes to
  `owed` with reason `below_minimum` for the admin (release to balance or forward manually). With the
  $1 invoice minimum this is rare.

## 5. Limits, hot wallet, reconciliation

- **Per-forward max:** `instant_forward_max_usd` (empty = none). Above it → `owed` for admin approval.
- **Hot wallet:** the wallet should only hold fees + owed. The existing admin-send cap and allow-list
  still apply to admin sends; health alerts when the owed total is above zero for more than an hour.
- **Invariant (checked by `instant_forward_invariants()` and in tests):** for every forward row
  `gross_sat = fee_sat + sent_sat + routing_fee_sat + remainder_sat` once forwarded; and over all
  instant-forward payments: **received = fees + forwarded + owed (+ queued/sending/retry in flight)**.
- **Balance:** `get_balance_for()` leaves out payments that have a forward row, except `released`, so a
  forwarded payment is never also spendable on the website.

## 6. Users without an address

Setting `instant_forward_no_address`:
- `balance` (default): payments still work and stay in the CPAY balance (old behaviour) until the user
  adds an address.
- `refuse`: new payments to users without a ready address are refused ("This link isn't taking payments
  right now").

## 7. Payment mode and switches

One setting, **Payment mode**: `balance` (default, today), `instant_forward`, `direct` (no fee; payer
pays the user's wallet directly). Instant forward is ON only when the mode is `instant_forward`.

Becomes unnecessary in normal use (kept under *Advanced* as overrides): `custodial_receive_enabled`,
`custodial_new_links_enabled` (instant forward needs custodial receive), the separate
`direct_settlement_enabled` toggle (Direct mode covers it), `fee_billing_enabled` / subscription fields
(the fee is taken per payment), `custodial_withdraw_enabled` (kept only to wind down old balances).

## 8. Legal

The pages say CPAY briefly receives each payment, deducts a disclosed fee and immediately forwards the
rest to the user's wallet, holds no balances, and that held (`owed`) amounts are paid out or returned.
Counsel should confirm whether brief receipt-and-forward needs a licence where CPAY operates.

## 9. Rollout and rollback

1. Ship DB + worker with the mode at `balance` (nothing changes).
2. Owner: own account adds a Lightning address, waits 24 h, sets mode `instant_forward`, pays $1, checks
   the forward in Admin → Payouts → Instant forwards and in their own wallet.
3. Rollback: set mode back to `balance`. Queued rows stop; owed/retry rows stay visible for the admin.
   No money is lost: unforwarded amounts are owed, and can be released to balance.
