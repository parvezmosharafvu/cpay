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
   same verified address flow as direct settlement: provider check, fresh sign-in, audited, inbox notice; usable at once with an authenticator, otherwise after 24 hours, see section 13).

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
2. Owner: own account (authenticator on) adds a Lightning address (fresh sign-in, works at once), sets mode `instant_forward`, pays $1, checks
   the forward in Admin → Payouts → Instant forwards and in their own wallet.
3. Rollback: set mode back to `balance`. Queued rows stop; owed/retry rows stay visible for the admin,
   who can **Hold** waiting rows (Admin → Instant forwards) and then move them to the balance.
   No money is lost: unforwarded amounts are owed, and can be released to balance.

## 10. Addresses work at once (20261020040000; narrowed by section 13)

The 24-hour wait on a newly saved Lightning or USDT address is gone. Instead,
saving, changing or removing one needs the payout step-up: a fresh first
factor (password, passkey or provider sign-in within 10 minutes), plus aal2
when the account has a verified second factor. Every change is audited
(`payout_wallet.saved`, settlement destination events) and the user gets a
"Security notice" message in their inbox. Rows saved before the change that
still had a future `usable_after`/`ready_at` keep it. An admin setting a
user's USDT address (`admin_set_user_usdt_wallet`) also needs the admin's
fresh sign-in.

## 11. USDT instant forward (20261020050000, worker in forward.mjs)

- No choice to make (20261020080000): saving an address is enough.
  `receive_target_for(user)` picks, in order: an explicit pick still in
  `receive_settings` (older accounts; `set_my_receive_method` remains), the
  saved Lightning address, then a usable USDT address (preferred network
  first, then the newest). Address cooldowns still apply. The enqueue
  trigger, the 'refuse' gate and `my_receive_settings()` all use it; Profile
  only shows where the next payment goes.
- On settlement the forward row gets `kind = 'usdt'` and the network. The
  Lightning minimum (`instant_forward_min_sat`) does not apply to USDT.
- Accumulation: queued USDT rows per user+network are summed. Below the
  route's provider minimum (+2% headroom, valued at the current BTC/USD rate)
  they stay queued with reason `accumulating`; the admin alert
  `forward_accumulating` fires when a group waits over 3 days.
- At or above it, `system_usdt_batch_create` opens one `forward_batches` row
  (unique open batch per user+network) and attaches the rows. The batch id is
  the wallet's idempotency key. The address is re-validated for the network,
  the quote (fees included) is prepared right before sending; an expired quote
  or any refusal before money left marks the batch failed and the rows retry
  with backoff under a new batch, then `owed` after max attempts.
- A lost reply leaves the batch `sending`; it is settled from the wallet's
  record (find by batch id). It is sent again under a new batch only after a
  completed sync, when this worker is not sending it, and once the recorded
  quote expiry (`quote_expires_at`, saved before the send) plus 10 minutes
  has passed, the same rule as stablecoin withdrawals (section 13). An address
  the wallet rejects holds the rows as `owed` (`invalid_address`).
- Per-row `sent_sat = forward_sat`; the USDT received and the network fee are
  on the batch and shown in the admin forwards list.

## 12. Fee simplification

Before: payment platform fee (`platform_fee_percent` / default) on every
payment, plus a separate withdrawal platform fee
(`default_withdrawal_fee_percent`, per-account override via
`resolve_withdrawal_fee`) shown as its own line on the withdraw form, plus the
network fee line.

Now: the user sees one "You receive" figure; platform and network fees are
under "Fee details". The admin keeps the platform fee %. The network fee is
automatic. The withdrawal fee setting stays, labelled "Balance mode only": it
applies only to USDT withdrawals from a CPAY balance and never to instant
forwards. Nothing in the database fee logic changed.

## 13. Forward and payout-address safety (20261020060000)

- **No second USDT payment.** Before, a batch whose send had an unknown
  outcome (lost reply, nothing in the wallet yet) was retried under a new
  batch id after 2 minutes, while the first send could still complete: the
  user could be paid twice. Now the quote expiry is stored before the send
  (`system_usdt_batch_quoted`) and a new batch is only made as described in
  section 11. A send with no error and no payment stays `sending`.
- **Lightning:** if the wallet cannot be asked about a send after an error,
  the row stays `sending` and the recovery step decides after a sync. Retries
  always reuse the forward id, which the wallet refuses to pay twice.
- **Payout addresses need an authenticator to work at once.** A new or
  changed USDT or Lightning address is used at once only when the account
  has a verified authenticator (`payout_ready_at`). Otherwise it is used 24
  hours later and, for Lightning, the address in use keeps receiving until
  then. Reason: a stolen password alone always passes the fresh sign-in check.
- **Security notices stay visible.** The inbox message about a payout change
  says when the address starts being used and cannot be hidden by the account
  (`support_messages.security_notice`). Email notices are not sent yet
  (only sign-in emails exist): owner follow-up.
- **Admin:** `admin_forward_action(id, 'hold')` holds a waiting (queued or
  retry) forward, e.g. after switching the mode off. `admin_forward_batch_action(id,
  'delivered', ref)` or `(id, 'hold')` closes a USDT batch stuck in `sending`
  for over an hour, after checking the provider and the chain. Release held
  rows of a stuck batch only once the provider shows the order failed or was
  refunded. Both need an active admin at aal2 and are audited. Stuck batches are
  listed in Admin → Instant forwards with "It arrived" and "Hold for review".
- `'refuse'` mode also accepts a payment for an account whose receive choice
  is a usable USDT address. Batches are made only for active accounts.
