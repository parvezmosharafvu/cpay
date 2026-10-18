# Payment states and transitions

`payments.status` (check constraint since 0001): `new`, `pending`, `settled`, `expired`, `invalid`.
Pinned by `ci/payment_transitions_test.sql`. Documented as of main c6ec4a4 (2026-10-13).

## States

| State | Meaning | Payment page | Counts toward balance |
|---|---|---|---|
| `new` | Row created by create-invoice; Lightning invoice attached once (`attachInvoice`, only while `new` with no invoice) | Waiting (timeline) | no |
| `pending` | Legacy "detected" state. No current writer sets it; still read (page shows Detected) | Detected | no |
| `settled` | Paid. `amount_settled`, `settled_at` set | Paid | yes |
| `expired` | Invoice expired unpaid | Expired (late payment still settles) | no |
| `invalid` | Admin marked it failed/void | Failed | no |

## Transitions by writer (production code)

| From → To | Writer | Guard |
|---|---|---|
| (insert) → `new` | create-invoice Edge Function | idempotent per (link, client_request_id) |
| `new` → `expired` | wallet sync `expireUnpaid` (ledger.mjs) | `status='new' and amount_sat is not null and expires_at < now()` |
| `new`/`pending`/`expired` → `settled` | `settle_breez_payment()` (service role) | one per wallet payment id (webhook_events), received sat ≥ invoiced sat |
| any non-settled → `settled`/`expired`/`invalid` | `admin_mark_payment()` (active admin or service role) | refuses a settled payment; settled amount ≤ 102% of requested; audited |

Never: `settled` → anything through any production writer; anything → `new`; `invalid` → `settled` through settlement (admin only).

## Enforcement (trigger, 20261013090000)

Owner decision 2026-10-13: only an admin may reverse a settled payment. `payments_status_transition` (BEFORE UPDATE OF status) raises on any status change outside this table; same-status updates are no-ops and always pass.

| From → To | Who |
|---|---|
| `new` → `pending`/`expired`/`settled`/`invalid` | any writer |
| `pending` → `expired`/`settled`/`invalid` | any writer |
| `expired` → `settled` (late payment) / `invalid` | any writer |
| `settled` → `invalid` (reversal) | admin only |
| `invalid` → `settled`/`expired` (re-settle / undo) | admin only |
| anything else (→ `new`, → `pending` from non-new, `settled` → `new`/`pending`/`expired`) | nobody (check_violation) |

Admin means `is_admin()` (active admin JWT) or a server-side role (not anon/authenticated) that ran `set_config('cpay.payment_admin_context', 'on', true)` in the same transaction. Non-admin attempts fail with insufficient_privilege. `admin_mark_payment()` is unchanged and still refuses settled payments; a reversal is a deliberate admin action, never a settlement-path side effect. Settlement (`settle_breez_payment`: new/pending/expired → settled, duplicate and already-settled no-ops), the expiry loop (new → expired) and late payment are all inside the always-allowed set; `ci/payment_transitions_test.sql` runs them with the trigger active.

## Direct payments (`direct_payments.status`, 20261018010000)

Payments that go straight to a Freelancer's own wallet. A separate table: never
counted in a balance. Pinned by `ci/direct_settlement_test.sql`.

| From → To | Writer | Guard |
|---|---|---|
| (insert) → `pending` | direct-invoice Edge Function | idempotent per (link, client_request_id); unique payment hash |
| `pending`/`expired` → `paid` | `system_record_direct_payment_proof()` (service role) | CHECK: the preimage's SHA-256 equals the payment hash; idempotent |
| `pending` → `expired` | `system_expire_direct_payment()` | only after `expires_at` (+ grace); trigger refuses earlier |

Never: `paid` → anything (trigger); `expired` → `pending`; any change to the
invoice details; deleting a row.
