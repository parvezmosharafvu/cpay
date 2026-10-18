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
| A passkey wallet stores nothing secret: only the passkey's credential id and the label | `src/vault.js` (`passkeyRecord`), `src/passkey.js`, `wallet.spec.ts` |
| A passkey wallet's phrase is derived in the page by the wallet library from the passkey's WebAuthn PRF output, the same 12 words each time | `src/passkey.js`, `tests/wallet/passkey.spec.ts` (real library, PRF virtual authenticator) |

## Passkey login

A wallet can be created with a passkey instead of a passphrase
(`WALLET_RP_ID` set at build time).

- **How the phrase is made.** The wallet library asks the passkey for a
  WebAuthn PRF output and turns it into a standard 12-word BIP-39 phrase.
  The same passkey always gives the same words, so a passkey wallet is a
  12-word wallet: the words restore it anywhere, with or without the passkey.
- **What is stored.** Only the credential id (to ask for that passkey again)
  and the label. No phrase, no ciphertext. Unlocking and "Show recovery
  phrase" derive the words again; they are dropped after use.
- **Backup is required.** Creating a passkey wallet shows the 12 words and
  checks three of them against the paper, exactly like a generated phrase.
  A passkey can be lost, deleted from the device's passkey list, or left
  behind on a domain change; the words are then the only way back.
- **Relying Party.** Our own host (`WALLET_RP_ID`, normally the wallet's
  hostname). Every passkey is bound to it for good. If the wallet moves to
  another domain, keep the old one serving `/.well-known/webauthn` with the
  new origin in `related_origins` (Chrome, Safari, Edge); Firefox users
  restore with the words.
- **Who can derive the words.** Anyone who can use the passkey on this
  origin: the device's screen lock or biometrics, and, for a synced passkey,
  the cloud account it syncs through (iCloud Keychain, Google Password
  Manager). Treat that account like the paper.
- **Label publishing is blocked.** The library publishes wallet labels to
  public Nostr relays for multi-wallet discovery. The wallet uses one fixed
  label, and the CSP does not allow those relays, so no passkey-linked
  record leaves the device.

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
  apply). This version saves an **exit backup** (Security → Save exit
  backup, `exportUnilateralExitState`): a JSON file of the pre-signed exit
  chain. It holds no keys and cannot spend by itself, but it reveals the
  wallet's leaves and balance, so it is downloaded to the device only and
  never uploaded. It is stale after new receives; the UI tells users to
  save a fresh one. **There is still no exit button**: building the exit
  (`prepareUnilateralExit`, `unilateralExit`) needs on-chain CPFP funding
  inputs and a PSBT signer, which is a separate milestone. Until then the
  exit plan is in docs/WALLET-APP.md ("Operator outage / unilateral exit").
- **Lightning** payments are swapped through a Spark Service Provider
  (Lightspark's SSP, `api.lightspark.com`).
- **Data sync:** the library's real-time sync to
  `datasync.breez.technology` is **off** in CPAY builds
  (`realTimeSyncServerUrl` unset, and the host is left out of the CSP
  `connect-src`, so the browser blocks it even if the library tried).
  `WALLET_SYNC=on` turns it back on; do not do that without first
  reviewing what the service stores. Effect of off: payment notes made
  on one device are not copied to another; balances and transfers still
  come back from Spark when the phrase is restored.
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

## Sends whose outcome is not known

A payment can go out and the answer still be lost (a timeout, a closed
tab). The app never treats an error as "nothing was sent":

- The idempotency key is chosen once, when the payment is prepared. The
  library returns the existing payment for a key it has seen, and uses the
  key as the Spark transfer id, which the operators do not run twice (per
  the library's source at 0.26.0). Sending the same prepared payment again
  cannot pay twice ("Try again safely"). A new prepared payment gets a new
  key, so the app warns before one to a request it already tried.
- After an error the app asks the library for that payment: pending is
  shown as in progress ("do not pay again"), failed as nothing sent, and
  "no record" as most likely not sent, with a reminder to check Activity.
- Sends whose outcome is not settled are listed on the phone (no keys:
  the idempotency key, the pasted request, the amount, the time) and
  reconciled from the library's own record on every refresh. Preparing the
  same request again warns that it may pay twice.

Tested in `tests/wallet/wallet.spec.ts` with the test engine's
fail-after-send and fail-before-send modes.

## Recovery

Restoring a **different** recovery phrase on a phone that already holds a
wallet deletes that wallet from the phone, so it needs a tick box and typing
REPLACE. The same phrase (a forgotten passphrase) needs neither: the app keeps
a one-way fingerprint of the phrase (64 bits of SHA-256, which cannot give the
phrase back) to tell them apart. The Security card shows whether the words were
checked against the paper at creation or used to restore.

The 12 words restore the wallet in CPAY Wallet on any device. The
passphrase is device-local and not a backup. A passkey wallet's words
restore it the same way (into a passphrase wallet), and "Sign in with a
passkey" opens it on another device where the same passkey is available. Clearing site data or
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
