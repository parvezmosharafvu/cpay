# CPAY Wallet

An optional, standalone, non-custodial Lightning wallet that CPAY members
can install on their phones from the CPAY website. It is an installable
web app (PWA): no app store, no APK.

It is **separate from the CPAY website**. The website (balances,
deposits, freelancer earnings, admin reporting, fees, USDT withdrawals)
is not changed by this directory. See [SECURITY.md](SECURITY.md) for the
custody model.

## Layout

| Path | What |
|---|---|
| `src/` | the app (no inline scripts; strict CSP) |
| `build.mjs` | builds `dist/`: copies `src/`, the pinned wallet library and supabase-js, writes `config.js`, `_headers`, `version.json` (sha256 per file) and the service worker's file list |
| `serve.mjs` | local static server that applies `dist/_headers` |
| `wrangler.jsonc` | Workers static-assets config for its own hostname |

## Build and test locally

```sh
cd wallet && npm ci --ignore-scripts && cd ..
node --test tests/frontend/wallet-*.test.mjs tests/wallet/build.test.mjs
npx playwright test -c tests/wallet/playwright.config.ts
```

`WALLET_LIVE=1` also runs a real regtest wallet session (needs internet).

## Publish (owner steps; nothing here deploys on merge)

Every step is a release gate in
[docs/WALLET-RELEASE-GATES.md](../docs/WALLET-RELEASE-GATES.md); CI keeps
the website's download link off until all of them pass.

0. **Staging first (test coins only).** A separate Workers Builds project
   `cpay-wallet-staging`: root directory `wallet`, build command
   `npm ci --ignore-scripts && npm run build:staging`, deploy command
   `npx wrangler deploy --env staging`, no build variables. It runs on
   regtest with no API key and no CPAY link, on its `workers.dev`
   address. The build refuses anything else.
1. **API key.** Request a key for this wallet from the wallet library's
   vendor. Do not reuse the website's server key.
2. **Hostname.** Choose a separate hostname, for example
   `wallet.<your-domain>`. Not a path on the website.
3. **Workers project.** In Cloudflare, create a Workers Builds project
   from this repository: root directory `wallet`, build command
   `npm ci --ignore-scripts && npm run build`, deploy command
   `npx wrangler deploy`, build variable `WALLET_API_KEY`. Attach the
   hostname as a custom domain.
4. **Test on real phones.** Android (Chrome) and iPhone (Safari): create,
   back up, receive a small amount, send it back, lock, restore on a
   second phone.
5. **Check the release.** GitHub → Actions → "Wallet release check": the
   production address, network `mainnet`, and the sha256 the build printed.
   Every file must match its manifest
   (`scripts/wallet-verify-release.mjs`).
6. **Turn on the download link.** In `public/wallet-release.js` set
   `url` to the hostname and `publishedAt`, and `versionJsonSha256` to the
   value the build printed, and record them in the gates page. Until then the website's Download wallet page
   says the wallet is not yet available and shows no link.

## Limitations of this version

- No unilateral-exit button yet. The app saves an exit backup file;
  the exit itself is a later milestone (see SECURITY.md).
- Real-time sync with the library vendor is off (`WALLET_SYNC=on` to
  turn it on after review).
- Receive shows a QR code; there is no camera scan yet, so invoices to
  pay are pasted.
- On-chain deposits: a deposit address is shown only on the test network
  (regtest), for funding from the faucet. Mainnet builds do not offer it.
- Beta: the app tells users to use small amounts only.
- Lightning addresses and LNURL are not supported, so CPAY Wallet cannot yet
  be the wallet a CPAY direct-payment link pays into (that needs the
  library's Lightning-address registration and its server in the CSP; see
  docs/NON-CUSTODIAL-ARCHITECTURE.md, option B).
- Not tested against the live Spark network from this repository's
  sandbox; CI runs the live regtest test (`WALLET_LIVE=1`) where the
  network is reachable.
