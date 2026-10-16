# CPAY: Cloudflare projects and how each is deployed

Checked on 2026-10-14 with the read-only Cloudflare listing available to
this audit. No Cloudflare API token is available to the repository or the
audit, so nothing was created, changed or deleted on Cloudflare.

## Projects that exist

| Worker | Purpose | Deploys from | Notes |
|---|---|---|---|
| `cpay` | The website (static files in `public/`) | Workers Builds on every merge to `main`; config in the root `wrangler.jsonc` | Serves `pay-cashapp.buzz`. Do not change its routes or DNS for the wallet |
| `cpay-og-preview` | Link-preview cards | `worker/` | Leave as is |

No other CPAY project is connected to this repository; there is no
`cpay-wallet` or `cpay-wallet-pwa` Worker (re-checked 2026-10-14, see
[CPAY_WALLET_REPOS_AND_PROJECTS.md](CPAY_WALLET_REPOS_AND_PROJECTS.md)).
Nothing should be deleted.

## The project that does not exist yet: `cpay-wallet`

The standalone phone wallet (`wallet/`) has its own Worker config,
`wallet/wrangler.jsonc` (name `cpay-wallet`, static assets from `dist`,
single-page fallback). It must be a **separate** project on a **separate
hostname**, never a route on the website.

Owner steps in the Cloudflare dashboard (no terminal needed):

1. Workers & Pages → Create → Import a repository → this repository.
2. Project name `cpay-wallet`. Root directory `wallet`.
3. Build command `npm ci --ignore-scripts && npm run build`. Deploy command
   is the default (`npx wrangler deploy`).
4. Build variables:
   - First deploy, for a look only: none. A mainnet build without
     `WALLET_API_KEY` is inert and says "Not available yet".
   - Real use: `WALLET_API_KEY` = the key the SDK vendor issues **for the
     phone wallet** (not the website's server key). Leave `WALLET_TEST`
     and `WALLET_ENGINE` unset. Never add any Supabase service key; the
     build refuses one.
5. Custom domain: a new subdomain (for example `wallet.` on a domain you
   control). Do not reuse or move the website's hostname.
6. Only after the checks in [CPAY_LIVE_TEST_RUNBOOK.md](CPAY_LIVE_TEST_RUNBOOK.md)
   pass, fill `public/wallet-release.js` (https `url` on the new host,
   `publishedAt`, `versionJsonSha256`) so the website's Download page
   shows the link. Until then it stays "Not available yet".

### Staging: `cpay-wallet-staging` (does not exist yet)

A second, separate project for testing on test coins before production:
name `cpay-wallet-staging`, the same repository and root `wallet`, build
command `npm ci --ignore-scripts && npm run build:staging`, deploy command
`npx wrangler deploy --env staging` (env `staging` in
`wallet/wrangler.jsonc`), no build variables, its `workers.dev` address (no
DNS change). The build refuses mainnet, an API key or the CPAY account
link on staging. Release gates:
[WALLET-RELEASE-GATES.md](WALLET-RELEASE-GATES.md).

### Guards already in the build

- Default network is mainnet. A regtest build shows a permanent
  "test network" banner.
- The fake test engine is refused unless `WALLET_TEST=1`; CI checks that a
  normal build contains no test engine.
- A service-role key in any build variable stops the build.
- Vendor real-time sync is off and blocked by the page's CSP.

## Supabase (not Cloudflare, for completeness)

Database migrations and the website functions deploy through the Supabase
GitHub integration on merge to `main`. The wallet engine function is
excluded (`enabled = false` in `supabase/config.toml`) and is only ever
deployed by hand with the wallet deploy script in `scripts/`; see
[DEPLOYMENT.md](DEPLOYMENT.md).
