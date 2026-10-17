# Legal review package

For the qualified reviewer of `public/terms.html`, `privacy.html`,
`refund.html` and `contact.html`. The drafts describe how CPAY works today,
checked against the code and production on 2026-10-14. Text in `[brackets]`
is either a fact only the owner has, or wording the reviewer must supply.
Nobody has approved these pages. `ci/check_legal.py --release` refuses a
release while any bracket or "DRAFT" remains.

## What the gate is, and what it is not

| Requirement | Source | Blocks |
|---|---|---|
| Draft legal pages are `noindex` and not linked from the site | Repository policy (`ci/check_legal.py`, every PR) | Nothing; passes today |
| No draft text in legal pages at release | Repository policy (`--release`, run by `scripts/release-gate.mjs`) | A *public launch* of these pages only |
| Accurate terms, a privacy notice and a complaints route before taking customers' money | Likely legal obligation, depending on jurisdiction | The reviewer decides |
| Licensing for holding customer balances and paying out USDT | Possible legal obligation | The reviewer decides (see below) |

Engineering work, previews and the already-running site are not held by
the gate. It only stops a release that publishes these four pages as final.

## Facts the drafts rely on (verified)

- **Product:** payment links create Lightning invoices priced in US dollars.
  Payers pay from Cash App or another Lightning wallet, using Cash App's
  documented `cash.app/launch/lightning/` link. The receiving account's
  balance is credited in US dollars, less a platform fee per account. Users
  withdraw USDT to a saved address on tron, bsc, ethereum, polygon,
  arbitrum, base, optimism, avalanche or solana.
- **Withdrawal controls:** $5 minimum; per-account daily and single limits;
  24-hour wait on a new or changed address (on every path after PR #106);
  recent sign-in required to confirm; emergency stop for all payments or
  withdrawals.
- **Accounts:** freelancer and admin roles; approval before receiving or
  withdrawing; suspension; admin two-step sign-in (rollout pending).
- **Data and processors:** Supabase (database, auth, functions; region
  ap-southeast-1, Singapore); Cloudflare (site, bot checks); a Lightning
  payment infrastructure provider; Telegram (operator notifications: amount
  and display name); GitHub private repository (nightly ledger backup:
  payments, withdrawals with only the last 4 characters of the address,
  payment links, profiles without email). No analytics or ad trackers
  (`ci/check_frontend.py` enforces this). The session is in browser local storage.
- **Not collected:** payer names, card data, payer wallet balances.

## Questions only the owner can answer

1. Legal entity name, registered address, governing law.
2. Support, complaints, privacy and security contact addresses; response times.
3. Fee rates and the notice period for changes.
4. Data retention periods.
5. What happens on overpayment, and whether a merchant refund tool is wanted.

## Questions for the reviewer (risks found in review)

1. **Regulatory status.** CPAY keeps a US-dollar-denominated balance for
   each user and pays it out in USDT. That may be money transmission, a
   payment service or a virtual-asset service, depending on where CPAY and
   its users are. Operations run on Dhaka time, and Bangladesh's central
   monetary authority has issued public warnings about virtual-currency
   transactions. The drafts
   make no licensing claim.
2. **Trademark and domain.** The production domain is `pay-cashapp.buzz`
   (`site_domains`) and the site says "Pay with Cash App". Cash App is a Block,
   Inc. trademark. The drafts add an independence statement, but a domain
   containing another company's mark may still mislead payers. Consider an own-brand domain.
3. **Naming the Lightning provider.** The repository's public-copy policy
   keeps the provider's name off public pages; privacy law may require
   naming recipients or only categories.
4. **Liability, warranties, suspension and closure terms** suitable for the
   governing law.
5. **Telegram** messages to the operator group include the receiving
   account's display name (and, until a planned fix, its email when no name is set).

## How to approve

The reviewer sends the final wording (or marks up these drafts) with their
name, role and date. The owner replaces every `[bracket]`, removes the DRAFT
banner and the `noindex` line, and records the approval in
`docs/RELEASE-BLOCKERS.md`. `ci/check_legal.py --release` then passes.
