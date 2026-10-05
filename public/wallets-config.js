// CPAY checkout: wallets offered in the "Other wallets" sheet.
//
// Data only. invoice-cpay-v2.html renders this list with DOM APIs
// (textContent), so nothing here is ever parsed as HTML.
//
// Rules for editing (see /docs/WALLETS.md):
//   * status 'verified' needs an official source URL and the date it was
//     checked. Anything else is 'unverified' and is only shown in the
//     generic "Other compatible wallets" group, handing off with the plain
//     lightning: URI, or is disabled.
//   * handoff is how a tap leaves the page:
//       'universal' -> universalLink with {bolt11} replaced
//       'deeplink'  -> deepLink with {bolt11} replaced (app-specific scheme)
//       'lightning' -> the standard lightning:{bolt11} URI; the phone opens
//                      whichever wallet is registered for it
//       'copy'      -> copy the payment request and show `copyHint`; for
//                      apps that only accept a pasted or scanned invoice
//   * Do not add a wallet named after the platform's payment provider, and
//     do not add any traditional payment method. Lightning wallets only.
//   * icon: null renders a neutral monogram in CPAY colours. Do not ship
//     third-party logos without permission.
window.CPAY_WALLETS = Object.freeze([
  {
    id: 'cashapp', displayName: 'Cash App', icon: null, protocol: 'lightning',
    platforms: ['ios', 'android'], handoff: 'universal',
    deepLink: null, universalLink: 'https://cash.app/launch/lightning/{bolt11}',
    lightning: true, invoiceTypes: ['bolt11'], group: 'featured', enabled: true,
    regions: 'US (Lightning not available in New York)',
    verification: {
      status: 'verified', date: '2026-10-03',
      source: 'https://cash.app/help/us/en-us/6506-lightning',
      note: 'Pays Lightning invoices by QR scan (official help). Launch link format from https://docs.voltageapi.com/wallet-deep-linking; Cash App does not publish it on its own help pages.',
    },
  },
  {
    id: 'strike', displayName: 'Strike', icon: null, protocol: 'lightning',
    platforms: ['ios', 'android'], handoff: 'lightning',
    deepLink: null, universalLink: null,
    lightning: true, invoiceTypes: ['bolt11', 'bolt12'], group: 'featured', enabled: true,
    regions: 'US and other supported countries',
    verification: {
      status: 'verified', date: '2026-10-03',
      source: 'https://strike.me/support/how-do-i-send-cash-or-bitcoin/',
      note: 'Send accepts a pasted or scanned BOLT11 invoice. No official app-specific link found, so the standard lightning: URI is used.',
    },
  },
  {
    id: 'wos', displayName: 'Wallet of Satoshi', icon: null, protocol: 'lightning',
    platforms: ['ios', 'android'], handoff: 'lightning',
    deepLink: null, universalLink: null,
    lightning: true, invoiceTypes: ['bolt11'], group: 'featured', enabled: true,
    regions: 'US (returned 2025) and other countries',
    verification: {
      status: 'verified', date: '2026-10-03',
      source: 'https://support.walletofsatoshi.com/en/support/solutions/articles/36000579025-how-to-send-and-receive-bitcoin-in-the-self-custody-wos-wallet',
      note: 'Pays Lightning invoices (official support). US App Store listing: https://apps.apple.com/us/app/wallet-of-satoshi/id1438599608. No documented app-specific scheme.',
    },
  },
  {
    id: 'phoenix', displayName: 'Phoenix', icon: null, protocol: 'lightning',
    platforms: ['ios', 'android'], handoff: 'deeplink',
    deepLink: 'phoenix:lightning:{bolt11}', universalLink: null,
    lightning: true, invoiceTypes: ['bolt11', 'bolt12'], group: 'featured', enabled: true,
    regions: 'US (back in app stores since April 2025) and other countries',
    verification: {
      status: 'verified', date: '2026-10-03',
      source: 'https://github.com/ACINQ/phoenix/issues/251',
      note: 'phoenix:lightning:<invoice> handled on iOS and on Android from 1.4.26 (official ACINQ repository). US App Store listing: https://apps.apple.com/us/app/phoenix-wallet/id1544097028.',
    },
  },
  {
    id: 'coinbase', displayName: 'Coinbase', icon: null, protocol: 'lightning',
    platforms: ['ios', 'android'], handoff: 'copy',
    deepLink: null, universalLink: null,
    lightning: true, invoiceTypes: ['bolt11'], group: 'featured', enabled: true,
    regions: 'Eligible regions; not New York',
    copyHint: 'Copied. In Coinbase, send Bitcoin, choose Lightning and paste.',
    verification: {
      status: 'verified', date: '2026-10-03',
      source: 'https://help.coinbase.com/en/coinbase/trading-and-funding/sending-or-receiving-cryptocurrency/lightning',
      note: 'Sends to a pasted Lightning invoice (official help; page content read via search index because the site blocks automated fetches). No documented app link, so copy and paste.',
    },
  },
  {
    id: 'river', displayName: 'River', icon: null, protocol: 'lightning',
    platforms: ['ios', 'android'], handoff: 'copy',
    deepLink: null, universalLink: null,
    lightning: true, invoiceTypes: ['bolt11'], group: 'featured', enabled: true,
    regions: 'US',
    copyHint: 'Copied. In River, tap Send and paste.',
    verification: {
      status: 'verified', date: '2026-10-03',
      source: 'https://support.river.com/hc/en-us/articles/45489800672915-How-do-I-send-bitcoin',
      note: 'Send accepts a Lightning invoice; account verification required. No documented app link.',
    },
  },
  {
    id: 'muun', displayName: 'Muun', icon: null, protocol: 'lightning',
    platforms: ['ios', 'android'], handoff: 'lightning',
    deepLink: null, universalLink: null,
    lightning: true, invoiceTypes: ['bolt11'], group: 'other', enabled: true,
    regions: 'Not confirmed',
    verification: {
      status: 'unverified', date: '2026-10-03', source: 'https://muun.com/',
      note: 'Advertises Lightning payments (via swaps; can be slow or costly when fees are high). Not checked on an official help page.',
    },
  },
  {
    id: 'zeus', displayName: 'ZEUS', icon: null, protocol: 'lightning',
    platforms: ['ios', 'android'], handoff: 'lightning',
    deepLink: null, universalLink: null,
    lightning: true, invoiceTypes: ['bolt11'], group: 'other', enabled: true,
    regions: 'Not confirmed',
    verification: {
      status: 'unverified', date: '2026-10-03', source: 'https://github.com/ZeusLN/zeus/pull/4123',
      note: 'Registers lightning: and zeusln: on Android (official repo). Needs a configured node or wallet; not suitable as a featured option.',
    },
  },
  {
    id: 'kraken', displayName: 'Kraken', icon: null, protocol: 'lightning',
    platforms: ['ios', 'android', 'web'], handoff: 'copy',
    deepLink: null, universalLink: null,
    lightning: true, invoiceTypes: ['bolt11'], group: 'other', enabled: true,
    regions: 'Not confirmed for the US on the help page',
    copyHint: 'Copied. In Kraken, withdraw BTC on Lightning and paste.',
    verification: {
      status: 'unverified', date: '2026-10-03',
      source: 'https://support.kraken.com/articles/5068216131988-how-do-i-send-bitcoin-on-the-lightning-network-',
      note: 'Withdrawal to a Lightning invoice is documented (updated 2025-12-11) but needs a verified account, a saved withdrawal request and email confirmation, which may outlast the invoice. US availability not stated.',
    },
  },
  // Checked and not offered. Kept so the next person does not re-research.
  {
    id: 'blink', displayName: 'Blink', icon: null, protocol: 'lightning', platforms: ['ios', 'android'], handoff: 'lightning',
    deepLink: null, universalLink: null, lightning: true, invoiceTypes: ['bolt11'], group: 'other', enabled: false, regions: 'Unclear for the US',
    verification: { status: 'unverified', date: '2026-10-03', source: 'https://www.blink.sv/en/features', note: 'Pays BOLT11, but US availability is unclear.' },
  },
  {
    id: 'ndax', displayName: 'NDAX', icon: null, protocol: 'lightning', platforms: ['ios', 'android', 'web'], handoff: 'copy',
    deepLink: null, universalLink: null, lightning: true, invoiceTypes: ['bolt11'], group: 'other', enabled: false, regions: 'Canada',
    verification: { status: 'unverified', date: '2026-10-03', source: 'https://ndax.io/en/blog/article/what-is-btc-lightning-a-beginners-guide', note: 'Lightning withdrawals exist, but NDAX is a Canadian exchange, not a US option.' },
  },
  {
    id: 'bluewallet', displayName: 'BlueWallet', icon: null, protocol: 'lightning', platforms: ['ios', 'android'], handoff: 'deeplink',
    deepLink: 'bluewallet:lightning:{bolt11}', universalLink: null, lightning: true, invoiceTypes: ['bolt11'], group: 'other', enabled: false, regions: 'n/a',
    verification: { status: 'unverified', date: '2026-10-03', source: 'https://bluewallet.io/sunsetting-lndhub/', note: 'Hosted Lightning was shut down in 2023; Lightning now needs your own server. Deep link documented at https://github.com/BlueWallet/BlueWallet/wiki/Deeplinking.' },
  },
]);
