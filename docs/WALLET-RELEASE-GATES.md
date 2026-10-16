# CPAY Wallet: release gates

The website's Download wallet page links to CPAY Wallet only when
`public/wallet-release.js` has a `url`. CI refuses a `url` unless every gate
below is **PASS** with a dated note, and the release record below names the
same hostname and `version.json` sha256
(`tests/frontend/wallet-release.test.mjs`). Until then the page says
"Not available yet" and shows no link.

CPAY Wallet is the optional, separate, non-custodial app in `wallet/`. The
CPAY website balance is held by CPAY and never moves into it.

## Gates

| Gate | Requirement | Who | Status | Evidence (date, what was seen) |
|---|---|---|---|---|
| G1 | **Dedicated wallet API key.** A key the wallet library's vendor issued for CPAY Wallet, set only as the `WALLET_API_KEY` build variable of the production project `cpay-wallet`. Never the website's server key, never on staging, never in the repository | Owner | OPEN | |
| G2 | **Separate Workers projects.** `cpay-wallet-staging` and `cpay-wallet`, both Workers Builds from `parvezmosharafvu/cpay` with root directory `wallet`. Not a Pages project, not the website's `cpay` Worker, not connected to the separate `cpay-wallet` repository | Owner | OPEN | |
| G3 | **Separate hostname.** Production has its own custom domain on `cpay-wallet`, not `pay-cashapp.buzz` or a path or subdomain of it. Staging uses its `workers.dev` address, so no DNS change is needed | Owner | OPEN | |
| G4 | **Staging works on test coins.** The staging address passes the "Wallet release check" workflow with network `regtest`, and a two-wallet regtest payment succeeds ([WALLET-TESTING.md](WALLET-TESTING.md)) | Owner | OPEN | |
| G5 | **Integrity.** The production address passes the "Wallet release check" workflow with network `mainnet` and the `version.json` sha256 the build printed: every file matches its manifest and the strict headers are served | Owner (one click) | OPEN | |
| G6 | **Real devices.** Android (Chrome) and iPhone (Safari): install, create, back up, lock, unlock offline, restore on a second phone; first on staging, then on production | Owner | OPEN | |
| G7 | **Mainnet, small amount.** On the production build with the dedicated key: receive at most $5, check the fee shown, send it back | Owner | OPEN | |
| G8 | **Owner sign-off.** The limitations in [wallet/README.md](../wallet/README.md) are accepted for a beta, and the owner has decided whether the wallet needs its own terms or privacy notice (legal question, separate from #97) | Owner | OPEN | |

Mark a gate PASS only with a date (YYYY-MM-DD) and what was seen, for
example "2026-11-02: workflow run 123 PASS, 28 files". Never put a key, a
recovery phrase or a passphrase here.

## Release record

Filled in when every gate passes, in the same change that sets
`public/wallet-release.js`:

- Production hostname: -
- version.json sha256: -

## How to run the checks without a terminal

- **Wallet release check** (gates G4, G5): GitHub → Actions → "Wallet
  release check" → Run workflow. Enter the wallet's https address, the
  network, and (for production) the sha256 the Cloudflare build log printed
  ("wallet build: version.json sha256 …"). It downloads every file and
  compares it with the manifest; it changes nothing.
- **Staging project** (G2, G3, G4): Cloudflare → Workers & Pages → Create →
  Import a repository → `parvezmosharafvu/cpay`. Project name
  `cpay-wallet-staging`, root directory `wallet`, build command
  `npm ci --ignore-scripts && npm run build:staging`, deploy command
  `npx wrangler deploy --env staging`, no build variables. The build refuses
  mainnet, an API key or the CPAY link on staging.
- **Production project** (G1 to G3): the same, named `cpay-wallet`, build
  command `npm ci --ignore-scripts && npm run build`, deploy command
  `npx wrangler deploy`, build variable `WALLET_API_KEY` (the dedicated
  key), then Settings → Domains & Routes → add the wallet's own custom
  domain. A mainnet build without the key is inert ("Not available yet").

## Rollback

- Hide the link: set `url` and `publishedAt` back to `null` in
  `public/wallet-release.js` (the website deploys on merge). Installed
  copies keep working; their keys stay on the phones.
- Stop serving the wallet: Cloudflare → `cpay-wallet` → Settings →
  disconnect the domain, or deploy the previous version from Deployments.
  Never delete a project people have installed from without telling them
  to save their recovery phrase first.
