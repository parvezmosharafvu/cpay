# Redesign test report (2026-10-17)

> **Historical document.** It describes a superseded design. The current system is in
> [SYSTEM-OVERVIEW.md](SYSTEM-OVERVIEW.md) and [../AGENTS.md](../AGENTS.md); where they disagree, they win.

What was run for the design system v2 change ([DESIGN-SYSTEM.md](DESIGN-SYSTEM.md)), what passed, and what
still needs a person. Everything automated ran against a **disposable local stack** ([E2E.md](E2E.md)): a
local Postgres with every migration, PostgREST with row-level security, the real `create-invoice` and
`user-withdraw` Edge Functions, and the payment service with a fake wallet SDK. **Nothing touched
production, and no real money moved.**

## Automated checks

| Check | Command | Result |
|---|---|---|
| Frontend static checks (syntax, DOM ids, RPC names, payment accessibility contract, reserved slugs, provider name, trackers) | `python3 ci/check_frontend.py` | Passed |
| Public copy (no processor name, no traditional payout rails) | `python3 ci/check_public_copy.py` | Passed |
| Legal drafts stay unlinked and `noindex` | `python3 ci/check_legal.py` | Passed |
| Markdown links | `python3 ci/check_md_links.py` | Passed |
| Workflows pinned | `python3 ci/check_workflows.py` | Passed |
| Frontend unit tests, including navy WCAG contrast pairs and the custody wording | `node --test tests/frontend/*.mjs` | 125 / 125 passed |
| Public Playwright smoke on the built bundle | `npx playwright test -c tests/public-smoke/playwright.config.ts` | 15 / 15 passed |
| Full E2E: auth, slug routing, payment page, invoice lifecycle, Freelancer desk, withdrawal, authorization, responsive and accessibility, account type, MFA, passkeys, CAPTCHA, Google sign-up, page scripts | `npx playwright test -c tests/e2e/playwright.config.ts` | 106 / 106 passed |
| axe-core 4.10.3, WCAG 2.0/2.1 A and AA: landing, sign-in pages, Download wallet, design preview, not-found, payment page and invoice, all desk tabs, admin overview, at 1440 px and 390 px | local scan script | 32 scans, **0 violations** after the fix below |
| Phone drawer: focus moves inside, Tab stays inside, Esc closes and returns focus, picking a section closes it; the tab bar marks the current section; tab-bar targets ≥ 44 px | local Playwright script | Passed |
| Reduced motion: drawer transition off | local Playwright script | Passed |

The axe scan found one real defect, present on `main` before this change. The QR image drawn by the QR
library had no alt text (`image-alt`, critical) on the invoice page and the design preview. It is fixed: the
image is marked decorative, because the QR button already carries the label.

## Viewports, overflow and console errors

A local Playwright script loaded **29 views** at **six viewports**: 360 × 740, 390 × 844, 430 × 932,
768 × 1024, 1440 × 900 and 1920 × 1080, so **174** page-and-viewport checks in all. The views were:

- **Public pages:** landing, log in, open an account, reset, design preview, Download wallet, unknown link.
- **Freelancer desk:** the seven tabs.
- **Payer journey:** storefront, payment page, invoice, payment received.
- **Admin desk:** eleven tabs.

| Viewport | Views | Horizontal overflow | Console or HTTP errors |
|---|---|---|---|
| 360 px | 29 | 0 | 0 |
| 390 px | 29 | 0 | 0 |
| 430 px | 29 | 0 | 0 |
| 768 px | 29 | 0 | 0 |
| 1440 px | 29 | 0 | 0 |
| 1920 px | 29 | 0 | 0 |

Some errors are excluded, each for a stated reason:

- **Expected 404s.**
  - A payment slug is served through `404.html` by design.
  - The payment page first tries a same-origin `/api/create-invoice`, then falls back to the Edge Function.
- **Local-only gaps.**
  - Fonts are mapped to a local stub.
  - The local stack does not run the `admin-actions` Edge Function.

The same checks on `main` before the change (desktop and 390 px) found no overflow either. The redesign keeps
that while changing every layout. The existing E2E test at 320 px (`responsive-accessibility.spec.ts`) also
passes.

## Screenshots

Before (`main` 5ac60f4) and after screenshots of each key page, at desktop and phone widths, are in the
review gallery linked from the pull request.

## What these checks do not prove

- The live site was not loaded: this environment cannot reach `pay-cashapp.buzz`. Check the deployed preview
  of the pull request on a real phone.
- Real Lightning wallets, Cash App, real USDT payouts and a real authenticator app were not used. The E2E
  stack fakes the wallet SDK.
- The admin Wallet and Health cards need the `admin-actions` Edge Function, which the local stack does not
  run. Those cards were checked for layout only, with their error state.
- Screen readers were not driven. axe checks structure and contrast, not the spoken experience.

## Manual checks for the owner (on the pull request's preview deployment)

1. **Phone (about 390 px):**
   - log in, and the desk shows the bottom tab bar;
   - open **More**: the drawer slides in and **Log out** is at the bottom;
   - open each section, and the title at the top changes.
2. **Phone:** on Payments and Withdraw, each row is a card with labels, and nothing needs sideways scrolling.
3. **Desktop:** the sidebar stays in place while the page scrolls; the account chip shows the account name
   and type.
4. **Landing page:** the header links jump to their sections; "Where money is held" reads "held by CPAY".
5. **Payment link:** open one of your links. It still shows the design you chose for it. Pay a small amount
   from Cash App, and the invoice turns to "Payment received".
6. **Unknown link:** an address such as `/no-such-link` shows "Payment link not found".
7. **Admin, phone and desktop:** the overview KPI strip, the applications list with Approve / Reject, and the
   payouts list.
8. **Keyboard on desktop:** Tab from the top of the desk. The first stop is "Skip to desk", and focus rings
   are visible on every control.
