# CPAY Wallet: custody and key management

CPAY Wallet is an optional, standalone wallet. It is a separate product
from the CPAY website. The website's ledger, deposits, earnings, fees and
USDT withdrawals are unchanged and remain custodial (held and recorded by
CPAY). This document covers only the wallet.

## Claim and what backs it

**Non-custodial: CPAY never holds or can use the wallet's keys.**

| Fact | Where |
|---|---|
| The 12-word BIP-39 phrase is generated on the device from `crypto.getRandomValues` | `src/bip39.js` (official vectors, and identical output to `@scure/bip39` on 500 random entropies) |
| The phrase is stored only as AES-256-GCM ciphertext, key from PBKDF2-SHA256 (600 000 rounds) over a user passphrase | `src/vault.js`, `tests/frontend/wallet-vault.test.mjs` |
| The phrase goes from the vault straight into the wallet library's `connect()`, which derives keys in WebAssembly in the page | `src/engine.js` |
| No request to any host carries the phrase or passphrase | `tests/wallet/wallet.spec.ts` records every request and checks each one |
| The CPAY account link never touches the vault, the phrase or the engine | `src/link.js`, `tests/frontend/wallet-config.test.mjs` |
| The CPAY password is not used to derive or protect wallet keys (separate passphrase) | `src/app.js`, UI copy |
| The app opens, unlocks and reveals the phrase with no network | service worker; offline test in `wallet.spec.ts` |

## The wallet library and the Spark network

The engine is the Breez SDK (Spark), MIT licensed, pinned to **0.26.0**
(the same version CPAY's server wallet runs), browser build, installed
from npm with the lockfile's integrity hash and copied unmodified.

Custody model of that integration (from the library's own default
configuration, `defaultConfig()`):

- **Spark** is a Bitcoin layer-2. Funds are controlled jointly by the
  user's key and a threshold of Spark operators: currently 3 operators
  (Lightspark, Breez, Flashnet), any 2 co-sign (FROST threshold
  signatures). A transfer needs the user's signature; operators cannot
  move funds alone. (Operator count and threshold are read from the
  library's config; the signing scheme is per Spark's documentation.)
- **Trust assumption** (per Spark's published design, not verified by
  us): operators delete their old key shares after each
  transfer. If at least one operator does, a previous owner cannot reclaim
  funds. This is a weaker guarantee than a single-signature on-chain
  wallet. If operators go offline or refuse service, the user can exit
  unilaterally to Bitcoin L1 using pre-signed transactions (on-chain fees
  apply). **This version has no exit button**; the library supports it
  (`prepareUnilateralExit`, `unilateralExit`) and a later version should
  expose it.
- **Lightning** payments are swapped through a Spark Service Provider
  (Lightspark's SSP, `api.lightspark.com`).
- **Data sync:** the library syncs wallet metadata to
  `datasync.breez.technology` by default (its "real-time sync"). We left
  the default unchanged because the server wallet runs with it. We have
  **not** independently verified what that sync contains or how it is
  encrypted; see the library's documentation before relying on it for
  privacy.
- **API key:** mainnet use requires a key from the library vendor. The
  key identifies the app, ships inside it, and does not protect funds. Use
  a key issued for this wallet, never the website server's key.

## What CPAY operates, and the risk that remains

CPAY serves the wallet's code from its own origin. Anyone who controls
that origin (CPAY, or an attacker who compromises its hosting) could ship
code that exfiltrates the phrase the next time a user unlocks. This is the
standing risk of every web wallet. Mitigations:

- **Separate origin** (`wallet.<domain>`), never a path on the website, so
  website scripts cannot read the wallet's storage.
- Strict CSP: no inline script, no `eval` (only WebAssembly compile), no
  third-party scripts, connections only to the hosts listed in
  `build.mjs`, `frame-ancestors 'none'`.
- The service worker serves the cached release until a new one installs.
- `version.json` lists the sha256 of every file in the release, so a
  published release can be compared with a reproducible build of the same
  commit.

A native, signed app would reduce this risk; it needs an Android build
toolchain and a signing key held by the owner, which this repository does
not have.

## Recovery

The 12 words restore the wallet in CPAY Wallet on any device. The
passphrase is device-local and not a backup. Clearing site data or
"Remove wallet from this phone" deletes the device copy only.

## Not in scope (by design)

- No transfer between the CPAY website balance and the wallet. The
  website's withdrawals are USDT only; nothing here changes them.
- No second ledger: the wallet's balance comes from its own keys and the
  Spark network, and the website ledger stays the record for website
  balances.
- On-chain deposits are offered only on the test network (regtest), to
  fund a test wallet from the faucet; the engine refuses them on mainnet.
  A mainnet deposit whose claim fee exceeds the library's cap would wait
  unclaimed, and this version has no screen to resolve that.
- Lightning addresses and LNURL are not supported in this version (they
  fetch arbitrary hosts, which the CSP does not allow).
