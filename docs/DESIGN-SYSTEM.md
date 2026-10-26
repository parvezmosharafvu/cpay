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
- **Admin Overview** (`.ov-summary`): one card holds the wallet value, a compact grid of totals and
  queues (`.ov-stats`, 4 across on desktop, 2 on phones) and queue chips (`.ov-chip`).
- **Payment cards** ([`pay-cards.js`](../public/pay-cards.js), `.pay-list`, `.pay-card`): admin Overview
  "All payments" and the Payments section. Each payment is a card (amount, account, status); a tap opens
  the details in place (link, method, times, location, invoice ID and Lightning invoice with Copy).
  Search is server-side; status and time filters apply to the loaded rows; "Live" re-reads every 30 s
  while on screen.
- **Tap to expand** ([`responsive-tables.js`](../public/responsive-tables.js), `tr.rt-fold`): when an
  `.rtable` shows as cards, each row shows its first two cells, status and actions; a tap or Enter shows
  the rest. Rows that open a details view (`.row-open`) are left alone.
- **Icons:** `favicon-site.svg` (navy tile, cyan bolt) is the source of `favicon.ico`, `favicon-32.png`,
  `apple-touch-icon.png` and `icon-192/512.png`; the payment pages keep `favicon-payment.svg`.
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

## Pull-chain lamp (log in and register)

`login.html` and `register.html` load [`lamp.css`](../public/lamp.css) and [`lamp.js`](../public/lamp.js).
The page shows a lamp with a pull chain. Since the 2026-10-22 public-journey update,
the light starts on and the form is immediately usable. Turning the lamp off is optional.

- **Chain:** a real `<button id="lampChain">` with `aria-pressed`, `aria-controls` (the card id) and the label
  "Show or hide the form". Tap/click, Enter/Space or a downward drag (pointer events, release past
  28 px) toggles it. Its hit area is 44 px wide.
- **Form:** always in the DOM. While off, `main.auth-card` is `inert` and `aria-hidden`; focus inside it moves
  to the chain first.
- **Progressive enhancement:** the form is hidden only under `html.lamp-js`, which `lamp.js` adds. No JS, or
  a failed init, means the form shows.
- **Opens without a pull:** a URL hash, an auth result in the query (`error`, `confirmed`, `code`, `type`, …),
  typing, password-manager autofill, or a message shown in the card.
- **Look:** shade, beam and card glow use the cyan accent; the card is glass (`backdrop-filter`); the primary
  button is a cyan gradient with dark `--on-accent` text.
- **Motion:** off under `prefers-reduced-motion`.
- **Layout:** ≤ 900 px the lamp is compact at the top right; the form starts near the top; the side panel is hidden in lamp mode.
- **Tests:** e2e and smoke tests call `openAuthForm(page)` (tests/e2e/helpers.ts) before using the form.

## Touch targets (v2.1, 2026-10-21)

Every standalone tap target is at least `--touch` (44 px) tall: `.btn`, `.link-btn` (also inside the
checkout), `.brand`, header `.nav-menu` links, `.foot-links`, the auth-card footer links ("Create one",
"Log in"), `.back-link` on legal pages, and `.check` rows (the whole label is the target). Links inside a
sentence of running text are exempt (WCAG 2.5.8 inline exception). Pages carry no inline `style=""` or
`<style>` for layout; page rules live in `cpay.css`.

## Section context and audit worklist (2026-10-22)

The complete section-by-section backlog is in
[CORE-DESIGN-WORKLIST.md](CORE-DESIGN-WORKLIST.md). It records completed
changes separately from visual and production checks still needed.

Both desks now have one shared `#sectionHint` above the active section.
`shell.js` follows the existing active navigation item and supplies a short
English/Bangla explanation for each section. Admin and member overviews,
links and conversations have audience-specific wording. It does not switch
routes, fetch account data or change permissions. Unknown sections hide the
hint. Language changes refresh both the hint and the top-bar heading.

The shared foundation also wraps long headings and card headers, protects
section grid children from forcing overflow, and styles invalid select
controls consistently with inputs. Small desk buttons keep the same 44 px
minimum touch height as other actions. Admin conversation and owner-guide
rules now live in `cpay.css` rather than an embedded style block.

These source changes are covered by local checks and unit tests. Browser
layout, authenticated data states and production health require separate
verification; they are not certified by the unit test result.

## Home and authentication journey (2026-10-22)

Home explains both receiving modes in a shared two-card layout. The hero,
three-step explanation and custody panel describe fee-first handling without
changing calculations. Native details/summary navigation exposes section links
on smaller screens (1120 px and below, allowing longer translated labels).
The example desk picture remains labelled as an example.

Home, Login, Register and Reset load the same `i18n.js` used by the desks,
with a dedicated language-switch mount and Bengali font support.
`auth-ui.js` enhances password visibility and marked Enter-key actions only;
existing page scripts retain authentication and validation. Password values
are never read by this presentation helper. Skip-link targets are focusable.

The lamp starts on. Its explicit off state, reduced-motion handling,
autofill behavior and no-JavaScript fallback remain. On phones it occupies
a compact top-right area rather than a full-height row before the form.
Implementation tests pass; browser acceptance is tracked separately in
[CORE-DESIGN-WORKLIST.md](CORE-DESIGN-WORKLIST.md).

## Dashboard and link workspace (2026-10-22)

The member overview leads with the available amount and receiving-mode
status, then actions and recent payments. The daily breakdown loads in a
separate panel. Read failures can be retried without sending money. The
receiving-mode label explicitly reports unavailable settings; it does not
infer that Auto withdraw is off. A newer refresh supersedes older reads.

Payment links use local name/slug and status filters, an announced result
count and explicit Preview/Copy/status actions. The new-link composer is a
native details panel; it opens for an empty account or from the new-link
shortcut. Filters and successful status changes update only the list,
preserving the draft and design choices. Existing creation, fee and
settlement RPCs remain unchanged. Small screens use the existing responsive
table cards, with translated `data-label` captions.

Source behavior is covered by unit tests. Browser acceptance for real
layouts and authenticated states remains tracked under V01.

## Payment history and withdrawal journey (2026-10-22)

Payment history pages use 50-row server pages; filter changes reset the
offset. Each row has an explicit details action as well as its existing
row interaction. The modal timeline displays recorded timestamps only.
Read retries and stale-response guards apply to lists and details. Closing
a detail dialog restores focus and invalidates its pending response.

Withdraw introduces a three-step orientation: destination/amount, quote,
passkey confirmation. The original quote and send implementation remains
unchanged. Zero-balance and unavailable-receiving-mode states are explicit.
Withdrawal history can be refreshed separately, without replacing the form;
it states its latest-40 limit and distinguishes an empty result from a
status filter with no matches. New wording has English/Bangla entries.

These are source implementations; browser acceptance remains pending.

## Profile and Security (2026-10-22)

Profile separates public storefront fields from receiving status and saved
addresses. Section links, privacy labels, field hints and a collapsible
balance-payout preference group clarify which controls affect public copy
and which affect private settings. An unavailable receiving-mode read is
not interpreted as Off. Public drafts stay in page memory during address
reloads; they are not persisted across a browser reload. Duplicate saves
are blocked and address removal requires confirmation.

Security uses DOM text nodes for credential names, with loading/error
feedback, a read-only refresh, key count and backup guidance. Failed list
reads do not offer Add/Remove. Credential actions are serialized and retain
the existing confirmation and last-admin-key guards. Only reads refresh
after completion; credential mutations are never automatically retried.

The authentication client and server-side authorization remain unchanged.
Browser layout and real-device passkey ceremonies still require acceptance.

## Support conversations and checkout feedback (2026-10-22)

Member support shows the newest 80 messages in chronological order. Admin
Inbox uses an account selector, local search and a separate conversation
card showing up to the newest 300 messages. Multiline composers use
Ctrl/Command+Enter to send. Page-memory drafts survive read refreshes and
account changes; they do not persist across a browser reload. In-flight
mutations cannot be duplicated, and uncertain sends are never retried
automatically. Messages remain escaped text with preserved line breaks.

Checkout uses a separate live region for status-read availability. Network
read failures cannot imply settlement or trigger new invoices. Merchant
palettes and both invoice entry points retain identical shared markup.
Receipt time is labelled Confirmation seen because it is the time the page
observed the confirmation. The underlying invoice, amount and expiry
logic remains unchanged. Checkout keeps its existing language behavior.

Browser layouts, live support messaging and real-payment acceptance remain
tracked separately from source tests.

## Store and operational overview — batch 7

Store discovery filters only the already loaded public payment links. Search never creates an invoice. Read failures expose retry; sharing has cancellation and clipboard failure feedback. Merchant theme behavior is preserved. Admin overview reads have bounded waits and response guards; wallet availability does not block the activity boards. Unavailable balances and queues are distinct from zero and empty results. Review shortcuts lead to the existing administrative sections; payment calculations and protected mutation endpoints remain unchanged. Browser and live-service acceptance remain pending.

## Administrative review queues — batch 8

Users and applications preserve search/status state through read refreshes, show explicit read failures and expose references in native details. Optional account reads may fail independently; unknown withdrawal settings are disabled rather than assumed. Application history uses the existing nullable status parameter; review actions appear only on waiting rows. Payout filters cover the latest 120 requests, and forward filters read up to 200 records for the selected status; both limits are visible. Forward search is local to loaded records and does not call a mutation. Existing payout step-up, confirmation prompts, monetary values and administrative endpoints remain. Busy state prevents duplicate application/payout decisions and serializes forward actions in their panels. These guards do not replace server authorization or transaction locking. Browser and live acceptance remain pending.

## Wallet and location states — batch 9

Platform wallet refresh reads balances, currency rates and history without submitting a quote or send. Failed balance reads clear stale figures; read completion time is separate from registry sync time. Owner registry refresh preserves the existing add-form DOM, shows sync details and removes stale lists on failure; mutation serialization supplements existing server constraints and passkey checks. Location filters preserve drafts and show format validation, bounded read failures, current-profile versus payment-date scope, and detail-list limits. Location references remain display only. No monetary formula, send implementation, schema or authorization rule was changed. Browser and live-service acceptance remain pending.

## Operational evidence and receipt decisions — batch 10

Health and System show partial-read failures independently, preserving successful snapshot evidence without interpreting an absent query as healthy or alert-free. Refreshes read existing endpoints; old responses cannot replace newer reads. Audit shows full references and labels its latest-120-row search scope. Receipt review shows full evidence in native details, labels its latest-200-record status scope and serializes each receipt decision while preserving the note prompt. Resolving/dismissing records an audited flag only; it does not move money. Shared CSS handles operational card layout and scrollable evidence tables. Browser and live backend acceptance remain pending.

## Settings drafts and owner guide navigation — batch 11

Platform Settings preserves ordinary field drafts in memory and serializes its save operations, while read failures remain distinct from real zero-valued fees. Existing grouped owner sections, confirmation prompts, RPC contracts and step-up remain. Owner-config transport failures return explicit uncertainty and secret fields retain post-attempt clearing. Owner guide adds heading navigation and separate guide/status refreshes, with distinct unavailable, owner-only and weak-session feedback. The guide is still owner served; only secret names are displayed. Bangla quick-reference content and its generated function payload were rebuilt together. Live settings were not changed; browser/live acceptance and owner-guide deployment remain pending.

## Wallet PWA read states and activity — batch 12

Wallet PWA balances and activity have independent read status, bounded waits and guards against stale/locked-session responses. Local activity filters show loaded-record counts and complete references; pending send checks remain read-only. Receive copy has explicit fallback feedback. Send preparation/confirmation/outcome/retry code, recovery, engine, service worker and custody boundaries remain unchanged. Owner deferred Legal / Contact entry to the dashboard after project completion; publication is not approved by this source update. Wallet build is pending dependency installation, and browser/real-device/offline/live-wallet acceptance remains pending.

## Bengali fallback and Settings controls — batch 14

Shared CSS self-hosts Noto Sans Bengali 400/600 Bengali subsets, sourced from Fontsource 5.3.0 under the bundled SIL OFL license. The existing font stack uses this fallback for Bengali letters and punctuation while retaining Latin/system faces. Settings editors wrap fields and Save controls inside the card; owner domain/secret inputs reuse the shared input class. Automated desk fixtures verify EN/BN navigation and page bounds at 390px and 1440px; full live/populated/physical-device acceptance is still pending.

## Invoice notices and mobile payout details — batch 15

Checkout float notices override the desk toast top anchor so they remain short bottom notices instead of stretching across the invoice. The QR logo hides when only request-text fallback is available. Payout tables reuse the shared responsive labelled rows; narrow-container details and addresses wrap in full. Presentation changes preserve source amounts, protected controls and invoice/status logic. Local browser fixtures cover all ten merchant designs at 390px/1440px; real QR/network/physical-device acceptance remains separate.
