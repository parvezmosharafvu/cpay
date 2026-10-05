# Checkout wallets

`public/wallets-config.js` lists the wallets shown on the invoice page (`invoice-cpay-v2.html`).
This file records why each one is there, how it was checked, and what still needs checking. CI
(`ci/check_frontend.py`) rejects entries that break these rules.

## How a payer leaves the checkout

| Button | What it does |
|---|---|
| **Pay with Lightning** (primary) | Opens `lightning:<bolt11>`. The phone opens whichever Lightning wallet is set up for that link. This is the safe default for wallets that handle `lightning:` links. |
| **Pay with Cash App** | Opens Cash App's Lightning launch link (`https://cash.app/launch/lightning/<bolt11>`, the `cashAppUrl` from create-invoice). With `?wallet=cashapp` it becomes the primary button. |
| **Other wallets** | Bottom sheet built from `wallets-config.js`. Each entry has its own handoff: `universal`, `deeplink`, `lightning` or `copy`. |
| **Scan QR / Copy payment request** | Works with wallets that can scan or paste a standard (BOLT11) invoice. The raw request sits in a collapsed "Show payment request" section. |

## Rules

* `verification.status: 'verified'` needs an official source (https) and the date it was checked
  (`YYYY-MM-DD`). "Official" means the wallet's own help or docs, its own code repository, or its
  app-store listing.
* Unverified wallets never appear in the featured list. They are shown under "Other compatible
  wallets" and always hand off with the plain `lightning:` link or copy-and-paste, never with an
  app-specific link. Otherwise they are disabled (`enabled: false`).
* Lightning only. No traditional payment methods.
* Do not list a wallet that carries the name of the platform's payment provider. The provider name must
  not appear on customer pages (see `check_provider_name_hidden`).
* `icon: null` renders a neutral letter badge in CPAY colours. Don't ship third-party logos without
  permission.

## Status (checked 2026-10-03)

| Wallet | Status | BOLT11 | US | iOS / Android | Handoff | Source |
|---|---|---|---|---|---|---|
| Cash App | verified | yes | yes, except New York; Lightning send limit $999 per 7 days | both | universal `https://cash.app/launch/lightning/{bolt11}` | [Cash App help 6506](https://cash.app/help/us/en-us/6506-lightning). Launch-link format: [Voltage docs](https://docs.voltageapi.com/wallet-deep-linking). Cash App doesn't publish it itself. |
| Strike | verified | yes (also BOLT12) | yes | both | `lightning:` | [Strike support](https://strike.me/support/how-do-i-send-cash-or-bitcoin/) |
| Wallet of Satoshi | verified | yes | yes (returned 2025) | both | `lightning:` | [WoS support](https://support.walletofsatoshi.com/en/support/solutions/articles/36000579025-how-to-send-and-receive-bitcoin-in-the-self-custody-wos-wallet), [US App Store](https://apps.apple.com/us/app/wallet-of-satoshi/id1438599608) |
| Phoenix | verified | yes (also BOLT12) | yes (back in US stores April 2025) | both | deep link `phoenix:lightning:{bolt11}` | [ACINQ/phoenix #251](https://github.com/ACINQ/phoenix/issues/251), [US App Store](https://apps.apple.com/us/app/phoenix-wallet/id1544097028) |
| Coinbase | verified | yes | yes, except New York | both | copy and paste | [Coinbase help](https://help.coinbase.com/en/coinbase/trading-and-funding/sending-or-receiving-cryptocurrency/lightning). The site blocks automated fetches, so it was read through the search index. |
| River | verified | yes | yes | both | copy and paste | [River support](https://support.river.com/hc/en-us/articles/45489800672915-How-do-I-send-bitcoin) |
| Muun | unverified | via swaps | not confirmed | both | `lightning:` | [muun.com](https://muun.com/) |
| ZEUS | unverified | yes (own node or wallet needed) | not confirmed | both | `lightning:` | [ZeusLN/zeus #4123](https://github.com/ZeusLN/zeus/pull/4123) |
| Kraken | unverified | yes (withdrawal flow) | not stated | both | copy and paste | [Kraken support](https://support.kraken.com/articles/5068216131988-how-do-i-send-bitcoin-on-the-lightning-network-). Needs a verified account and email confirmation, which may take longer than the invoice lasts. |
| Blink | disabled | yes | unclear | both | n/a | [blink.sv](https://www.blink.sv/en/features) |
| NDAX | disabled | yes | no (Canada) | both | n/a | [NDAX blog](https://ndax.io/en/blog/article/what-is-btc-lightning-a-beginners-guide) |
| BlueWallet | disabled | needs own server | n/a | both | n/a | [Hosted Lightning sunset](https://bluewallet.io/sunsetting-lndhub/) |

**Excluded:** one wallet whose brand name matches the platform's payment provider, a name that
must not appear on customer pages. Owner decision needed
before it is listed.

## Still to verify on real devices

None of these handoffs has been tested on a real phone with a live invoice yet. Before you rely on a
handoff, check it on iOS and Android with a small real invoice:

* Cash App launch link (universal link opens the app with the invoice prefilled).
* `phoenix:lightning:` on iOS and Android.
* `lightning:` with Strike, Wallet of Satoshi, Muun, ZEUS installed (which app the OS picks when
  several are installed).
* Copy-and-paste flow in Coinbase, River and Kraken.
