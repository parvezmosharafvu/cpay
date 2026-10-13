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

## Why there is no DB trigger yet

A trigger that forbids `settled` → other states would match every production writer above. It was deliberately not added because existing regression tests (`ci/telegram_test.sql`) model an admin marking a settled payment invalid and settling it again, and a trigger on the money table that raises inside `settle_breez_payment()` would turn an unexpected edge case into a failed settlement. Enforcement needs an owner decision on reversals first. Until then the transitions are pinned by tests, not enforced.
