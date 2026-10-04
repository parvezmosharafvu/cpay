# CPAY UI

The site is static HTML. Payment links are unmatched paths, served as
`public/404.html`. Do not move that file.

## Fixed

- Checkout shows only the loading state until the link resolves. Not-found
  is hidden and not announced before that.
- Quick amounts are one set: $10, $20, $50, $100, $200, and $500 on the
  field layout.
- Login, register, and reset errors use `role="alert"`.
- The invoice page allows pinch-zoom. Help stays hidden until opened.
- The freelancer desk remembers the open tab across refresh
  (`cpay-freelancer-tab`). Admin already did this.

## Left as they are

- `public/` stays flat. A `pages/` tree would break slug routing.
- Checkout themes stay on the payment page and the invoice page.
- A domain does not pick a theme.

- The freelancer Withdraw tab lists the last 30 payouts: when, status, network, requested, after fee, address.
- Checkout stores the server `cashAppUrl`. The invoice page opens that link, and builds one if the server did not send it.
