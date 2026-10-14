# CPAY: wallet repositories and hosting projects (audit 2026-10-14)

Read-only audit. Nothing was renamed, archived, deleted, pushed or deployed.

## GitHub

| Repository | What it is | Status |
|---|---|---|
| `parvezmosharafvu/cpay`, folder `wallet/` | The standalone CPAY Wallet: plain-JS PWA, 3 dependencies, own Worker config `wallet/wrangler.jsonc` (`cpay-wallet`), CI job "Standalone wallet builds, keeps keys on the device" | **Authoritative.** The website's Download page refers to this one |
| [`parvezmosharafvu/cpay-wallet`](https://github.com/parvezmosharafvu/cpay-wallet) | A separate, earlier app: React/TanStack Start with Vite, an Android (Capacitor) shell, passkey login, ads, a server part with Postgres. Public, default branch `main`, last commit 2026-10-06, 7 commits, tags `v0.1.0`, `v0.2.0-android`–`v0.6.0-android`, two open side branches (CI, dependency update) | Unrelated code, not a copy: only `README.md`, `package.json` and `package-lock.json` share names, and all differ |

The separate repository:
- has no Cloudflare config and no deploy workflow (a `vercel.json` with an
  install command only);
- has **no committed secrets** in any branch or tag (searched the full
  history for API keys, JWTs, private keys, tokens, `.env` and keystore
  files, and seed phrases);
- builds the wallet SDK vendor key into the shipped app from a build
  variable. That is how browser and phone wallets work, but it means the
  key is public once the app is published. It must never be the website's
  server key.

**Recommendation.** Keep `wallet/` in the main repository as the source.
Leave `cpay-wallet` untouched for now. If the owner no longer needs its
Android shell, passkey login or ad code, archive it later (or rename it, for
example `cpay-wallet-android-prototype`) so nobody connects it to the
`cpay-wallet` Worker by mistake. Archiving is reversible; deleting is not.

## Cloudflare

Workers in the account (read-only listing): `cpay`, `cpay-og-preview`,
`cpay-status`, `parvez-site`, `parvez-ai`, `boltpay`, `boltpay-og-preview`.

| Name | Exists | Notes |
|---|---|---|
| `cpay` | Worker, Workers Builds from this repository (check "Workers Builds: cpay") | The website. Unaffected |
| `cpay-og-preview` | Worker, Workers Builds from this repository | Link previews. Unaffected |
| `cpay-wallet` | **No** Worker by this name | Not created. Config ready in `wallet/wrangler.jsonc` |
| `cpay-wallet-pwa` | **No** Worker by this name | — |

Pages projects are not visible to the tools used here, so a Pages project
named `cpay-wallet` or `cpay-wallet-pwa` could not be ruled out. If one
exists in the dashboard (Workers & Pages → Overview, type "Pages"), it is
not connected to this repository: no pull request shows a check for it.

No Cloudflare API token was used. A token pasted into a chat should be
treated as exposed and revoked (My Profile → API Tokens).

**Recommended configuration** for the wallet project, when the owner is
ready: [CPAY_CLOUDFLARE_DEPLOYMENT.md](CPAY_CLOUDFLARE_DEPLOYMENT.md)
(Worker `cpay-wallet`, repository `parvezmosharafvu/cpay`, root `wallet`,
build `npm ci --ignore-scripts && npm run build`, output `dist`, its own
hostname, `WALLET_API_KEY` only for real use). If a Pages project with that
name is found, delete it or leave it unconnected, but do not point it at
the separate repository: both would claim the same name.
