# Auto withdraw and manual withdrawals

"Auto withdraw" is the plain name for the payment modes that already exist
(docs/INSTANT-FORWARD.md). Migration `20261021010000_auto_withdraw.sql`.

| Auto withdraw | Payment mode | What happens after the platform fee |
|---|---|---|
| On | `instant_forward` | The rest is sent by itself to the user's saved receive address: Lightning address, or USDT on a network the wallet swap supports. Existing safeguards stay: minimum (`instant_forward_min_sat`), maximum (`instant_forward_max_usd`), held as `owed` when there is no usable address, USDT grouped below the network minimum. |
| Off | `balance` | The rest is added to the user's balance. The user withdraws by hand from Withdraw. |

## Who decides

- **Global switch:** Admin → Settings → Auto withdraw → Turn on / Turn off.
  `admin_set_auto_withdraw_global(boolean)` sets `payment_mode` through
  `admin_set_platform_setting()`. Active admin at aal2 only; audited
  (`auto_withdraw.global` and `settings.platform`).
- **Per profile:** Admin → Manage users → Auto withdraw on the user's row → Default (follow Settings) /
  On / Off. `admin_set_auto_withdraw(uuid, text)`; active admin at aal2 only; audited
  (`auto_withdraw.profile`). Stored in `auto_withdraw_overrides` (RLS on, no grants: only the
  SECURITY DEFINER functions touch it).
- `payment_mode_for(user)` is the one place that decides per user. The forward trigger
  (`instant_forward_enqueue`), the payment gate (`gate_custodial_payment`), the Lightning and USDT
  workers (`system_forward_claim`, `system_usdt_due`, `system_usdt_batch_create`) and the desk
  (`my_receive_settings`, `get_my_direct_settlement`) read it. `payment_mode = direct` still wins for
  everyone.
- Turning a user (or everyone) **off** moves their waiting forwards (`queued`, `retry`, `owed`, not in a
  USDT batch) into their balance (`released`). A forward already `sending` finishes as it is.

## What the user sees

- Profile → Where to receive: "Auto withdraw: On/Off" (and "set for your account by the admin" for an
  override), plus where payments go.
- Overview: the Withdraw button shows only when the balance is above zero.
- Withdraw: available balance, a note on the Auto withdraw state, destination (Bitcoin · Lightning or
  USDT on a network), amount or **Withdraw all**, a quote with one "You receive" amount and the fee
  breakdown, confirm with a recent sign-in (two-step code or passkey), then the history with status
  (sending / paid / failed) and details. With a zero balance the form is replaced by "Nothing to
  withdraw right now."

## Manual withdrawals

Same path as the USDT withdrawal: `user-withdraw` (`routes` / `quote` / `confirm`, step-up on confirm)
→ the wallet function's `/withdraw/*` → `reserve_*` in SQL → send → `finalize_stablecoin_withdrawal()`.

- **USDT:** unchanged: saved address only, $5 minimum, network limits from the swap route.
- **Lightning (new):** route `lightning:btc`, listed by `user-withdraw` next to the swap routes
  (the wallet's cached route list is unchanged). Destination is the saved, ready Lightning address
  (`lightning_withdraw_destination_ok`) or a Lightning invoice with an amount. $1 minimum. The
  platform wallet pays the routing fee, refused above 1% of the send (at least 10 sats). The
  wallet's own balance is checked before quoting.
- `reserve_lightning_withdrawal()` locks the profile row, checks the emergency stop, account status,
  feature flag, fee, single and daily limits and the balance, and writes one row per quote
  (idempotent). Two confirms cannot spend one balance: `ci/auto_withdraw_test.sql`,
  `ci/auto_withdraw_concurrency_test.sh`, `payment-service/withdraw-lightning.test.mjs`.
- Admin → Payouts lists every withdrawal (Lightning and USDT).

## Deploy order

1. Apply `supabase/migrations/20261021010000_auto_withdraw.sql` (after `20261020090000_locations.sql`).
   Safe with the current site and functions: every existing function keeps its signature, and
   `my_receive_settings()` only gains fields.
2. Deploy the `user-withdraw` Edge Function.
3. Deploy the wallet Edge Function with the new `core/` (Lightning withdrawals). Until then a
   Lightning quote is refused ("That coin and network is not available right now"); USDT
   withdrawals work as before.
4. Deploy the site (`public/`).

If the site goes out before the migration, the admin Auto withdraw buttons fail with "function not
found" and the desk shows Auto withdraw as Off; nothing moves money.

## Turning it on

1. Admin → Settings → Auto withdraw → **Turn on** (two-step sign-in; confirm the prompt).
2. Optional: Admin → Manage users → **Auto withdraw** on a row → On / Off / Default → Save.
3. Users with Auto withdraw on need a saved Lightning or USDT address; `instant_forward_no_address`
   (Settings → Advanced) decides whether payments without one go to the balance or are refused.
