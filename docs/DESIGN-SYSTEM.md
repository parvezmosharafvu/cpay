# CPAY design system (v2, 2026-10-17)

One stylesheet, [`public/cpay.css`](../public/cpay.css), styles every page. [`public/a11y.css`](../public/a11y.css)
adds touch targets, focus rings and reduced motion. Pages carry no palette of their own. The website,
desks and legal pages (contact, privacy, terms, refund; `body.legal`) opt in to the navy palette with
`<html data-ui="navy">`. The not-found states of the checkout (`404.html`) and the store (`store.html`) are
CPAY's own pages, not a merchant's, so they call `useNavyState()` (`theme.js`): it drops any checkout
design and switches to navy. The payment pages (checkout, invoice, store)
keep the light base under each merchant's chosen checkout design, so payers see the design the merchant picked.

The visual direction comes from the owner's reference board (dark crypto-wallet interface, restrained cyan
accent). Its copy is **not** used: the board says "non-custodial wallet" and names traditional payout rails,
and the website is custodial. See "Product rules kept" below.

## Tokens

| Group | Tokens | Notes |
|---|---|---|
| Surfaces | `--bg #0a1120`, `--surface #0f1a2e`, `--surface-2 #15223a`, `--surface-3`, `--side-bg` | `--bg` is also the browser `theme-color` |
| Lines | `--line`, `--line-strong` | `--line-strong` is the input border (at least 1.6:1 on a card) |
| Text | `--text #e7edf6`, `--muted #b0bccf`, `--faint #94a1b8` | each at least 4.5:1 on every surface (tested) |
| Accent | `--accent #22d3ee`, `--accent-hover`, `--accent-soft`, `--accent-ring`, `--on-accent`, `--accent-2 #3b82f6` | one accent; `--accent-2` only in decorative gradients |
| Status | `--success`, `--danger`, `--warn`, `--info-fg`, each with `-soft` and `-line` | AA on their own tints (tested) |
| Type | `--font` (Inter), `--mono`, `--text-xs` 12 … `--text-4xl` 52 | numbers use tabular figures |
| Space | `--space-1` 4 … `--space-10` 96 | 4-px base |
| Radius | `--radius-sm` 8, `--radius` 12, `--radius-lg` 16, `--radius-xl` 20, `--radius-pill` | navy values; the light base keeps 10 and 14 |
| Layout | `--sidebar-w` 256, `--topbar-h` 64, `--tabbar-h` 64, `--content-max` 1240, `--site-max` 1180 | |
| Motion | `--ease` | all motion is off under `prefers-reduced-motion` |
| Layers | `--z-nav`, `--z-drawer`, `--z-modal`, `--z-sheet`, `--z-toast` | |

[`tests/frontend/navy-theme.test.mjs`](../tests/frontend/navy-theme.test.mjs) checks every navy text pair
for WCAG AA contrast. An axe-core scan of the redesigned pages found no contrast failures (see
[REDESIGN-TEST-REPORT.md](REDESIGN-TEST-REPORT.md)).

## Breakpoints

| Width | What changes |
|---|---|
| ≤ 1280 px | Overview stat tiles wrap |
| ≤ 1080 px | Two-column desk grids become one column |
| ≤ 960 px | Landing hero becomes one column; the sign-in product panel hides; section links leave the header |
| ≤ 900 px | Desk sidebar becomes a drawer (menu button, scrim, focus kept inside, Esc closes); a bottom tab bar holds the main sections; the status message floats above the tab bar |
| ≤ 900 px and height ≤ 480 px | Landscape phones: the tab bar hides, the drawer stays |
| ≤ 720 px | Desk filter fields stack |
| container ≤ 640 px | **Responsive tables** (`.rtable`) become labelled cards. This is a container query on `.card.flush` / `.scroll`, so a table in a half-width card also switches on a wide screen |
| ≤ 600 px | Overview quick actions go full width; stat tiles two per row |
| ≤ 520 px | The landing product picture drops its chart |
| ≤ 360 px / ≤ 320 px | Smallest phones: tighter padding and type |

Safe areas: the desk top bar, the bottom tab bar, the drawer and the payment sheet use
`env(safe-area-inset-*)`. Pages use `100dvh` where the mobile browser bar matters.

## Components

- **App shell** (`.shell`, `.side`, `.app-top`, `.tabbar`, [`shell.js`](../public/shell.js)):
  - grouped sidebar with icons and an active indicator;
  - account footer;
  - sticky top bar with the section title (`#pageTitle`) and an account chip;
  - phone drawer and bottom tab bar.

  `shell.js` only forwards tab-bar taps to the matching sidebar button and mirrors its state. The desk scripts
  stay the only code that switches sections.
- **Cards:**
  - `.card`, `.card.flush` (tables);
  - `.card-head` and `.card-title` headings;
  - `.balance-card` (overview hero);
  - `.stat` tiles with `.stat-ico`.
- **Lists:** `.activity` (recent payments: status icon, title, time, amount).
- **Tables:**
  - `.table` (sticky-column scroll on phones);
  - `.table.rtable` (cards when narrow; cells carry `data-label`, `.lead` spans the card, `.cols-3` for
    figure-heavy tables).
- **Buttons:** `.btn.primary`, `.btn.ghost`, `.btn.quiet`, `.btn.danger`, sizes `.sm` and `.lg`, `.block`.
- **Forms:**
  - `.field` (labels above, 44 px inputs, 16 px text on navy so iOS does not zoom);
  - custom select arrow;
  - `.check` (checkbox rows);
  - `.choice` radio cards.
- **Status:** `.badge` (status pills), `.alert-*`, `.callout`, `#toast` (floating, hides after 8 s or on tap).
- **States:**
  - `deskSkeleton()` (loading);
  - `deskEmpty()` (icon, title, hint);
  - `deskError()` (`role="alert"`);
  - payment-page loading, error and not-found cards.
- **Site:**
  - `.site-head` (sticky, blurred), `.hero-grid`, `.mock` (decorative product picture, `role="img"` with a
    text description);
  - `.steps`, `.features`, `.split-cards`, `.custody-box`, `.cta-band`, `.site-foot`.
- **Sign-in:** `body.auth.split`, `.auth-shell`, `.auth-aside` (product panel), `.auth-main`.

## Route inventory

| Route | File | Audience | Before (audit, `main` 5ac60f4) | Now |
|---|---|---|---|---|
| `/` | `index.html` | everyone | One hero, three cards, a custody card. No section navigation or "how it works". One-line footer | Sticky header with section links; two-column hero with an example desk picture and a trust row; how it works; features; account types; security; custody (two panels, same wording); call to action; footer |
| `/login.html` | `login.html` | members | Centred card; no product context on desktop | Split layout with a product panel on wide screens; passkey button, CAPTCHA and the two-step prompt unchanged |
| `/register.html` | `register.html` | new members | Centred card | Split layout; Individual / Business / Organization radio cards unchanged |
| `/reset.html` | `reset.html` | members | Centred card | Split layout; every reset state unchanged |
| Two-step sign-in prompts | `mfa.js`, `reauth.js` dialogs | members | Shared tokens | Unchanged markup; restyled through tokens |
| `/dashboard.html` | `dashboard.html`, `freelancer-desk.js`, `daily-desk.js`, `app.js` | Freelancer | Text-only sidebar that became a sideways-scrolling strip on phones (items clipped, no section title). The name was the only heading. Overview opened with the profile card; the 14-day table dominated. Tables scrolled sideways on phones. The status message pushed the layout and never hid | App shell with drawer and tab bar; section title as `h1`. Overview opens with the available balance (held by CPAY), Withdraw / New link actions, recent payments and three stat tiles; the profile and business-day cards follow. Links, payments, withdrawals and saved addresses are cards on phones. "Copy link" on each link. Own chat messages aligned as yours |
| `/admin.html` | `admin.html`, `admin-*.js` | Admin | 16-item flat sidebar; overview KPI cards split around the users table | Grouped sidebar (Overview, People, Money, Operations, Settings); one KPI strip; applications, payouts, payments and users as responsive lists with "all …" shortcuts. Server-side admin checks unchanged |
| `/<slug>` | `404.html` | payers | Merchant design; bare "404" not-found | Merchant design unchanged; not-found and load-error states with icons and clearer guidance ("nothing has been charged") |
| `/invoice-cpay-v2.html` | `invoice-cpay-v2.html` | payers | Merchant design; the QR image had no alt text (axe critical) | Merchant design unchanged; the QR image is marked decorative (its button carries the label) |
| `/store.html?u=` | `store.html` | payers | Merchant design | Unchanged |
| `/theme-preview.html` | `theme-preview.html` | Freelancer | Navy; sample QR without alt text | Alt fix |
| `/assets/wallet.html` | `assets/wallet.html` | members | "Not available yet" alert broke into a narrow column | Document layout, highlighted release card, alert fixed. Still no download link (release gates G1–G8 open) |
| `/admin-classic.html` | `admin-classic.html` | legacy | Ops styles | Unchanged |
| `/terms.html`, `/privacy.html`, `/refund.html`, `/contact.html` | legal drafts | — | Drafts, `noindex`, unlinked | Unchanged: they belong to the legal release PR |

## Product rules kept

- **Custody.** The website says the balance is held by CPAY, and never calls itself non-custodial. CPAY Wallet
  is described as a separate app ([WALLET-APP.md](WALLET-APP.md)).
- **Public copy.** No processor name and no traditional payout rail anywhere public, not even to say it is
  not offered (`ci/check_public_copy.py`).
- **Roles.** Account types are Individual and Business / Organization. Roles are Freelancer and Admin only;
  there are no reseller or commission screens.
- **Routing and themes.**
  - Slug routing through `public/404.html` is unchanged.
  - `public/` stays flat.
  - Checkout designs stay on the payment and invoice pages.
- **Tests.** Every ID, `data-*` hook and text that tests rely on is kept, including:
  - the order of the desk sidebar tabs (`.side .navi[data-tab]`);
  - `#hello`, `#deskKind`, `#toast`, `#wAvail`;
  - the tables under `#pay`, `#links` and `#wHist`.

## Rollback

The redesign is static files only: no migration, no Edge Function and no setting. To roll back, revert the
merge commit, or redeploy the previous Workers deployment of `cpay`. Script URLs carry new `?v=` values, so
browsers fetch the matching versions.

## Touch targets (v2.1, 2026-10-21)

Every standalone tap target is at least `--touch` (44 px) tall: `.btn`, `.link-btn` (also inside the
checkout), `.brand`, header `.nav-menu` links, `.foot-links`, the auth-card footer links ("Create one",
"Log in"), `.back-link` on legal pages, and `.check` rows (the whole label is the target). Links inside a
sentence of running text are exempt (WCAG 2.5.8 inline exception). Pages carry no inline `style=""` or
`<style>` for layout; page rules live in `cpay.css`.
