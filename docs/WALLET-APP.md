# CPAY Wallet (optional standalone app)

Internal document. CPAY Wallet is an optional, non-custodial Lightning
wallet that members install on their own phones. It is a **separate
product** from the website:

| | CPAY website | CPAY Wallet |
|---|---|---|
| Who holds the money | CPAY (custodial; platform wallet + ledger) | the member (keys on the phone) |
| Source of truth for its balance | the website ledger (`get_my_balance`, payments, withdrawals) | the wallet's own keys on the Spark network |
| Code | `public/`, `supabase/`, `payment-service/` | `wallet/` |
| Hosting | the CPAY hostname (Workers Builds: cpay) | its own hostname, its own Workers project |
| Deployed by merging to main | yes | no |

Nothing in `wallet/` changes the website's balances, deposits, freelancer
earnings, admin reporting, fees, invoices, settlement or USDT withdrawals.
There is no transfer between the two and no second ledger.

## What the website has

- `public/assets/wallet.html`: the Download wallet page (explanation,
  requirements, version, install steps, security and recovery). It lives
  under `/assets/` so its path can never collide with a payment-link slug
  (`assets` is reserved and a path with `/` is never a slug).
- `public/wallet-release.js`: the published release. While `url` is
  `null` the page says "Not available yet" and shows no link.
- A **Download wallet** entry in the freelancer desk menu.

## Optional account link

In the wallet, a member may sign in to their CPAY account (the same email
and password sign-in as the website, after ticking a consent box). The
wallet then shows the website balance, labelled "held by CPAY", next to
its own balance. It reads only `get_my_balance()` for the signed-in user;
no new table, RPC or permission was added. Unlink signs the wallet out;
"Unlink and sign out everywhere" revokes all of the member's sessions.
The recovery phrase and keys are never part of linking.

## Testing

What is proven, by which test, and the Android and mainnet procedures:
[WALLET-TESTING.md](WALLET-TESTING.md).

## Publishing and release checks

Publishing steps are in [wallet/README.md](../wallet/README.md) (staging,
API key, hostname, Workers project, phone tests, release check, then
`public/wallet-release.js`). The gates CI enforces before the website links
to the wallet: [WALLET-RELEASE-GATES.md](WALLET-RELEASE-GATES.md).
Custody and key management: [wallet/SECURITY.md](../wallet/SECURITY.md).

Release-check separation, as the repository works today:

- Every PR and every merge runs `ci/check_legal.py` in its default mode,
  which only requires draft legal pages to stay `noindex` and unlinked.
  Routine engineering work, including the wallet, never waits on legal
  approval.
- Legal approval is checked only by `scripts/release-gate.mjs` for a
  **website** production release (`ci/check_legal.py --release`). That
  gate does not cover the wallet's publication, which is a separate owner
  decision (see wallet/README.md). Whether the wallet needs its own terms
  or privacy notice before it is published is a business and legal
  question, not an engineering blocker.

## Operator outage / unilateral exit

The wallet's money is on Spark. If the Spark operators (listed in
`wallet/SECURITY.md`) stop co-signing, payments stop but the money is not lost: Spark
keeps pre-signed Bitcoin transactions that let the owner exit to the
Bitcoin blockchain alone.

What exists today:

- **Exit backup** in the app (Security → Save exit backup). Users are told
  to save a fresh one after receiving money. It holds no keys.
- The library (pinned 0.26.0) implements the exit itself:
  `checkUnilateralExit`, `prepareUnilateralExit`, `unilateralExit`,
  `importUnilateralExitState`.

What does not exist yet (later milestone, not in beta):

- An exit button. It needs an on-chain UTXO to pay the CPFP fees and a
  PSBT signer, plus a mainnet test.

If an outage happens before that milestone ships, CPAY's response:

1. Post a notice on the website and the Download wallet page: do not
   remove the wallet, keep the recovery phrase and latest exit backup.
2. Ship a wallet release with the exit flow (restore phrase → import
   exit backup → prepare exit → fund CPFP → broadcast), tested on regtest
   first.
3. No CPAY server ever receives a user's phrase or exit backup; users run
   the exit on their own device.

## Vendor data sync

The wallet library's real-time sync service (host in `wallet/SECURITY.md`) is off in CPAY builds and
blocked by the CSP. Turning it on (`WALLET_SYNC=on`) needs a written
review of what the service stores and how it is encrypted.
