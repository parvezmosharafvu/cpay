# CPAY Wallet: what is tested, and how to test it on a phone

The wallet (PR #104) is optional and separate from the website's ledger.
This page says what has been proven, by which test, and what still needs
a person with a phone or real money.

## Tested capabilities

| Capability | Evidence | Network |
|---|---|---|
| Phrase made on the device (BIP-39, 12 words), shown once, checked against the paper copy | `tests/frontend/wallet-bip39.test.mjs`, `tests/wallet/wallet.spec.ts` "create" | none (fake engine) |
| Phrase stored only as ciphertext (PBKDF2-SHA256 600k + AES-256-GCM); wrong passphrase refused | `wallet-vault.test.mjs`, "lock, wrong passphrase refused" | none |
| No request to any host carries the phrase or passphrase | `assertNoLeak` in every browser test; live test checks real requests | fake + regtest |
| Lock, unlock, auto-lock, reveal phrase behind the passphrase | `wallet.spec.ts` | none |
| Restore from a phrase; bad phrase refused | `wallet.spec.ts` "restore" | none |
| Remove from this phone leaves nothing behind | `wallet.spec.ts` "remove" | none |
| Opens and unlocks offline (installed app, no network) | `wallet.spec.ts` "offline" | none |
| Receive invoice with a QR code that decodes to the invoice | `wallet.spec.ts` "receive", live test | regtest (real library) |
| Test-network deposit address with QR (regtest only; not offered on mainnet) | "regtest funding", live test (`bcrt1…` from the real library) | regtest |
| Send with fee shown first, confirm required | `wallet.spec.ts` "send" | fake engine only |
| Exit backup file (no phrase in it) | `wallet.spec.ts` "exit backup" | fake engine |
| Real library loads under the strict CSP; fake engine not shipped in production builds | `sdk.spec.ts`, `build.test.mjs` | regtest |
| Vendor real-time sync off and blocked by CSP | `build.test.mjs` | build |
| Optional CPAY link: consent, read-only, separate labelled balance, revocable | `wallet.spec.ts` "optional CPAY link" | fake CPAY API |

## Not yet proven (needs a person)

- **A real payment between two wallets.** Funding needs coins from the
  Spark regtest faucet, which is a web page and cannot be scripted from CI.
  Steps are below.
- **A real phone.** Chromium's installability check passes, and the tests
  run with a Pixel 7 profile, but no physical Android or iPhone has been used.
- **Mainnet.** Never tested. Needs a wallet API key and the plan below.

## Android: install and test the preview (regtest, no real money)

1. Build the preview (CI does this for every PR; locally:
   `cd wallet && npm ci --ignore-scripts && WALLET_NETWORK=regtest WALLET_LINK=off npm run build`).
   Host `wallet/dist` on a separate HTTPS origin, for example a Cloudflare
   Workers preview of the `cpay-wallet` project. A phone cannot install it
   over plain HTTP from another host.
2. On the phone, open that address in **Chrome**. Check the orange beta
   banner and the "test network" note.
3. Chrome menu → **Add to home screen** → **Install**. Open it from the home
   screen; it opens without the browser bar.
4. **Create a new wallet.** Write the 12 words on paper. Tick the box, enter
   the requested words, choose a passphrase of at least 10 characters.
5. **Receive** → enter 1000 sats → **Create invoice**. A QR code appears.
6. **Show deposit address** → copy the `bcrt1…` address → open the Spark
   regtest faucet (linked from the wallet library's "Getting started" guide) on
   another device and send test coins to it. After confirmation the
   balance appears (the library claims the deposit by itself).
7. On a second phone (or a second browser profile), create wallet B and
   create an invoice. In wallet A: **Send** → paste B's invoice → **Check
   fee** → **Send now**. B's balance should rise; A's falls by the amount
   plus the fee.
8. **Lock** → unlock with the passphrase. Turn on airplane mode, close and
   reopen the app: it unlocks offline.
9. **Security → Save exit backup**: a `.json` file downloads.
10. **Remove wallet from this phone** (type DELETE), then **Restore with a
    recovery phrase** with the paper words: the balance comes back after sync.

Record the phone model, Android and Chrome versions, the release
`version.json` sha256, and the result of each step.

## Mainnet test plan (only after the owner decides to go ahead)

1. Owner requests a wallet API key from the library vendor for this app
   (not the website's server key) and sets it only as the build variable
   `WALLET_API_KEY` in the `cpay-wallet` Cloudflare project.
2. Build with `WALLET_NETWORK=mainnet WALLET_LINK=off`. Check that the
   `version.json` hash matches a local reproducible build.
3. Deploy to the wallet's own origin, not linked from the website.
4. With at most $5 of sats: receive from an outside Lightning wallet, send
   back, restore on a second phone, save an exit backup. Record txids and
   amounts.
5. Only then set `url`, `publishedAt` and `versionJsonSha256` in
   `public/wallet-release.js`, which turns on the Download wallet link.
