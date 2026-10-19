# CPAY non-custodial plan (Phase 1, design only)

Status: **proposal, not approved, no code changed.** Written 2026-10-19 against `main` a24a0db.
Builds on [NON-CUSTODIAL-ARCHITECTURE.md](NON-CUSTODIAL-ARCHITECTURE.md), which designed and shipped
direct settlement (off). That document explains *how* a direct payment works; this one says *how the
whole product moves to it* and what happens to everything that is custodial today.

Goal: CPAY becomes payment **software**. A payer's money goes straight to a wallet the merchant
controls. CPAY never holds, pools, converts or pays out user or merchant funds. CPAY's only wallet holds
CPAY's own revenue.

## 0. Drift rule: repo vs production vs intended (checked 2026-10-19, read-only)

| Item | Repo (`main` a24a0db) | Production (riumaeihemgznvgattoc) | Intended (this plan) |
|---|---|---|---|
| Migrations | 145, latest `20261018010000_direct_settlement` | 145 applied, same latest | Same, plus the flag migrations in §5 |
| `direct_settlement_enabled` | default `false` | `false` | `true` after gates G1–G6 |
| `direct-invoice`, `settlement-destination` | present | v1 each, deployed 2026-10-18 14:57 +06 | Live, switch on |
| `breez-wallet` function | changed after Oct 13 (#106, #107, #113, #115, #122) | **v21, deployed 2026-10-13 23:28 +06 (older code)** | Redeploy current main once before the wind-down; then CPAY-revenue-only (§4) |
| `direct_payments` / `settlement_destinations` rows | — | 0 / 0 | Growing |
| Payment links by mode | — | 2 custodial, 0 direct | All direct; custodial mode removed |
| Settled custodial payments | — | 5, $77.03 settled, $1.15 platform fees | Frozen history |
| Withdrawals | — | 3 paid ($75.38), none pending | Feature removed |
| Sum of member balances (`get_balance_for`) | — | about **$0.50** available (one account) | $0 before custodial receive is retired |
| Platform wallet | — | about **$21** (owner's figure; owner test deposits + fees) | CPAY's own revenue wallet |
| Auto-withdraw opted in | — | 0 accounts | Feature removed |
| `TURNSTILE_MODE`, `DIRECT_RECONCILE_SECRET`, `DIRECT_PROVIDER_HOSTS` | read from env | **not checkable read-only** (secrets) | Set (G4–G6) |
| `RECEIPT_RECORDING` | env | not checkable read-only; earlier state off | Off; feature removed |

## 1. Inventory: every place CPAY holds or moves user or merchant funds today

| # | Place | Code | Custodial power | Target |
|---|---|---|---|---|
| C1 | Platform Lightning wallet (one pooled wallet, recovery phrase is an Edge secret) | `supabase/functions/breez-wallet`, schema `breez_wallet` | Receives every custodial payment; can send anything | CPAY revenue only (§4) |
| C2 | Custodial receive | `create-invoice` → wallet function; `settle_breez_payment` | Payer pays CPAY's invoice | Off by flag, then removed |
| C3 | Member / org balances | `get_balance_for()`, `payments`, `withdrawals`; desk "held by CPAY" | A claim on CPAY | Read-only history, then retired |
| C4 | Platform fee deducted at settlement | `stamp_payment_platform_fee`, `payments.platform_fee_*`, `profiles.platform_fee_percent` | Only possible because CPAY holds the money | Replaced by billing (§2) |
| C5 | Link cost / markup (`cost_percent`) | links, payer page | Merchant's own markup; custodial today only because the payment is | Unchanged: goes to merchant's wallet on direct links |
| C6 | Freelancer USDT withdraw (quote, confirm, step-up, 24 h wait) | `user-withdraw`, `breez_wallet.withdraw_quotes` | CPAY converts and pays out | Removed: nothing to withdraw |
| C7 | Auto-payout | `system_queue_withdrawal`, `profiles.auto_withdraw_enabled`, `withdraw_threshold` | Queued payouts from CPAY's wallet | Removed (0 opted in) |
| C8 | Admin send from platform wallet | `admin-actions`, `breez_wallet.admin_send_quotes` | Any admin (aal2) can send pooled funds | Limited to CPAY's own revenue, capped (§4) |
| C9 | Receipt recording / receipt reviews | `receipt_reviews`, `RECEIPT_RECORDING` | Credits deposits found in the wallet | Removed |
| C10 | Ledger | `payments`, `withdrawals`, ledger-backup job, financial invariants | Record of custodial money | Kept read-only as history; backups continue |
| C11 | Legacy payout fields on profiles (local-payout and exchange-ID columns) | `profiles.*` | Stored payout destinations for methods CPAY does not run | Drop after export (data minimisation) |
| C12 | Moderator payment marking (`marked_at`, `marked_by`) | `payments` | Admin edits money state | Not applicable to direct payments (proof only); custodial rows frozen |

Not custodial and kept: payment links, stores, direct settlement (`direct-invoice`, `settlement-destination`,
`direct_payments`), CPAY Wallet (`wallet/`, keys on the device), passkeys, MFA, health.

## 2. Platform fee without custody

CPAY never touches the payment, so it cannot deduct anything. Options:

| Option | How | Pros | Cons |
|---|---|---|---|
| F1. Per-payment fee invoice | After each direct payment, CPAY bills the merchant a separate Lightning invoice | Usage-based like today | Merchant pays dozens of tiny invoices; unpaid fees need enforcement; noisy |
| F2. Split at payment time | Payer pays two invoices (merchant + CPAY), or CPAY forwards | Fee collected up front | Two invoices: bad payer UX, Cash App flow breaks; forwarding = custody again. **Rejected** |
| F3. Subscription | Monthly plan, paid in advance by the merchant from their own wallet to a CPAY invoice | Simple, predictable, no custody, no per-payment accounting | Not usage-based; small merchants pay even if idle |
| F4. Monthly usage invoice (F1 batched) | Once a month CPAY sums the merchant's `direct_payments` and issues one invoice, e.g. 1.5 % | Usage-based, one invoice | Needs dunning: unpaid → links paused after a grace period |

**Recommendation:** pilot with **no CPAY fee** (current code), then **F3 subscription with a free tier**
(e.g. first $X/month of direct volume free), optionally adding F4 for high-volume accounts later.
Payment is always merchant → CPAY's revenue wallet by Lightning invoice; non-payment only pauses the
merchant's links, never touches their funds. Rates, tiers and grace period are owner decisions (D3).
Every option needs its own disclosure in the Terms and its own tests before it is built.

## 3. Existing balances (about $21 in the platform wallet)

- Member balances total about **$0.50** (one account); no withdrawals pending; no auto-payouts.
- The rest (about $20.50) is CPAY/owner money: owner test deposits plus $1.15 of fees. It is not owed to
  members, but this must be confirmed by a solvency snapshot first.

Steps (owner-run, nothing by the agent):
1. Snapshot: platform wallet balance vs sum of `get_balance_for` for all accounts; record in
   `docs/RELEASE-BLOCKERS.md`.
2. Freeze custodial receive (flag F-A off, §5) so no balance can grow.
3. Ask each account with a balance > 0 to withdraw it (existing USDT withdraw, kept on only for this
   window) or, if they agree in writing, pay it to their own Lightning address. Deadline 30 days.
4. After the window, unclaimed amounts stay recorded as owed and are paid on request (counsel decides
   escheat rules). The withdraw path stays available for such accounts only.
5. The remainder is CPAY's revenue and stays in CPAY's wallet (§4), or the owner sweeps it to their own
   cold wallet.

## 4. Admin wallet's new role

- The platform wallet becomes **CPAY's own operating/revenue wallet**: receives subscription or fee
  invoices, holds no member money.
- Admin send stays but: hard cap per day (owner value), aal2 required, destination allow-list (owner's
  cold wallet), audited. Spendable = whole wallet once member balances are $0.
- No member-facing feature reads it. Health keeps checking it (lease, sync), but solvency checks retire
  once `sum(get_balance_for) = 0`.
- Longer term option: replace the hosted platform wallet with a simple receive-only revenue address on
  the owner's own wallet, and retire the `breez-wallet` function entirely (fewer secrets, no hot wallet).

## 5. Migration and rollout (behind flags)

New `app_settings` booleans, all changed only through `admin_set_feature_toggle()` (aal2, audited):

| Flag | Default now | Meaning when false |
|---|---|---|
| `direct_settlement_enabled` (exists) | false | No direct invoices |
| F-A `custodial_receive_enabled` (new) | true | `create-invoice` refuses custodial links; payer page "not taking payments" |
| F-B `custodial_new_links_enabled` (new) | true | New links can only be direct |
| F-C `custodial_withdraw_enabled` (new) | true | Withdraw only for accounts with balance > 0 (wind-down window) |
| F-D `fee_billing_enabled` (new, later) | false | No subscription invoices |

Phases:
1. **P0 – prerequisites:** legal pages final (PR for non-custodial terms); redeploy current `breez-wallet`;
   G1–G6 gates of NON-CUSTODIAL-ARCHITECTURE §7 (Turnstile enforce, `DIRECT_PROVIDER_HOSTS`, reconcile
   schedule, one real $1–$5 direct payment).
2. **P1 – pilot:** direct on for one owner account; F-B false for that account only.
3. **P2 – default direct:** switch on for all; F-B false (new links direct only); desk asks every member
   for a Lightning address or offers CPAY Wallet.
4. **P3 – freeze custodial:** F-A false. Balances wind down (§3) with F-C limited.
5. **P4 – remove:** after 30 days with `sum(get_balance_for)=0` (or written exceptions): delete custodial
   receive, withdraw, auto-payout, receipt recording code; migrate `payment_links.settlement_mode`
   default to `direct`; export and drop legacy payout columns; keep `payments`/`withdrawals` read-only.
6. **P5 – billing:** F-D per owner decision on §2.

Tests to add (with each phase's PR):
- Unit: each flag refuses the right paths; `create-invoice` refuses when F-A false; withdraw refuses
  balance-0 accounts when F-C limited.
- DB: flags are JSON booleans; non-aal2 callers cannot toggle; triggers keep direct links out of
  `payments` (exists).
- E2E: new link is direct only; custodial link shows "not taking payments"; direct payment proof flow
  (exists, LNURL mock); member with balance can still withdraw during wind-down.
- Invariant: `sum(get_balance_for)` never increases after F-A false (daily health check + alert).
- Public-copy check: no "held by CPAY" / balance wording once P3 ships.

Rollback: every phase is a flag flip back (immediate). P4 is the only irreversible step; it waits for
owner sign-off and a full ledger export. Direct payments need no money rollback: CPAY never held them.

## 6. Owner decisions needed

1. D1 Approve the target model and phases (and the date for P3 freeze).
2. D2 Approve the wind-down of the ~$0.50 member balance and the treatment of the ~$20.50 remainder
   as CPAY funds (after the solvency snapshot).
3. D3 Fee model: none for the pilot; subscription price, free tier, grace period; F4 rate if any.
4. D4 Allowed providers: `DIRECT_PROVIDER_HOSTS` list for the pilot vs any LUD-21 provider.
5. D5 Admin wallet: daily cap, destination allow-list, or retire it for an owner-held revenue address.
6. D6 Publish CPAY Wallet (release gates) and add Lightning-address registration.
7. D7 Legal: entity name, registered address, governing law, contact addresses (see the legal PR);
   counsel sign-off that a non-custodial model needs no licence where CPAY and its users are.
8. D8 Turnstile enforce, reconcile secret, redeploy of `breez-wallet` (secrets/deploys are owner actions).
