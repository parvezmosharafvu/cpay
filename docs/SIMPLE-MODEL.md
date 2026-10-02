# Simple CPAY model

Receive stays Lightning (payer scans a QR from Cash App or any Lightning wallet).
Payout is USDT only, to a saved address on a supported network.
USDC is only used if a live route offers it. Stable Balance is off: sats stay
in the platform wallet until a USDT quote is confirmed.

## One payout book

Each account saves one USDT address per network in `usdt_wallets`.
Preferred network + optional dollar threshold live on `profiles`.

- Save address, then withdraw.
- Set a threshold and turn auto-withdraw on → `system_queue_withdrawal` files a USDT payout when available balance reaches the threshold.
- Or press Withdraw on the desk → quote/confirm through the payment service.

Not offered: bKash, Nagad, Binance Pay, bank, or a Lightning payout.
`request_withdrawal` is closed.

## Themes

Themes exist only for the payment-link page and the invoice page.
A domain does not pick a theme.

## Checkout page

`public/404.html` is the payment page (unmatched paths are slugs). It is not
a folder of separate pages.

- Loading is the only visible state until the link resolves. Not-found is
  hidden and not announced until the lookup fails.
- Quick amounts are one set: $10, $20, $50, $100, $200, and $500 on the
  field layout. Keypad layout uses $10–$200. Both are not exposed at once.
- Keys and the pay button are at least 44px, with a visible focus ring.
