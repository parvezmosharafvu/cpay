# Non-custodial CPAY: audit, options, decision and plan (2026-10-18)

> **Historical document.** It describes a superseded design. The current system is in
> [SYSTEM-OVERVIEW.md](SYSTEM-OVERVIEW.md) and [../AGENTS.md](../AGENTS.md); where they disagree, they win.

Status:

| Part | State |
|---|---|
| Website receive, balance and USDT payout | **Custodial, live.** CPAY holds the wallet keys and the merchant's balance is a ledger entry. The website says so ("held by CPAY") |
| Direct settlement (payer pays the merchant's own wallet) | **Built, tested, off** (`app_settings.direct_settlement_enabled = false`, migration `20261018010000`). Nothing changes for anyone until the owner turns it on |
| CPAY Wallet (`wallet/`) | Self-custodial phone wallet, **not published** (release gates G1–G8 open) |

CPAY must not be described as non-custodial while the custodial path takes payments. With direct
settlement on, the accurate statement is narrower: **"Payments on direct links go straight to your own
wallet; CPAY never holds them."**

Related: [ARCHITECTURE.md](ARCHITECTURE.md),
[WALLET-APP.md](WALLET-APP.md), [LEGAL-NOTES.md](LEGAL-NOTES.md).

## 1. Current-state audit (main 2e6c9d8, 2026-10-17)

Read from the code and migrations, not from older reports.

| Flow | Who controls the money | Code | Finding |
|---|---|---|---|
| Receive | CPAY: the invoice belongs to the one platform wallet; its recovery phrase is an Edge Function secret | `create-invoice` → the wallet Edge Function (same core as `payment-service/`) | Custodial by design. Pooled: every merchant's money is in one wallet |
| Settlement | CPAY ledger (`settle_breez_payment`) | `payment-service/ledger.mjs`, SQL | Idempotent and audited ([FINANCIAL-INVARIANTS.md](FINANCIAL-INVARIANTS.md)). A ledger credit, not a wallet the merchant controls |
| Balance | Computed from the ledger (`get_balance_for`) | SQL | A claim on CPAY, not spendable funds the merchant holds. The website labels it "held by CPAY" |
| Platform fee | Deducted at settlement | `stamp_payment_platform_fee` | Only possible because CPAY holds the money |
| USDT payout | CPAY's wallet sends after quote/confirm, step-up, 24 h address wait | `user-withdraw`, `withdraw.mjs` | The per-withdrawal check is the wallet's own balance; there is no check that the pooled wallet covers every ledger balance (solvency). Owner item, see §7 |
| Auto-payout | Queued by `system_queue_withdrawal` when a merchant-set threshold is reached | SQL | Merchant opt-in; authorised |
| Admin wallet sends | An active admin (aal2 when required) can send from the platform wallet | `admin-actions` | A custodial power. Guarded by "spendable = wallet − owed" and audited, but it exists |
| CPAY Wallet | The member: keys made and kept on the phone, Spark operators co-sign | `wallet/` | Self-custodial with Spark's trust assumptions (§3B). Not published |

Defects found and fixed in this change:

| # | Finding | Fix |
|---|---|---|
| D1 | CPAY Wallet said "The payment failed. Nothing was sent." on **any** send error, including a timeout after the payment went out | The idempotency key is chosen once per prepared payment; after an error the app asks the library for that payment and reports in progress / failed / not on record. "Try again safely" re-sends the same prepared payment, which the library answers with the first attempt's payment instead of paying twice. Tested in `tests/wallet/wallet.spec.ts` |
| D2 | Restoring a recovery phrase on a phone that already had a wallet deleted that wallet's local copy without warning | Restoring a **different** phrase needs a tick box and typing REPLACE; the same phrase (forgotten passphrase) needs nothing. Tested |
| D3 | The wallet's exit-backup text read as if the backup alone could move money to the Bitcoin blockchain | Reworded; the security page lists what an exit needs (on-chain fees, time, an exit tool this version does not have) |
| D4 | No backup status in the wallet | Shown in Security: checked at creation, or restored from the phrase |
| D5 | Public store fallback name was "CPAY creator" (a role word) | "CPAY member" (migration `20261018010000`) |

Already known and still open (not changed here): Turnstile off unless enforced; the Worker's client-IP
header is not signed; one `CRON_SECRET` shared by six functions ([RELEASE-BLOCKERS.md](RELEASE-BLOCKERS.md)).
Direct settlement's reconcile sweep uses its own secret (`DIRECT_RECONCILE_SECRET`) and does not add to
the shared one.

## 2. What "non-custodial" has to mean here

A flow is non-custodial only if all of these hold:

1. The payer's money arrives in a wallet whose keys CPAY does not have.
2. CPAY cannot sign, redirect or claw back a payment that has been made.
3. CPAY's records are records: no CPAY number stands in for spendable funds.
4. The merchant can keep receiving and spending without CPAY (exit), to the extent their wallet allows.

What CPAY can still do in a non-custodial flow, and must say so: choose which invoice to show the payer
(so a compromised CPAY could redirect **future** payments), stop a link taking payments, and keep records.

## 3. Options

### A. Direct to a merchant-controlled Lightning address (LUD-16 + LUD-21)

The merchant gives CPAY a Lightning address. For each payment CPAY asks that address's server for an
invoice of the exact amount (LUD-06), checks it, shows it to the payer, and asks the server's LUD-21
`verify` URL whether it was paid. "Paid" needs the preimage, whose SHA-256 must equal the invoice's
payment hash. That binds the provider's confirmation to this exact invoice, so a confused or replayed
answer cannot mark it paid. It is still the provider's statement (the payee side knows the preimage from
the moment it makes the invoice), not CPAY seeing the payment itself.

- **Custody:** the payment goes from the payer's wallet to the merchant's wallet provider. CPAY never
  holds it and has no key for it.
- **Trust:** the merchant trusts their own wallet provider (which may itself be custodial, the merchant's
  choice). The payer and merchant trust CPAY to show the right invoice.
- **Availability:** works while the merchant's provider answers. CPAY's own wallet engine is not needed.
- **Exit:** the merchant's money never depended on CPAY.
- **Limits:** only providers that offer LUD-21 can be used (CPAY needs a way to confirm). Verified in the
  source of the wallet library vendor's own Lightning-address server at the pinned version 0.26.0: it
  returns `verify` and answers `{status, settled, preimage, pr}`. Other providers are checked live when the
  merchant adds the address.
- **Fees:** CPAY receives nothing from the payment, so it cannot deduct a fee. Any fee must be billed
  separately (owner decision §6).
- **Repo support:** built here (§4).

### B. CPAY Wallet (self-custodial, Spark) as the merchant's wallet

The member runs CPAY Wallet; payments go to its keys. Combined with A by giving the wallet a Lightning
address.

- **Trust assumptions** (from the library's configuration and Spark's design): transfers are co-signed by
  2 of 3 Spark operators (FROST); safety relies on at least one operator deleting old key shares; Lightning
  goes through a Spark service provider; a Lightning address needs the vendor's address server; the
  vendor's API key identifies the app.
- **Operator powers:** operators cannot move funds without the user's key; they can stop co-signing
  (payments stop).
- **Unilateral exit:** the library implements it (`prepareUnilateralExit`, `unilateralExit`,
  `checkUnilateralExit`) but it needs a fresh exit state, on-chain bitcoin for CPFP fees and a PSBT signer,
  and waits for timelocks. **CPAY Wallet has no exit button yet**; only the exit backup.
- **Repo support:** wallet built and tested on regtest; not published; no Lightning-address registration
  (the library has `registerLightningAddress`, but the wallet's CSP blocks the address server today).

### C. Merchant's own payment server (self-hosted BTCPay or similar)

CPAY creates invoices on the merchant's server with a key that can only create and read invoices, and
learns payments from HMAC-signed webhooks. Non-custodial when the merchant's server pays into the
merchant's own wallet.

- **Trust:** the merchant runs a server. CPAY holds an invoice-only key (not a spending key).
- **Effort:** high for a freelancer; suits businesses.
- **Repo support:** design only (the old design note was removed 2026-10-21). The provider
  interface in `_shared/direct-settlement.ts` is where it would plug in.

### D. Hybrid during the move

Direct settlement is the default for new links once it is on; the existing CPAY balance stays as a
separately named, per-link, opt-in choice ("My CPAY balance, held by CPAY") until the owner
decides its future. The two never mix: direct payments are not in any balance, and a direct link can never
create a custodial payment (database trigger).

### Comparison

| | A. Lightning address | B. CPAY Wallet | C. Own server | D. Hybrid |
|---|---|---|---|---|
| CPAY holds funds | No | No | No | Yes, on custodial links only |
| CPAY can redirect future payments | Yes, by showing another invoice (mitigated §5) | Same as A when used with A | Same | Same, plus full control on custodial links |
| Merchant needs | A wallet with a LUD-21 Lightning address | CPAY Wallet (not published) | A server | Either |
| Payment proof | Preimage (LUD-21) | Preimage | Signed webhook | Mixed |
| Works without CPAY's wallet engine | Yes | Yes | Yes | Custodial part: no |
| USDT payouts | No (sats arrive in the merchant's wallet) | Wallet's own features | Merchant's | Custodial links only |
| Ready in this repo | Yes, off | Wallet yes, address no | No | Yes |
| Exit | Not dependent on CPAY | Library supports; app lacks button | Merchant's | Custodial part: none |

## 4. Recommendation and what was built

**Default: A**, behind the switch. **B** is the recommended self-custodial wallet for members once it
is published and can register a Lightning address. **C** is a later connector for businesses. **D** for
the transition: the CPAY balance stays opt-in per link, clearly labelled, until the owner decides.

```
payer's wallet ──pays──► merchant's wallet provider ──► merchant's wallet
      ▲                         ▲            │
      │ invoice (QR)            │ LNURL-pay   │ LUD-21 verify: settled + preimage
      │                         │ (amount)    ▼
   CPAY payment page ◄──── direct-invoice Edge Function ───► direct_payments (record only)
                                             │
                                  checks: amount, description hash,
                                  network, expiry; sha256(preimage) = hash
```

Built (migration `20261018010000`, Edge Functions `direct-invoice` and `settlement-destination`):

| Piece | What it does |
|---|---|
| `settlement_destinations` | The merchant's Lightning address. Saved only by the `settlement-destination` function after it got a real, unpaid test invoice and a working LUD-21 answer from the provider, and after a **fresh sign-in** (same step-up as payouts). Used **24 hours** after saving. Rows cannot be edited or deleted, only replaced or removed. Audited |
| `payment_links.settlement_mode` | `custodial` (default) or `direct`. Changed **only by the link's owner** (`set_link_settlement_mode`), and to `direct` only once the address is in use; admins and the service role are refused by a trigger |
| `direct_payments` | The record of each direct invoice: amount, sats, rate and its sources, invoice, payment hash, verify URL, status. A CHECK constraint makes `paid` impossible without a preimage that hashes to the payment hash. `paid` is final; `pending → expired` only after the invoice expires; late proof still counts. Never read by `get_balance_for()`, withdrawals or fees |
| Payments guard | A `payments` row can never be created for a direct link, whatever the caller |
| `direct-invoice` | Public (payers have no account), like `create-invoice`: operator stop, switch, Turnstile required (no new invoice unless `TURNSTILE_MODE=enforce`), per-address, per-link and per-owner limits, request-id idempotency. Prices from public exchange tickers: at least two that agree within 2 %, else no invoice. Status reads ask the provider at most once every 3 s per payment however many pages poll. `reconcile` sweeps open payments with its own secret |
| Provider client | https only, port 443; no IP literals or internal names; every request needs a DNS answer whose A/AAAA addresses are all public (private, loopback, link-local, CGNAT, reserved, IPv4-mapped and NAT64 forms refused), and **fails closed** when DNS cannot be checked; optional owner list of provider hosts (`DIRECT_PROVIDER_HOSTS`, exact names); no redirects; 8 s timeout; 64 KB cap; strict shape checks; provider text never shown to payers |
| Desk | "Get paid straight to your own wallet" card (check, save, remove), "Payments go to" per link, new-link choice, a separate Direct payments list. Hidden while the switch is off |
| Payer pages | Say where the money goes ("Goes straight to … own wallet (address). CPAY does not hold this payment."), show "This link isn't taking payments right now" when the merchant has no usable address, and put the proof of payment on the receipt |
| Admin | The switch (turning on needs aal2; a signed-in direct write of the setting is refused by a trigger, so it can only change through the audited toggle); `admin_set_direct_settlement_blocked` stops an account's direct links (never redirects them); `admin_list_direct_payments` |

Payment states (direct):

| State | Meaning | Page shows |
|---|---|---|
| `pending` | Invoice shown; no proof yet | Waiting |
| `paid` | The merchant's provider confirmed it with a preimage, and `sha256(preimage) = payment_hash`. Final | Payment received, with the proof |
| `expired` | No proof by `expires_at` + 10 min. Becomes `paid` if proof arrives later (checked for 7 days) | Expired (late payment still counts) |

## 5. Threat model (direct settlement)

| Threat | Mitigation | What remains |
|---|---|---|
| Someone with a merchant's session sets their own address | Fresh sign-in (password/passkey/Google, plus the code when an authenticator is set up) to save or remove; 24 h before it is used; audit log; the desk shows "waiting" with the time | An attacker who knows the password and passes two-step sign-in. Recommend e-mail notification of address changes (not built) |
| CPAY (or someone who controls CPAY's servers or database) points future invoices elsewhere | Audit log; the payer sees the destination address on the page; the merchant sees every payment in their own wallet and can compare | This is the irreducible trust in an invoice-showing service. It cannot touch money already paid |
| A provider sends an invoice for another amount, purpose or network, or one about to expire | Refused before the payer sees it | — |
| A provider says "paid" falsely | Paid only with the preimage that matches this invoice; checked again by the database CHECK; an answer for another invoice is refused | The merchant's own provider knows the preimage from the start, so it could claim "paid" for an invoice nobody paid: that misleads only its own merchant's records, and the payer's own wallet shows whether they paid. A custodial provider that receives but never credits the merchant: the merchant's choice of provider |
| Server-side request forgery through a crafted address | §4 provider client rules. The open-source Supabase Edge runtime gives functions unrestricted outbound network access and does offer `Deno.resolveDns` (checked in its source, `ext/runtime/js/denoOverrides.js` and `crates/base/src/runtime/permissions.rs`); whether the hosted platform also filters private destinations is not documented, so CPAY does not rely on it | DNS rebinding between the check and the connection: the connection can only go to port 443 and TLS is verified against the merchant's host name, so no HTTP request is sent unless that server holds a valid certificate for it. Left: a TCP/TLS connection attempt to port 443 of an address chosen by the attacker. Closed completely by `DIRECT_PROVIDER_HOSTS` |
| Payer's browser claims "paid" | Status only from the server's check | — |
| Duplicate, replayed or out-of-order events | Unique payment hash; one invoice per (link, request id); proof idempotent; `paid` final; late proof accepted | — |
| Bad price | Two agreeing sources or no invoice; the rate and sources are stored with each payment | All sources wrong the same way |
| Flooding the public endpoint | No new direct invoice unless Turnstile is enforced (in code); per-address, per-link, per-owner limits; provider calls throttled per payment | The per-address limit keys on the unsigned client-IP header (same open item as `create-invoice`); Turnstile and the per-link and per-owner limits do not depend on it |
| Admin abuse | Admins can only stop direct links (block) or turn the switch; they cannot set or change an address or a link's mode | — |
| Payer confusion about refunds | The receipt says CPAY did not hold the payment and a refund is between payer and merchant | Needs the refund policy text (legal) |

## 6. Decisions for the owner

These change custody, trust or costs, so they are yours. Everything else is decided above.

1. **Turn direct settlement on, and make it the default for new links?** Recommended, after the gates in
   §7. The switch is in Admin → Settings and needs two-step sign-in.
2. **The custodial CPAY balance:** keep it as the opt-in "My CPAY balance" per link (recommended during the
   move), stop offering it for new links later, or retire it after balances are paid out. Retiring needs
   the owner's decision (it holds customer money today).
3. **Fees on direct payments:** CPAY cannot deduct from a payment it never holds, so **the current
   platform fee model is not implemented for direct payments**: CPAY collects nothing from them.
   The link cost (`cost_percent`) is separate: the merchant's own markup, added to what the payer
   pays and received by the merchant's wallet; on direct links the payer page says "added by the
   merchant (not a CPAY fee)". Options for a CPAY fee: none (current code), a monthly plan, or a
   separate fee invoice billed to the merchant. Any of them needs your approval, its own disclosure
   and its own tests before it is built or described.
4. **Which addresses to allow:** any LUD-21 provider on a public host (current default), or only the
   providers you list in `DIRECT_PROVIDER_HOSTS` (recommended for the pilot), or only self-custodial
   wallets.
   CPAY cannot verify that a provider is self-custodial, so the honest claim is "CPAY does not hold it",
   not "your wallet is self-custodial".
5. **CPAY Wallet:** publish it (gates G1–G9). Its Lightning address (`name@ln.pay-cashapp.buzz`,
   [wallet/LIGHTNING-ADDRESS.md](../wallet/LIGHTNING-ADDRESS.md)) can then be a member's direct-payment
   address: the wallet's "Use for CPAY direct payments" opens the desk at `dashboard.html#direct=<address>`
   with it filled in, and the member still checks and saves it here (fresh sign-in, used 24 hours later).
   The wallet never writes to CPAY; with the optional CPAY link it only reads where direct payments go.
   If `DIRECT_PROVIDER_HOSTS` is set, it must include `ln.pay-cashapp.buzz` for these addresses.

## 7. Gates before turning direct settlement on

| Gate | Who | How |
|---|---|---|
| The owner has signed off the direct model, payer and merchant terms, privacy notice and refund text ([LEGAL-NOTES.md](LEGAL-NOTES.md)) | Owner | — |
| One real payment on mainnet: a merchant's real Lightning address (LUD-21), a $1–$5 payment from Cash App, proof recorded, merchant's wallet shows it | Owner | §9 |
| The deployed runtime reaches the merchant's provider and the price sources, and DNS checks work there (a `dns_unavailable` refusal in the logs means they do not, and no direct invoice is made) | Owner, with logs | Function logs after the pilot payment |
| `DIRECT_PROVIDER_HOSTS` set to the pilot provider's hosts (recommended) | Owner | Edge secret |
| Turnstile enforced for payer endpoints (existing blocker), verified on the deployed runtime. `direct-invoice` refuses new invoices until it is | Owner | `TURNSTILE_MODE=enforce` |
| Reconcile schedule with its own secret, seen running on the deployed project | Owner | §8 |
| A separately approved, low-value pilot (one account, $1–$5) with the rollback in §10 ready. Green CI and preview deployments prove build and test status only, not the provider's live LUD-21 behaviour | Owner | §9 |
| Public copy updated to describe direct payments (only then) | Engineering, after the decision | — |
| Solvency check for the custodial wallet, while the CPAY balance exists | Owner decision | Compare the platform wallet balance with the sum of `get_balance_for` daily |

## 8. Operations

- **Turn on / off:** Admin → Settings → Direct payments. Off stops every direct link immediately ("not
  taking payments"); no link is moved to the CPAY balance. `emergency_payments_stop` stops direct invoices
  too.
- **Stop one account:** `admin_set_direct_settlement_blocked(user, true)`.
- **Reconcile sweep (optional; pages already check while open):** set the Edge secret
  `DIRECT_RECONCILE_SECRET` (a new random value, not `CRON_SECRET`) and schedule
  `POST /functions/v1/direct-invoice` with body `{"action":"reconcile"}` and header
  `x-direct-reconcile-secret` every few minutes (pg_cron + vault, as the other jobs).
- **Environment:** `DIRECT_SETTLEMENT_NETWORK` (default `bitcoin`); `DIRECT_PROVIDER_HOSTS` (optional list of provider hosts); `TURNSTILE_MODE=enforce` is required for new direct invoices. `E2E_LNURL_GATEWAY` and
  `E2E_FIXED_BTC_USD` are honoured only when `SUPABASE_URL` is a loopback address (the local test stack);
  never set them on the hosted project.
- **A payer says they paid, the page says waiting:** look up the row in `direct_payments`; the
  `verify_url` answers the provider's view. Only a preimage marks it paid. Money is with the merchant's
  provider either way; CPAY cannot refund or move it.

## 9. Manual acceptance (owner, on staging or with the switch on for one test account)

1. Admin turns the switch on (two-step sign-in).
2. A test Freelancer adds a real Lightning address from a wallet that supports LUD-21: Check shows the
   limits; Save asks for a fresh sign-in; the card shows "waiting" with the time.
3. After 24 hours (or on staging, by the same database step the E2E hook uses), "Pay to my wallet" on a
   link; the link table shows "Your wallet".
4. Open the link on a phone: the note says the payment goes to the merchant's own wallet; pay $1–$5 from
   Cash App.
5. The page turns to "Payment received" with a proof of payment; the merchant's wallet shows the payment;
   the desk shows it under Direct payments; the CPAY balance is unchanged.
6. Remove the address: the link says it is not taking payments.
7. Turn the switch off: every direct link says the same.

Evidence to record: the payment id, the time, the merchant wallet's own record of the payment.

## 10. Rollback

- Product: switch off (immediate), or block single accounts.
- Code: revert the merge. The migration is additive; its header lists the exact rollback statements.
  Export `direct_payments` first: it is the only record of payments that went straight to merchants.
- Nothing to undo in money: CPAY never held a direct payment.
