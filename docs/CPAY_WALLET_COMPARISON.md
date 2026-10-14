# CPAY: the website wallet and the standalone CPAY Wallet

Two different things that share an SDK and nothing else.

| | Website wallet (in production) | Standalone CPAY Wallet (`wallet/`) |
|---|---|---|
| What it is | One platform wallet run by CPAY that receives every customer payment and sends USDT payouts | An optional app each member installs on their own phone (PWA) |
| Custody | **Custodial.** CPAY holds the keys (`BREEZ_MNEMONIC`). Member balances are ledger entries in Postgres, not separate wallets | **Non-custodial.** The 12-word phrase is made on the phone, stored only encrypted on the phone, never sent anywhere. CPAY cannot move or recover it |
| Engine | Lightning/Spark wallet SDK (pinned 0.26.0), server build, in the wallet Edge Function | The same SDK's browser build (0.26.0), in the page |
| Operator dependency | Spark operators co-sign transfers (2 of 3) | Same; disclosed on the welcome screen and security page |
| API key | `BREEZ_API_KEY` (server, Edge secret) | `WALLET_API_KEY` (its own key, build variable). Never the server key or any Supabase service key |
| Data | `breez_wallet` schema + the CPAY ledger tables | The phone's IndexedDB; vendor real-time sync **off** by default and blocked by CSP |
| Hosting | Supabase Edge Function behind the website's functions | Its own Cloudflare Worker `cpay-wallet` on its own hostname. **Not created yet** |
| Deployed | Yes, v17 | No |
| Network | mainnet | regtest tested; mainnet build is inert until `WALLET_API_KEY` exists |

## How they relate

- They never exchange money. Nothing moves between a member's CPAY
  balance and their phone wallet.
- The phone wallet can optionally sign in to the member's CPAY account,
  with an explicit consent box. It then shows the website balance with the
  label **"held by CPAY"**, separately from the phone wallet's own balance.
  The two are never added together, and nothing suggests website funds were
  moved into the phone wallet. Browser tests check the labels; see
  [WALLET-TESTING.md](WALLET-TESTING.md).
- The link reads the balance through the existing `get_my_balance()` with
  the member's own session (RLS). It cannot withdraw, and "Unlink" signs it out.
- There is one website wallet engine. The phone wallet generates its own
  keys and can never use or control the platform wallet's seed.

## Release state of the phone wallet

- The Download wallet page on the website shows "Not available yet" and no
  link until `public/wallet-release.js` has an https `url` on a separate
  host, `publishedAt` and `versionJsonSha256`.
- Mainnet readiness needs `WALLET_API_KEY`, the `cpay-wallet` project and
  hostname, tests on real phones, and a small mainnet test. None of these is
  done yet. See [WALLET-TESTING.md](WALLET-TESTING.md) and
  [CPAY_CLOUDFLARE_DEPLOYMENT.md](CPAY_CLOUDFLARE_DEPLOYMENT.md).
