# Local browser verification — batch 13

Scope: source archive checked locally in Chromium; no deployment or live payment acceptance.

| Check | Result | Practical limit |
|---|---|---|
| Node frontend suite | 255 passed | API calls are test doubles |
| Public smoke + layout | 31 passed | Local static server; no signed-in desk acceptance |
| Layout subset rerun after opacity stabilization | 8 passed | 390px/1440px; home/login/register/store; external requests blocked |
| Wallet fake-engine browser suite | 25 passed | Test engine; test account API; no payment network |
| Real SDK + virtual passkey suite | 5 passed, 1 skipped | Physical authenticators and live-regtest connection not tested |
| Real SDK regtest build | Passed | Not mainnet production release; no mainnet key |
| Frontend/copy/legal/links/workflows/guide | Passed | Source checks, not live configuration evidence |

## Reproduce

From repository root, install locked root and wallet dependencies with npm ci --ignore-scripts, then install the Playwright Chromium browser. Run:

```sh
node --test tests/frontend/*.test.mjs
npx playwright test -c tests/public-smoke/playwright.config.ts
npx playwright test -c tests/wallet/playwright.config.ts --project=fake-engine
npx playwright test -c tests/wallet/playwright.config.ts --project=real-sdk --project=real-passkey
```

The public config now starts its local server unless CPAY_BASE_URL is supplied. Python 3 is required for this default server. Wallet config builds test/regtest copies and serves them locally. WALLET_LIVE stays unset for this evidence; do not interpret the skipped live test as a pass.

## Remaining acceptance

Signed-in member/admin visual fixtures; English/Bangla text and font rendering; successful merchant themes/checkout and complete error/loading/empty matrices; physical phone and installed-PWA/passkey behavior; mainnet build/release gates; real sync, ledger reconciliation and restore drill. Legal / Contact entry remains owner-deferred. Existing production blockers remain authoritative; these results do not authorize publication or transfer money.

## Batch 14 update

Public smoke/layout now includes desk-fixture.ts and desks.spec.ts: 41 combined tests pass. Eight successful member/admin scenarios cover 390px/1440px and English/Bangla; two additional scenarios cover read failures. A final ten-test desk subset also verifies no uncaught page errors, local Bengali-font loading and Settings Save control bounds. Test routes mock authentication/session/profile and backend APIs, blocking external requests. This proves presentation under those responses, not real authentication, RLS or transaction behavior.

Local Noto Sans Bengali 400/600 subsets now render Bengali text without a device font or external font request. Source: @fontsource/noto-sans-bengali 5.3.0; bundled license: public/fonts/NotoSansBengali-LICENSE.txt. Only Bengali subsets are shipped; existing Latin/system typography remains. Inspected screenshots confirm Bengali home text and admin Settings controls, including corrected punctuation and previously clipped Save/unstyled fields.

Populated/long-list and all loading/error combinations, merchant-success themes/checkout, owner-only screens, physical-device and installed-PWA behavior, deployment/live-service/reconciliation remain pending. No production acceptance or legal publication is implied.

## Batch 15 update

The combined local public suite now has 71 passing tests. New cases cover the ten merchant designs at 390px/1440px, existing synthetic invoices with pending/settled/expired/invalid status, populated store search/errors, and long member-link/payout rows. A merchant-only rerun verifies QR-logo suppression when the library is absent. No Pay, regenerate or invoice-create action is clicked, and external merchant test requests are blocked.

Reviewed screenshots exposed and verified fixes for an oversized checkout toast and horizontally trapped payout details. Responsive payout rows preserve full address/reference/note readability; all payout action handlers and invoice logic remain unchanged.

These merchant scenarios deliberately test missing-QR-library fallback, not QR encoding or a successful external QR library load. Complete physical-device, owner-only UI, accessibility/state coverage and live production acceptance remain pending. Run the public config with --workers=1 in constrained environments. Internal screenshots and generated builds are excluded from the source archive.

## Batch 16 update

The public test config now contains 77 passing Chromium scenarios, including six axe-core scans of the member/admin overview at two widths and stable login/register forms. WCAG 2 A/AA and 2.1 AA tagged rules reported no violations in these states. No-JavaScript form fallback continues to be checked separately by the older smoke tests. Automated scan results do not replace full state coverage, screen-reader or physical-device testing.

Use npm run test:public for the combined suite or npm run test:accessibility for its six-scan subset. Release/source evidence and remaining owner/live requirements are separated in [RELEASE-READINESS.md](RELEASE-READINESS.md).

## Batch 17 final combined run

96/96 Chromium scenarios passed, including 19 owner settings/guide tests and the existing six accessibility scans. Owner fixture responses contain names/status only; write methods reject. The guide uses the committed generated HTML rather than substitute content. 255/255 frontend tests also passed. Prior batch totals are historical subsets, not additive. See [FINAL-HANDOFF.md](FINAL-HANDOFF.md).

## Batch 18 wallet rerun

Final wallet suite: 31 passed, one live-regtest test skipped. The new fake-engine accessibility scenario scans welcome, unlocked overview and locked vault at the configured Pixel 7 viewport: zero WCAG 2 A/AA and 2.1 AA tagged violations, with no exclusions. This is separate from the previously recorded 96-test public suite; the public suite was not rerun because no public app or public fixture changed.

Read-only repository observations and integration prerequisites are recorded in [RELEASE-EVIDENCE-SNAPSHOT.md](RELEASE-EVIDENCE-SNAPSHOT.md).

## Batch 20 — Rendered merchant QR roundtrip

Final combined public suite: 116/116 passed; frontend suite: 255/255 passed. This supersedes the earlier 96-test public count. Twenty new scenarios cover ten themes at 390px/1440px. They serve the real qrcodejs 1.0.0 bytes from a pinned development dependency through a local route; their SHA-384 hash matches the existing production CDN integrity attribute. The production CDN URL and integrity setting are unchanged.

Each case creates the normal invoice view with a synthetic, non-payable request string of invoice-like length. PNG capture of the rendered QR container includes CSS scaling and the central logo overlay; jsQR decodes the pixels back to exactly the request text. Tests also check the raw request text, absence of fallback, visible logo and no horizontal document overflow. This verifies encoding and display under the fixture, not BOLT11 validity, external CDN availability, physical-camera scanning or a paid invoice.

qrcodejs 1.0.0, jsqr 1.4.0 and pngjs 7.0.0 are pinned test-only dependencies with lockfile entries. merchant-fixture.ts is shared by existing fallback/state cases and the new successful-library cases. No production app code changed; generated screenshots/dependencies remain outside the archive.

## Batch 21 — Section accessibility and keyboard scrolling

Final combined public browser suite: 121/121 passed; frontend: 255/255 passed. Five new browser cases extend the previous 116. Four scan loops cover member Links, Payments, Withdraw, Chat, Profile and Security, and admin People, Applications, Payouts, Health, System, Audit, Receipts and Settings at 390px/1440px, using populated English-language fixtures. These add 28 axe scans; together with the earlier six this is 34 public scans across ten scenarios. The fifth case verifies actual ArrowRight scrolling and removal of the extra tab stop when the table fits after resizing.

The first scan found scrollable-region-focusable failures in mobile admin Health, System, Audit, Receipts and Settings. responsive-tables.js now adds tabindex=0 and a named region to overflowing table wrappers that do not already have a tabindex. It removes attributes it owns when overflow ends and responds to DOM/section visibility, resize and language events. Existing author-supplied names/roles/tabindex are preserved. Shared script query versions were bumped on dashboard/admin pages.

After the fix, all scans reported zero WCAG 2 A/AA and 2.1 AA tagged violations in the tested states; no rule or element was excluded. This is not complete state coverage, translated-state accessibility or screen-reader/physical-device certification. Tables, financial values, existing action handlers and authorization are unchanged.

## Batch 22 — Bengali section accessibility

Final combined public browser suite: 125/125 passed. The four additional cases run the same 14 internal member/admin sections at 390px/1440px with Bengali selected and assert html lang=bn. They add 28 WCAG 2 A/AA and 2.1 AA tagged scans. The public suite now has 62 axe scans across 14 scenarios, plus the separate keyboard scrolling case. All tested scans report zero violations without excluding rules or elements.

No new defect was found in these Bengali fixture states. Production code is unchanged in this batch. The last 255-test frontend run remains Batch 21 evidence and was not rerun for this test-only extension. Historical totals above are not additive. Translation completeness, every dynamic state, screen-reader operation, physical-device/camera/PWA and real-RLS/live acceptance remain separate.
