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

## Chat 2 (design system)

- One design system file: `public/cpay.css` (tokens, cards, forms, buttons, alerts, skeleton, status timeline).
- `public/a11y.css` enforces 44px touch targets and `prefers-reduced-motion`.
- Landing, auth, store, payment slug (`404.html`), and invoice pages share skip links, alerts, and light `color-scheme` to avoid theme flash.
- Invoice shows a payment status timeline, expiry countdown, copy/share/QR download, and retry after expiry.
- Checkout designs still come from the payment link (or invoice `theme` query); domains do not pick a theme.
- Do not advertise traditional payout rails or name the wallet processor on public pages.

## Chat 3 (authenticated desks)

- Freelancer (`dashboard.html` + `freelancer-desk.js`): payment and withdrawal filters, link on/off, skeleton/empty/error states, skip link + `a11y.css`.
- Admin (`admin.html` + `admin-*.js`): Manage users Status control, payment/payout/audit filters, same design-system loading states.
- Roles in UI: Freelancer (`creator`) and Admin only. Reserved slugs still list `moderator`/`reseller` so those paths are not payment links. Do not reintroduce reseller desks.
- Authz: `loadProfile` signs out non-active accounts; admin RPCs / `admin-actions` require `role=admin` on the server. Hidden UI is not a privilege boundary.
