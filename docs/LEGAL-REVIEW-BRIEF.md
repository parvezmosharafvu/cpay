# Brief for legal review: custody and payment flows (2026-10-18)

For qualified counsel. This is a technical description, not legal advice and not a statement that any
flow is lawful or permitted anywhere. Nothing here has been reviewed by counsel yet. The draft legal
pages (terms, privacy, refund, contact) are in pull request #97 and stay unmerged until that review.

## 1. The two ways a CPAY payment can flow

| | CPAY balance (live today) | Direct payment (built, switched off) |
|---|---|---|
| Who receives the payer's bitcoin | CPAY's own wallet (one wallet for all merchants) | The merchant's own wallet provider, then the merchant's wallet |
| Who holds the keys | CPAY | The merchant (or the merchant's chosen provider) |
| What the merchant has | A balance in CPAY's ledger: a claim on CPAY | The bitcoin itself, in their wallet |
| Fees | CPAY deducts its fee when the payment settles | CPAY receives nothing from the payment; no CPAY fee is taken. A link cost the merchant sets is the merchant's own markup, paid to the merchant |
| How the merchant is paid out | CPAY converts and sends USDT to the merchant's saved address on request (or at a threshold the merchant sets) | Not applicable: the money is already with the merchant |
| Refunds | CPAY could technically send money back from its wallet; no refund flow exists | CPAY cannot refund: it never held the money |
| What CPAY controls | The funds, the ledger, payouts | Which invoice the payer sees; records; stopping a link |

Both are Lightning payments (BOLT11 invoices); payers commonly pay from Cash App. Amounts are entered in
US dollars and converted to bitcoin at the time of the invoice.

CPAY Wallet (`wallet/`) is a separate, optional phone app in which the member's keys never leave the
phone. It is not published. Its money never mixes with either flow above.

## 2. Parties and data

- **Payer:** no account. CPAY stores: amount, time, city and country from the network edge, the invoice.
  For direct payments the payer sees the merchant's Lightning address.
- **Merchant ("Freelancer"):** an account (Individual or Business / Organization), approved by an admin.
  CPAY stores profile data, links, payment records, payout addresses (CPAY balance) and the Lightning
  address (direct payments).
- **Providers:** the platform wallet library vendor and the Spark network operators (CPAY balance and
  CPAY Wallet); the merchant's wallet provider (direct payments); public exchange price feeds (direct
  payments); the hosting providers (database, functions, website).

## 3. Questions for counsel

1. **CPAY balance.** Does holding customer funds in a pooled wallet, keeping a ledger and paying out USDT
   make CPAY a money transmitter, custodian or payment institution in the places it operates and serves
   (at least: Bangladesh, where it is run; the United States, federally and in the states payers and
   merchants are in; anywhere else merchants sign up from)? What licences, registrations, safeguarding or
   reserve rules, and customer-identification duties follow?
2. **Direct payments.** With CPAY only requesting an invoice from the merchant's own provider and
   recording it, is CPAY outside those regimes, and under what conditions (for example: no fee taken from
   the flow, no control over the destination beyond the merchant's own setting)? Does billing a separate
   fee change that?
3. **Transition.** If the CPAY balance is kept as an opt-in alongside direct payments, what disclosures
   must each link, receipt and the desk carry? If it is retired, what is required to wind it down and pay
   out existing balances?
4. **Marketing claims.** Which statements are allowed: "held by CPAY" (today), "payments go straight to
   your own wallet; CPAY never holds them" (direct links)? CPAY does not call the platform non-custodial.
5. **Refunds and disputes.** What must the refund policy say for each flow, given CPAY cannot refund a
   direct payment?
6. **Privacy.** Showing the merchant's Lightning address to payers; storing city/country of payers;
   sharing invoice requests with merchant-chosen providers and price lookups with exchanges.
7. **Sanctions and fraud screening.** Duties for a service that creates invoices for third parties without
   holding funds, compared with one that holds them.
8. **CPAY Wallet.** Whether publishing a self-custodial wallet app needs its own terms, privacy notice or
   registration (release gate G8).

## 4. What engineering has done so the facts stay true

- The website says "held by CPAY" and never "non-custodial" (checked in tests).
- Direct payments are off until the owner turns them on, and the switch needs two-step sign-in.
- A direct payment can never be recorded as part of a CPAY balance (database rules), and a link's flow
  can only be changed by its owner.
- Public pages never name the payment processor and offer no traditional payment rails (checked in CI).
- Details: [NON-CUSTODIAL-ARCHITECTURE.md](NON-CUSTODIAL-ARCHITECTURE.md).
