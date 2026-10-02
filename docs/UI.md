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
- Login, register, and reset errors use `role="alert"`.
- The invoice page allows pinch-zoom. `user-scalable=no` is removed.
  Unpaid and paid steps stay hidden from assistive tech until shown.

## Supabase Preview

Preview failed because remote version `20261001050736` was not in
`supabase/migrations/`. That file is now in the repo. The other remote
USDT versions (`20260929102056`, `20260929103557`, `20260929142917`) were
already present.

## Left as they are

- `public/` stays flat. A `pages/` tree would break slug routing.
- Checkout themes stay on the payment page and the invoice page.
- A domain does not pick a theme.
