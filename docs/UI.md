# CPAY UI

The site is static HTML. Payment links are unmatched paths, served as
`public/404.html`. Do not move that file.

## Fixed

- Checkout shows only the loading state until the link resolves. Not-found
  is hidden and not announced before that.
- Quick amounts are one set: $10, $20, $50, $100, $200, and $500 on the
  field layout. The keypad layout does not also expose the field chips.
- Keys, pay buttons, and auth controls are at least 44px, with a visible
  focus ring (`public/a11y.css`).
- Login and register errors use `role="alert"`. Forgot password stays on
  the login page.
- The invoice page allows pinch-zoom. `user-scalable=no` is removed.

## Left as they are

- `public/` stays flat. A `pages/` tree would break slug routing unless a
  build step copies files back to the root. There is no such step.
- Checkout themes stay. They apply only to the payment page and the invoice
  page. A domain does not pick a theme.
- `cpay.css` stays the design system. `a11y.css` is the only extra sheet.
