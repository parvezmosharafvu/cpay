# CPAY audit and core design worklist

Created 2026-10-22 (Asia/Dhaka) from the supplied ZIP. This is a working checklist, not proof of production health.

Sequence: audit and documentation, portable checks, shared foundation, then sections in the order below. Each section needs source review, justified changes, and verification before completion. Existing layouts are a starting point; they are not automatically marked complete. No deployment or live payment is included.

Status: Pending, In progress, Implemented (browser QA pending), Complete, or Needs production/owner evidence.

| ID | Priority | Section | Work / acceptance | Status |
|---|---|---|---|---|
| A01 | P1 | Audit | Run local checks; distinguish source defects from unavailable runtime checks | Complete (local scope) |
| A02 | P1 | Documentation | Remove contradictory retired authenticator instructions | Complete |
| A03 | P1 | Tooling | Make public-file scan work with Windows paths and Markdown check work on ZIP exports | Complete |
| D01 | P1 | Foundation | Keep shared tokens; consistent section headings, cards, form controls, focus and states | Complete (shared foundation; local browser coverage recorded below) |
| D02 | P2 | Home | Product explanation, how it works, custody, security and primary account action | Implemented; local browser coverage recorded below; live/manual acceptance outstanding |
| D03 | P2 | Authentication | Visible form access, passkey, validation and recovery | Implemented; local browser coverage recorded below; live/manual acceptance outstanding |
| D04 | P1 | Dashboard | Available balance, primary actions, recent activity and daily summary | Implemented; local browser coverage recorded below; live/manual acceptance outstanding |
| D05 | P2 | Payment links | Filters, link list, copy/preview/status controls and creation | Implemented; local browser coverage recorded below; live/manual acceptance outstanding |
| D06 | P1 | Payments | Filters, status, amount, details and timeline | Implemented; local browser coverage recorded below; live/manual acceptance outstanding |
| D07 | P1 | Withdraw | Balance, destination, review, passkey confirmation and history | Implemented; local browser coverage recorded below; live/manual acceptance outstanding |
| D08 | P2 | Profile | Account details, receive address and Auto withdraw | Implemented; local browser coverage recorded below; live/manual acceptance outstanding |
| D09 | P1 | Security | Passkeys and protected-action guidance (no new session-management API) | Implemented; local browser coverage recorded below; live/manual acceptance outstanding |
| D10 | P2 | Chat / Inbox | Thread list, selected conversation and composer | Implemented; local browser coverage recorded below; live/manual acceptance outstanding |
| D11 | P1 | Checkout / Invoice | Merchant identity, amount, QR, expiry, status and receipt; preserve merchant theme | Implemented; local browser coverage recorded below; live/manual acceptance outstanding |
| D12 | P2 | Store | Merchant header, payment option discovery and checkout links | Implemented; local browser coverage recorded below; live/manual acceptance outstanding |
| D13 | P1 | Admin overview | Operational health links, urgent queues and financial summary | Implemented; local browser coverage recorded below; live/manual acceptance outstanding |
| D14 | P2 | Users / Applications | Search, status, details and permitted actions | Implemented; local browser coverage recorded below; live/manual acceptance outstanding |
| D15 | P1 | Payouts / Forwards | Pending, held, failed queues and failure detail | Implemented; local browser coverage recorded below; live/manual acceptance outstanding |
| D16 | P1 | Wallet | Primary wallet, balance, sync and owner controls | Implemented; local browser coverage recorded below; live/manual acceptance outstanding |
| D17 | P2 | Locations | Filters and display-only location detail | Implemented; local browser coverage recorded below; live/manual acceptance outstanding |
| D18 | P1 | Health / System / Audit | Service status, last sync, logs and audit detail | Implemented; local browser coverage recorded below; live/manual acceptance outstanding |
| D19 | P2 | Receipt review | Queue, evidence and review decision | Implemented; local browser coverage recorded below; live/manual acceptance outstanding |
| D20 | P1 | Settings | Group payment, withdrawal, security, legal and integration settings | Implemented; local browser coverage recorded below; live/manual acceptance outstanding |
| D21 | P2 | Owner guide | Bangla contents, setup and troubleshooting | Implemented; local browser coverage recorded below; live/manual acceptance outstanding |
| D22 | P2 | Legal / Contact | Owner will fill Legal / Contact through dashboard after project completion; retain publication gate | Deferred by owner; dashboard input after project completion |
| D23 | P2 | Wallet PWA | Balance, receive/send, activity and backup/security | Implemented; regtest build/browser flows verified; real-device/live release QA pending |
| V01 | P1 | Visual QA | Desktop and mobile, keyboard, English/Bangla and all loading/empty/error states | Local automated scope verified; exhaustive states, assistive technology, physical-device and live acceptance outstanding |
| O01 | P1 | Production evidence | Solvency comparison, withdrawal reconciliation and restore drill | Needs production/owner evidence |
| O02 | P1 | Owner decisions | Legal approval, direct-settlement release and production protection settings | Needs production/owner evidence |

## Evidence and changes

- Input: `cpay-main.zip`, extracted locally; no Git history in the archive.
- Prior Windows run: frontend, copy, legal structure, workflows and guide checks passed; frontend suite incomplete. Rechecking in this environment.
- Shared design already exists in `public/cpay.css`, `public/a11y.css` and `docs/DESIGN-SYSTEM.md`.
- Preserve payment calculations, auth boundaries, merchant themes and existing DOM hooks while improving presentation.

### Completed first batch

- Corrected authentication guidance in SYSTEM-OVERVIEW, RUNBOOKS and RELEASE-BLOCKERS. No live recovery or security setting was changed.
- Public source scan uses Node's `fileURLToPath`, including Windows drive letters and escaped paths.
- Markdown-link checker handles ZIP exports without Git metadata; Git checkouts still use tracked files (NUL-delimited, including names with spaces).
- Every member/admin section has audience-appropriate English/Bangla context. Language changes refresh the top heading.
- Shared CSS handles long headings, wrapping card headers, invalid selects and 44 px small action targets. Admin embedded CSS moved to the common stylesheet.

### Verification and remaining limits

- Baseline: 160/160 frontend tests passed on Linux before edits.
- Final frontend suite: 162/162 passed. Added two behavior tests covering every desk route, member/admin differences and language/navigation changes.
- Public-copy, frontend syntax/DOM/RPC, legal structure, workflows, generated guide and Markdown links pass.
- Browser QA blocked: Playwright package exists, but its browser executable is not installed.
- Deno is not installed: Edge Function tests were not run.
- Payment-service dependency install could not complete offline (`ENOTCACHED`); service tests were not run.
- SQL and production checks were not run; no production credentials or signed-in session were used.
- D02–D23 remain pending for individual layout implementation/review and browser acceptance. Existing layouts have not been represented as a completed redesign. Next at that checkpoint: D02 Home, then D03 Authentication (implemented in batch 2 below).

### Batch 2 — Home and Authentication

D02 implementation:

- Shorter hero with one primary account action and a how-it-works link.
- Three-step explanation and two receiving cards distinguish Auto withdraw on/off, fee-first handling, queued forwards and custody. Metadata follows the same current behavior.
- Mobile Explore menu uses native details/summary; receiving/security/custody anchors stay reachable.
- English/Bangla language control and font support on Home; the example chart no longer needs inline heights.

D03 implementation:

- Login/Register forms start visible. The lamp remains an optional accessible toggle, with compact phone positioning. Without JavaScript the form is still visible.
- Password visibility buttons work on Login, Register and Reset, with translated accessible labels. They do not read, store or transmit password values.
- Enter on marked fields uses existing submit actions; composing input, modified keys, hidden controls and disabled actions are ignored. Login's existing password-key handler is preserved.
- Language controls and Bangla translations cover the new copy; skip links target focusable cards. Existing confirmation, passkey, CAPTCHA, approval and reset logic is unchanged.

Verification:

- Final frontend suite: 165/165 passed. Frontend, copy, Markdown links, legal structure, workflows and generated guide checks passed.
- Every newly introduced visible text node on Home/Login/Register/Reset has a Bangla dictionary entry (compared against the supplied ZIP).
- Behavior tests cover password visibility, language updates, safe Enter handling and the default lamp state.
- Browser installation was attempted, but the downloaded archive was invalid/truncated. Browser QA remains pending; implementation is not represented as visually accepted.
- Backend and production limits from batch 1 remain.
- Next source work: D04 Dashboard, then D05 Payment links. D02/D03 still need browser acceptance under V01.

### Batch 3 — Dashboard and Payment links

D04 implementation:

- Available balance leads the summary; all-time settled amounts and platform fees remain secondary, with the original server-supplied values.
- Read-only refresh and local retry controls recover loading failures. Older overview responses cannot overwrite newer refreshes.
- Balance, shortcuts and recent payments render before the optional daily breakdown finishes; a breakdown failure stays in its own panel.
- Receiving settings that fail or lack a boolean mode show an unavailable state rather than claiming Auto withdraw is off.
- The New payment link shortcut opens and focuses the composer, including when the link section is still loading.

D05 implementation:

- Local name/slug search plus live/off filters, visible result counts, clear action and distinct empty/no-match states. Filtering does not refetch data.
- Explicit Preview and Copy actions; live/off changes still use the original owner-scoped update. Server-confirmed changes update rows without clearing the creation draft.
- Separate collapsible composer; opens initially for an account with no links. Filter updates preserve name, cost, design and payment choices. Existing create-link/experience/cost RPC code is unchanged.
- English/Bangla strings and responsive table labels; keyboard-operable native details panel.

Verification:

- Final frontend suite: 174/174 passed. Frontend, public-copy, Markdown links, legal structure, workflows and generated guide checks passed.
- Behavior tests cover combined filters, draft preservation, escaping, empty states, mode-read failures, daily-read failures, refresh races, confirmed status changes, read-only retry and table-label translation round trips.
- The create-link, experience and link-cost RPC code was compared with the supplied ZIP and is unchanged.
- Browser visual acceptance remains pending under V01; backend/production checks from earlier batches have not been rerun or represented as passing.
- Next source work: D06 Payments, then D07 Withdraw.

### Batch 4 — Payments and Withdraw

D06 implementation:

- Payment history now uses the existing server pagination (50 rows per page), with Previous/Next controls; applying or clearing filters starts at page one.
- Explicit View details controls support keyboard and pointer use without duplicate opens from nested row/button events. References and names remain escaped.
- The detail dialog shows a timeline made only from recorded creation, settlement and forwarding timestamps. Detail reads can be retried; older responses and responses arriving after close are ignored.
- Payment-list failures have read-only retry controls, and newer list reads supersede older responses.

D07 implementation:

- Corrected a batch-3 regression: renderCash used `receiveError` without declaring it. It now reads that error from the receiving-settings RPC and shows an unavailable-mode note when needed. Added a regression test that actually renders the funded Withdraw page.
- Added a destination/quote/passkey journey above the existing form, a labelled quote panel and an address-hint association.
- Zero-balance state keeps history and address-management navigation available.
- History has its own refresh, explicit latest-40 scope, status filtering, distinct no-match feedback and read-only retries. These reads do not rebuild the withdrawal form or its quote state.
- The existing bindWithdraw implementation, fee calculations, quote/confirm requests and passkey step-up wrapper are unchanged; no send or automatic retry was added.

Verification:

- Final frontend suite: 183/183 passed. Frontend, public-copy, Markdown links, legal structure, workflows and generated guide checks passed.
- New behavior coverage: pagination/filter offsets, stale list responses, detail-read races/closure/retry, single keyboard/pointer opens, funded/empty Withdraw render and independent history refresh.
- bindWithdraw and its quote/confirm/step-up implementation were byte-compared against the supplied ZIP and are unchanged.
- Browser acceptance and backend/production limits remain pending as previously recorded.
- Next source work: D08 Profile, then D09 Security.

### Batch 5 — Profile and Security

D08 implementation:

- Separated public storefront fields, receiving status, saved USDT addresses and balance-payout preferences, with section links and privacy labels.
- Receiving-mode failures show Unavailable rather than Off. Removed wording that implied automatic forwarding when Auto withdraw is off.
- Public-profile drafts remain in page memory across address reloads; save/remove controls reject duplicate clicks, recover after transport errors and retain existing RPCs and address step-up. Removal asks for explicit confirmation.
- Profile reads have local retries and stale-response guards. Optional location/Lightning panels fail independently. Removed the address-list inline layout style.

D09 implementation:

- Shared member/admin Security UI now has a loading state, read-only refresh, passkey count and backup-passkey guidance. Failed key-list reads expose no credential actions.
- Credential mutations are serialized. Cancellation or failure restores controls; only the read is refreshed, not the mutation. Older reads cannot replace a newer panel.
- Preserved first-key registration, strong confirmation for additional/removal actions, explicit removal confirmation and the final-admin-key guard. Retired authenticator names remain informational only. No new session-management or auth backend API was introduced.

Verification:

- Final frontend suite: 194/194 passed. Frontend, public-copy, Markdown links, legal structure, workflows and generated guide checks passed.
- Profile tests cover unavailable mode, draft retention, original address step-up, duplicate-save protection, failed transport and cancelled removal.
- Security tests cover final admin key, cancelled step-up, first key, duplicate actions, removal confirmation, failed list reads, stale reads and mutation failure recovery.
- Official Supabase changelog and passkey documentation were consulted. No client version, WebAuthn ceremony, database, Edge Function or production configuration was changed; live auth/query verification was not performed.
- Visual QA and production acceptance remain pending. Next source work: D10 Chat / Inbox, then D11 Checkout / Invoice.

### Batch 6 — Chat / Inbox and Checkout / Invoice

D10 implementation:

- Member support now shows the latest 80 messages in chronological order, with timestamps, multiline composition, read-only refresh and a preserved in-page draft. The old ascending/limit read selected the earliest 80; the new read selects newest first and reverses only for display.
- Admin Inbox adds local account search, unread-first ordering, explicit account selection and a per-account in-page draft. Search never silently changes the selected recipient.
- Sends stay bound to the account selected when the action began. Duplicate in-flight sends/clears are blocked; failed or uncertain sends preserve drafts and are not automatically retried. Text typed during a send is not erased.
- Thread reads have response guards so account switches do not display or mark old responses as read in a different conversation. Existing read receipts and clear-thread confirmation/RPC remain.
- Ctrl/Command+Enter sends; Enter adds a line. All displayed message content remains escaped. No messages were sent through a live account during implementation.

D11 implementation:

- Shared embedded/standalone invoice markup now separates read-status feedback from payment status, with recipient/amount guidance and a clearer USD entry caption.
- A failed status read shows an unavailable message while the existing read-only polling continues; it never marks a payment as paid or creates another invoice. Repeated identical feedback does not rewrite the live-region text.
- Receipt time is explicitly labelled Confirmation seen, matching the existing code's observation time rather than implying a server settlement timestamp. Added reference-retention guidance.
- Merchant themes, QR/invoice contents, status transitions, expiry handling, wallet handoffs and invoice creation/idempotency are preserved. Removed two inline layout styles in favor of the shared stylesheet.
- New checkout copy has Bangla dictionary entries; checkout retains its existing language behavior and does not load the desk translator into merchant data.

Verification:

- Final frontend suite: 206/206 passed. Frontend, public-copy, Markdown links, legal structure, workflows and generated guide checks passed.
- Behavior tests cover member ordering/drafts/duplicate sends; admin account switches/search/recipient binding/failure/clear cancellation; and invoice status read failure/recovery/settlement/live-region stability.
- The amount-page inline creation scripts and invoice boot/status/expiry/settlement code were compared against the supplied ZIP and are unchanged.
- Visual QA, live messaging and real payment verification remain pending. Next source work: D12 Store, then D13 Admin overview.

### Batch 7 — Store and Admin overview

- Store adds local search by payment option name or slug, visible result counts, distinct no-match/no-active states, bounded read failure and explicit retry. It remains a storefront of payment links; no cart, product inventory or order-total model was invented.
- Share cancellation is respected; failed native share falls back to clipboard, and unavailable clipboard gives manual-copy guidance. Merchant names, descriptions and themes remain server supplied and safely rendered.
- Admin overview adds review shortcuts and a read-only refresh. Pending applications sort first. Failed boards show errors rather than empty queues; unavailable statistics or freelancer balances show a dash rather than a false zero.
- Wallet reads run after activity boards render, with a separate bounded error state. Older overview responses cannot replace a newer refresh. Wallet USD value is labelled as a value estimate, preserving existing source amounts and formulas.
- Existing application review and manual payout endpoints/actions and payout step-up remain. Transport failures restore application controls; disabled actions ignore duplicate clicks. No mutations are automatically retried.
- Added Bangla dictionary entries; store retains existing merchant-language behavior.

Verification:

- Frontend suite: 213/213 passed. Frontend, public copy, Markdown links, legal, workflow and generated guide checks passed.
- New behavior tests cover failed and hanging overview reads, absent summaries without false balances, boards rendering while wallet is unresolved, store retry/search/escaping and share failure guidance.
- Browser visual QA, live backend behavior and real payment verification remain pending. No deployment performed.
- Next: D14 Users / Applications, then D15 Payouts / Forwards.

### Batch 8 — Users / Applications and Payouts / Forwards

D14 implementation:

- Users keeps status/search state and adds explicit refresh, account references and partial-read feedback. Failed optional reads no longer present missing wallet data as an absent wallet; unavailable auto-withdraw and withdrawal-fee controls are disabled until refresh.
- Primary account read errors provide retry; read timeouts and response guards prevent endless loading and older reads replacing a newer list. Account roles, fee formulas, prompts and existing control RPCs are preserved.
- Applications explicitly reads all statuses with the existing nullable p_status argument (the server default previously returned only pending). The default view remains Pending; status/search/clear/refresh expose decision history.
- Native review details show submitted/reviewed times, reference and existing review note. Only pending/submitted rows offer decisions. Duplicate decisions for the same application are blocked while in flight; errors restore controls without automatically repeating the mutation.

D15 implementation:

- Payouts labels its latest-120-request read scope, preserves filters during refresh and adds request/account/payout references, processed time and admin note. Failed rows include verification guidance. These are the actual user_id, payout_ref, processed_at and admin_note fields from the existing schema.
- Per-request busy state protects both payout controls across refreshed rows. Existing process-withdrawal actions and passkey step-up remain unchanged; cancelled step-up restores controls and does not invoke the payout endpoint.
- Forwards adds bounded read/error/retry, refresh, local search across loaded account/address/reference/error fields and a visible count. The list's 200-row cap and globally computed totals are explicitly distinguished.
- Forward details include payment reference, network, next attempt and actual sent time. Planned sats are labelled Sent / planned, preserving the existing server values. Held reasons and last errors remain visible and escaped.
- Forward and stuck-batch actions retain existing confirmations and exact RPC payloads. Mutations serialize within this panel, never retry automatically, and show uncertain-result feedback on transport or server error. Refresh remains read-only; stale reads cannot replace newer results.
- Added Bangla dictionary entries and shared details/queue styles. No schema, Edge Function, fee calculation, settlement or authorization rules changed.

Verification:

- Frontend suite: 225/225 passed. Frontend, public-copy, Markdown links, legal, workflow and generated guide checks passed.
- Added 12 behavior tests for application history/status/actions, stale reads, duplicate decisions, optional account read failure, preserved search, payout details and step-up cancellation, forward transport failure/search/cancellation/serialization and stale queue reads.
- Queries and actions were exercised against test doubles; browser visual QA, live backend/authorization and real payment verification remain pending. No live administrative decisions or payout actions were performed.
- Next: D16 Wallet, then D17 Locations. D18 Health / System / Audit follows.

### Batch 9 — Wallet and Locations

D16 implementation:

- Platform wallet adds a read-only refresh and balance-read status. Completion time means browser read completion, not server sync or a solvency assertion. Failed refresh clears previously displayed balance/rate/owed/spendable values and shows unavailable; missing owed data is not rendered as zero.
- Balance and history response guards prevent old requests replacing newer refresh/page results. History failures disable forward paging and explain how to refresh. Amount/rate calculations, quote preparation/confirmation and all send paths are preserved.
- Owner wallet registry retains the primary-wallet distinction and adds full sync time/error details, refresh and read failure retry. List reads have bounded waits and response guards; failed reads remove stale list data.
- Registry mutations are serialized, controls recover after errors and passkey cancellation, and uncertain transport results do not automatically retry. Existing exact-name removal confirmation, passkey prompts, owner checks, seed validation/masking/immediate clearing and server constraints remain.
- Registry list refresh reuses the existing add form DOM instead of recreating entered fields. No seed is copied into new state, storage or logs.

D17 implementation:

- Locations adds Apply/Clear/Refresh, Enter submission, two-letter country format validation and normalized filter payloads. Draft filters survive failed/in-flight reads; clear restores the original 30-day default.
- Bounded reads, explicit errors and response guards prevent endless loading or older filter results replacing newer ones. The restored Locations hash also loads its content.
- Scope copy explains that payment data uses the selected date range, profile locations are current data, and detail lists contain at most 200 matching records. Counts describe loaded detail records, not all users or payments.
- Payment references and display-only profile location details are available through native details. Missing last-seen timestamps display a dash. Existing approximate-location/privacy guidance, aggregates and read-only admin RPC remain.
- New static copy has Bangla dictionary entries. No database, authorization, wallet service, fee, settlement or send implementation changed.

Verification:

- Frontend suite: 233/233 passed. Frontend, public-copy, Markdown links, legal, workflow and generated guide checks passed.
- Eight new behavior tests cover clearing unavailable balances, absent owed values, stale balance/history/registry reads, registry mutation serialization and passkey cancellation, Locations validation/normalization/draft recovery and stale reads.
- Existing seed checksum/masking/clearing and wallet routing tests also passed. Tests use local doubles; browser visual QA, live owner authorization, live sync and actual transfer verification remain pending. No live wallet control or payment action performed.
- Next: D18 Health / System / Audit, then D19 Receipt review.

### Batch 10 — Health / System / Audit and Receipt review

D18 implementation:

- Health reads the subsystem and operations snapshots concurrently through bounded read helpers; failures remain visible beside successful evidence. Missing subsystem cards are unavailable, not a healthy empty result. Existing server state, checked time, ages and runbooks remain authoritative.
- System snapshot and alert reads run concurrently and fail independently. An unavailable alerts query is explicitly distinguished from a successful query returning no alerts. Refresh buttons read existing endpoints only.
- Health, System and Audit ignore older responses after newer refreshes. Audit retains the search draft, labels the latest-120-row scope and shows the entire subject reference plus an expandable audit reference.
- Removed the health grid inline layout in favor of shared CSS. Settings bindings in the same script remain unchanged.

D19 implementation:

- Receipt queue adds status/search/clear/refresh, a visible latest-200 scope/count, and full receipt evidence: provider reference, payment hash/reference, detected source, settlement outcome and seen/resolution timing. Long evidence is escaped and placed in native details inside a scrollable table.
- Queries have bounded waits, explicit read-only retry and response guards. Search checks the records returned for the selected status and preserves the typed value across refresh.
- Only open rows have decision controls. Note-prompt cancellation performs no write; paired controls for one receipt stay disabled during a decision, including a concurrent rerender. Errors restore controls without an automatic mutation retry.
- Original admin_list_receipt_reviews/admin_resolve_receipt_review payloads remain, including the audit-note prompt. Resolving or dismissing remains a flag-only decision, with no ledger or payment correction added.
- Added Bangla dictionary entries. No schema, authorization rule, payment calculation, settlement or live operational setting changed.

Verification:

- Frontend suite: 241/241 passed. Frontend, public-copy, Markdown links, legal, workflow and generated guide checks passed.
- Eight new behavior tests cover partial Health/System failures, escaped alerts, full audit references and draft retention, stale audit reads, receipt evidence and open-only controls, cancellation/duplicate decisions, and read failure retry.
- All API calls in these tests use local doubles. Browser visual QA, live service/authorization verification and real payment checks remain pending. No live receipt decisions or operational writes were performed.
- Next: D20 Settings, then D21 Owner guide.

### Batch 11 — Settings and Owner guide

D20 implementation:

- Existing grouped settings and owner navigation remain. Platform settings adds explicit refresh and guidance that each Save writes one setting. Ordinary input/list drafts remain in page memory across reads and unrelated saves; seed/secret values are not added to this draft map.
- Platform setting, global auto-withdraw and default-fee writes share a busy guard. Controls recover after rejected promises or server errors. Dangerous-setting confirmations and exact RPC payloads remain; failed mutations are not automatically retried.
- Platform fee read errors show unavailable rather than presenting an editable 0%. Settings and fee reads use bounded read helpers; retry is read-only. Owner feature/domain reads also use bounded helpers, and rejected owner reads no longer abort all other section renders.
- Owner feature controls recover on transport errors; domain controls serialize within their panel. Owner-config writes preserve existing step-up and return uncertain-result feedback after transport/cancellation rather than leaving the caller rejected without feedback. Secret value fields retain their existing post-attempt clearing behavior.
- No setting default, fee formula, legal publication decision, secret value, auth rule or live configuration changed. Advanced settings remain in their existing hidden container; no retired switch was newly exposed.

D21 implementation:

- Guide adds section selection with focused heading navigation, guide refresh and a separate names-only secret-status refresh.
- Guide reads have bounded waits, response guards and retry. Explicit owner denial, weak passkey session and transient read failure have different messages; transient errors are not described as proof that the account is not the owner.
- Guide is still served only by the owner-guide function after its server checks. No public static guide copy, owner access bypass or secret-value display was introduced.
- Added a Bangla quick-reference section covering Settings saves, uncertain results, missing fees, passkey access, names-only secret status, receipt decision semantics and unavailable wallet balances. Regenerated supabase/functions/owner-guide/guide.ts with the existing builder.

Verification:

- Frontend suite: 249/249 passed. Frontend, public-copy, Markdown links, legal, workflow and generated guide checks passed.
- Eight new behavior tests cover duplicate setting commits/failure recovery, draft escaping, missing fee data, dangerous-save cancellation, cancelled owner step-up, guide transport retry and explicit owner/weak-session responses.
- Tests use local doubles. Browser visual QA, live owner authorization, live configuration queries and real payment checks remain pending. No live settings or secret mutations were performed.
- The updated generated guide requires the normal owner-guide deployment to appear in production; no deployment was performed.
- Next: D22 Legal / Contact, then D23 Wallet PWA; V01 visual QA follows where the browser environment allows it.

### Batch 12 — Wallet PWA; Legal / Contact deferred by owner

Owner direction:

- Owner will fill Legal / Contact through the dashboard after the project is complete. D22 is deferred, not marked implemented or legally approved. Existing legal publication validation, noindex and conditional links remain. No legal identity, address, contact or policy content was invented.

D23 implementation:

- Wallet PWA adds an explicit read-only refresh, separate balance/activity read status and bounded read waits. Failed balance reads clear stale amounts; missing balance is a dash, never a presumed zero. Failed activity reads are distinct from an empty successful list.
- Balance and activity load independently. Response/session guards ignore old refreshes and results arriving after lock. Lock invalidates pending reads and clears visible balance/activity before disconnect.
- Activity adds local status/reference/type filters, loaded-record counts and full payment references in native details. Unconfirmed outgoing payments retain the instruction not to pay again. Search/filter operations do not submit a payment.
- Pending-send reconciliation remains read-only and retains its original completed/failed/expiry rules. Checks use bounded reads and session guards; failure gives explicit uncertainty instead of silently losing the warning.
- Receive invoice copy now reports success or manual-copy fallback. Feedback clears when a new invoice is requested and on lock. Invoice creation, QR contents and wallet handoff remain unchanged.
- Existing recovery phrase checks, encrypted vault, passkey derivation, backup/export controls, engine, service worker and separate CPAY account balance remain. No phrase, key or new secret state was added.

Verification:

- Frontend suite: 255/255 passed. Frontend, public-copy, Markdown links, legal, workflow and generated guide checks passed; wallet app syntax checked.
- Six new behavior tests cover partial read failure, no-match filters without engine calls, stale responses, lock invalidation and reconciliation failure without a send.
- Compared the send preparation/confirmation/outcome/retry block against the supplied ZIP: byte-for-byte unchanged.
- Test/regtest build was attempted with output outside the source tree. It stopped because wallet npm dependencies are absent (builder requests npm ci --ignore-scripts). No production build, deployment, real wallet operation or payment test was performed.
- Browser/installed-PWA visual QA, offline behavior and real-device/passkey/backup acceptance remain pending. D23 implementation is not release acceptance.
- Next: V01 desktop/mobile/keyboard and language/state visual QA where browser tooling permits; resolve remaining build and production-evidence checks. D22 waits for owner input as directed.

### Batch 13 — Local browser evidence and portable smoke tests

- Installed dependencies from the existing lockfiles without changing package versions. Wallet production-rule regtest build with the real 0.26.0 SDK succeeded (link/sync/passkeys off, no mainnet API key). This resolves the prior local missing-dependency build blocker; it is not a mainnet release or a live wallet test.
- Local Chromium fake-engine wallet suite: 25/25 passed, covering creation, restore, vault/phrase handling, lock/unlock, receive/send confirmation, uncertain-send/retry behavior, consented CPAY linking, offline unlock, backup, address controls and passkey UI doubles.
- Real SDK/WebAssembly and Chromium virtual-authenticator suite: 5 passed, 1 live-regtest test deliberately skipped because WALLET_LIVE was not enabled. No real funds were sent. Virtual-authenticator results do not replace physical phone/platform acceptance.
- Public smoke/layout suite: 31/31 passed after updating obsolete tests to match the previously implemented default-open authentication forms. Tests still exercise click, keyboard, drag, no-JavaScript and reduced-motion lamp behavior.
- Added eight isolated layout checks at 390px and 1440px for home, login, register and store; they verify no horizontal page overflow, keyboard skip focus/outline and stable form opacity before taking screenshots. External requests are blocked in these layout checks, so they do not verify production fonts, API or third-party availability.
- Fixed login/register DOM tab order so the skip link comes before the language control. Added a managed local static server to public-smoke configuration; CPAY_BASE_URL still selects an explicitly supplied server.
- Public layout screenshots were generated locally; desktop home and desktop/mobile login were visually inspected. Initial screenshots captured form transition frames, so the test now waits for full form opacity. Screenshots are internal QA evidence and are not included in the ZIP.
- Browser environment lacks the Bengali fallback font when external fonts are blocked; Bengali glyph typography and translated layouts remain pending. Signed-in member/admin panels, merchant-success themes/checkout, all state matrices and physical installed-PWA acceptance are not marked visually complete.
- Frontend suite remains 255/255 passing; frontend, public copy, Markdown links, legal, workflows and generated guide checks pass.
- No deployment, live administrative write, legal publication, mainnet wallet action or real payment verification performed. Legal / Contact stays deferred to owner dashboard entry after project completion.
- Next: signed-in member/admin browser fixtures, English/Bangla typography/state QA, then remaining production evidence/release gates. V01 remains in progress.

### Batch 14 — Mocked signed-in desk layout and Bengali typography

- Added isolated member/admin browser fixtures. Configuration, session/profile reads, passkey-session checks and responses are replaced in the test route only; external requests are blocked. This is layout/navigation evidence, not authorization or live-backend acceptance. No production auth code or permission boundary changed.
- Added ten desk scenarios: member/admin at 390px and 1440px in English and Bangla, plus member balance failure and admin alerts failure/retry states. Covered navigation through home, links/payments/withdraw/chat/profile/security and admin users/applications/payouts/health/system/audit/receipts/settings. Many lists intentionally use empty fixtures, not populated-data acceptance.
- The tests verify section selection, page overflow, no uncaught page errors, loaded Bengali font and the Settings Save button remaining inside its card. Mobile tests use the drawer class state rather than its transitional visibility, avoiding a test race during the closing animation.
- Vendored Bengali 400/600 WOFF2 subsets of Noto Sans Bengali from @fontsource/noto-sans-bengali 5.3.0, with its SIL OFL license. The existing font stack already named this font but previously depended on device availability. Shared CSS now loads it locally, including Bengali punctuation ranges; no Google font connection is required for this fallback.
- Screenshot review found unstyled owner-domain/secret inputs and a clipped platform-setting Save button. Added the existing shared input class and a wrapping setting-editor layout; save RPCs, values, confirmations and validation remain unchanged.
- Added missing Bangla copy for Individual, the empty recent-payment hint and standard 14/30-day summary captions. Visually reviewed a Bengali mobile member home and Bengali desktop admin Settings before/after fixes. Other scenarios have automated screenshots/checks but are not all manually signed off.

Verification:

- Combined public smoke/layout/desk browser suite: 41/41 passed. Final desk-only rerun with Save-boundary/font assertions: 10/10 passed (a subset, not an additional independent total).
- Frontend suite: 255/255 passed. Frontend, public-copy, Markdown links, legal structure, workflows and generated guide checks passed.
- Font loaded in Chromium with external requests blocked; Bengali letters and punctuation rendered in reviewed screenshots. The font assets and license are included in the source ZIP; package tarball, installed dependencies, builds and internal screenshots are excluded.
- V01 remains in progress: populated long-data states, successful merchant themes/checkout, physical devices/installed PWA, owner-only guide/secrets and live authorization/payment acceptance are not completed by these fixtures. Previously recorded wallet browser evidence remains local/test-only.
- Legal / Contact remains deferred to dashboard entry by the owner after project completion. No legal publication, secret write, live account mutation, deployment or money transfer performed.
- Next: remaining merchant/checkout and populated-list state fixtures, followed by release/production evidence review.

### Batch 15 — Merchant/invoice and populated-list browser evidence

- Added merchant fixtures for all ten existing payment/invoice designs at 390px and 1440px. Tests open a prefilled amount page and read an existing synthetic invoice; no create-invoice or payment handoff is clicked. External requests are blocked and the invoice text is deliberately non-payable fixture data.
- Added pending/settled/expired/invalid server-state display checks. Pending disables the duplicate-pay handoff; settled alone shows the success amount. Store tests cover populated payment links, escaped markup, search/no-match and read-failure retry.
- Added populated member-link and admin-payout scenarios at both widths, with long names, full references and an escaped markup-like note. Existing empty desk fixtures remain the default; populated data is opt-in in tests.
- Screenshot review found that the checkout toast inherited a desk top anchor plus its own bottom anchor, stretching the QR-load error notice over the checkout. Scoped the checkout toast geometry, added size assertions for every theme/width, and hide the QR logo when only text fallback is available. Public QR generation itself is not verified by these tests because its CDN is intentionally blocked.
- Mobile payout details were trapped in a horizontal table. Payouts now use the existing responsive row layout with column labels; references, address and notes wrap instead of truncating on narrow containers. Added an assertion that the populated payout scroll area has no horizontal overflow. Protected action handlers and all displayed source amounts remain unchanged.
- Inspected desktop invoice fallback and mobile populated payout screenshots before/after fixes. Screenshots stay internal and are excluded from the source ZIP.

Verification:

- Final combined public/desk/merchant/populated browser run, one worker: 71/71 passed. Merchant-only rerun after adding the QR-logo fallback assertion: all 26 tests passed, runner exit 0 (subset, not an additional independent total).
- Frontend suite: 255/255 passed; frontend, public-copy, Markdown links, legal structure, workflows and generated guide checks passed.
- Compared public/invoice-view.js and the protected payout action-handler block with the supplied ZIP: unchanged. No invoice creation, settlement, amount calculation, mutation payload or step-up logic was altered.
- This verifies presentation with synthetic responses, not real authorization, QR encoding/network availability, successful wallet payment or reconciliation. Physical-device/installed-PWA, owner-only UI, complete accessibility/state matrix and production evidence remain pending. V01 is still in progress.
- Legal / Contact remains owner-deferred. No deployment, live account mutation, legal publication or money transfer performed.
- Next: release-readiness review and the remaining accessibility/owner-only/production evidence gaps, keeping live gates separate from local test results.

### Batch 16 — Accessibility and release-readiness review

- Added @axe-core/playwright 4.10.2 as a pinned development dependency with lockfile changes. It is test tooling only, not a new production browser script.
- Six scans check member/admin overviews at 390px/1440px and login/register forms using WCAG 2 A/AA and 2.1 AA tags. Stable-form scans report no violations; the form opacity transition is explicitly awaited to avoid measuring a partly transparent animation frame. No rules or elements are excluded.
- Added npm scripts for frontend, public browser and accessibility checks; public browser runs use one worker for predictable resource use.
- Static upload preparation successfully generated the local dist bundle including Bengali font/license assets. No deployment performed; generated bundles stay outside the source ZIP.
- Reviewed the release-gate's existing pure parsers and source evidence. There are no open Critical/High rows in the source blocker table, but owner Medium items remain. The recorded 2026-10-13 restore Pass is accepted by the date/result parser; this is historical documentation, not a new drill.
- Added RELEASE-READINESS.md with a concrete local-versus-production evidence matrix. Exact Git/deployment SHA/CI evidence cannot be established from a ZIP; legal publication remains owner-deferred and no gate was relaxed.

Verification:

- Final combined public browser suite: 77/77 passed, including six automated accessibility scenarios. Frontend suite: 255/255 passed. Frontend, copy, Markdown links, legal structure, workflows and generated guide checks passed.
- No app behavior, authorization, fee calculation, settlement, operational setting or money movement changed in this batch.
- V01 remains in progress for remaining states/owner-only screens and manual assistive-technology/physical-device checks. Production evidence O01/O02 is not closed by local tests.
- Next: owner-only UI/state coverage and final handoff against RELEASE-READINESS.md; live checks and owner Legal / Contact entry remain separate.

### Batch 17 — Owner UI coverage and source handoff

- Added 19 browser scenarios for owner settings (ready, missing setup, owner denied and passkey-required), English/Bangla and 390px/1440px. Ready-state checks include protected labels, blank password fields, HTTPS switch display and long secret-name layout.
- Generated owner guide is loaded from the actual committed GUIDE_HTML artifact in the fixture. Mobile/desktop tests check section selection transfers keyboard focus, refresh works and names-only status badges render. Non-owner guide navigation remains hidden and its deep link returns home.
- Extended only the test fixture with optional owner-function responses. Unexpected owner write methods reject; no production endpoint, setting or secret was changed.
- Combined browser suite: 96/96 passed. Frontend: 255/255 passed. The 19 owner scenarios and six accessibility scans are subsets of the 96, not extra independent totals.
- Added FINAL-HANDOFF.md and reconciled stale summary-table browser-pending labels against the accumulated local evidence. Historical batch entries remain unchanged.
- Source implementation and the recorded local automated verification are ready for owner handoff. This does not close exhaustive manual/state, physical-device or live production acceptance. Legal / Contact remains deferred by owner; O01/O02 remain evidence gates. Further production work must follow the existing release process.

### Batch 18 — Wallet acceptance automation and repository evidence

- Re-ran the wallet suite and added a phone accessibility scenario for welcome, unlocked and locked views. Final wallet run: 31 passed, one live-regtest test skipped; fake-engine flows and virtual passkeys remain synthetic.
- Existing offline service-worker reopen/unlock, backup/restore and real SDK/CSP checks passed in this run. No physical device, real account or payment was used.
- Read-only GitHub lookup resolved main to 4bff0a75d6f44f2759594c89ba0168217d32bd0a. Empty status and PR-only workflow results cannot prove CI health or deployment identity. No repository write was performed.
- Checked integration prerequisites: psql, postgrest, deno and docker unavailable. Real-RLS E2E was not run; source fixture results are not substituted for it.
- Added RELEASE-EVIDENCE-SNAPSHOT.md so the next operator has exact findings and limits. O01/O02, Legal / Contact and physical/live acceptance remain open.

### Batch 19 — Backend unit checks and integration preflight

- Installed locked payment-service dependencies locally; 31 selected auth/money/config/hardening/package unit tests passed. Added npm run test:payment:unit for reproducible execution from the root.
- Added a read-only npm run check:integration prerequisite checker. It reports missing psql/PostgREST/Deno PATH binaries and exits nonzero; it does not connect to a database.
- PostgreSQL install was blocked by runtime permissions. Full payment-service tests exited 1 on localhost database connection refusal. Deno 2.2.7 runs through npm, but function test dependency retrieval failed at the JSR assertion manifest. None of these attempts is recorded as a pass.
- Added BACKEND-LOCAL-QA.md with exact commands and scope. No app code, authorization rule, monetary calculation, secret, production setting or deployment changed.
- Remaining: provisioned real-RLS/database integration, physical/manual acceptance and live release evidence. Owner Legal / Contact stays deferred.

### Batch 20 — Successful QR rendering and roundtrip coverage

- Closed the local successful-QR-library coverage gap with 20 scenarios across all ten merchant themes at phone/desktop widths. The real qrcodejs bytes match the existing CDN SHA-384 integrity value.
- Decoded screenshots of the displayed QR, including CSS scaling and brand overlay, back to the exact synthetic request. Existing missing-library fallback and server-state checks still run.
- Extracted the shared merchant fixture; added three pinned development-only QR/image test packages and lock entries. No CDN setting, production code, invoice logic, settlement or money movement changed.
- Final combined public browser run: 116/116 passed. Frontend: 255/255 passed; source frontend checks passed. Public count includes these 20 new cases, the earlier six accessibility scans and owner UI cases.
- Physical camera scanning, payable-invoice/network checks, real-RLS integration and production evidence remain separate acceptance requirements. Owner Legal / Contact remains deferred.

### Batch 21 — Internal section accessibility and table keyboard fix

- Added four mobile/desktop section-scan loops (28 scans) plus a keyboard scrolling/resize scenario. Mobile admin scans exposed non-focusable horizontal table regions in Health, System, Audit, Receipts and Settings.
- Fixed the shared responsive-table helper to make overflowing table wrappers keyboard reachable and named without overriding authored accessibility attributes. Extra owned tab stops are removed when the table fits; DOM/visibility, resize and language changes refresh the checks. Dashboard/admin script versions bumped.
- Final combined public suite: 121/121 passed; frontend: 255/255 passed; frontend source checks passed. Public accessibility now includes 34 scans across ten scenarios plus a separate keyboard-scroll case. No rules or elements were excluded.
- Scope is populated English-language fixtures at two widths; manual screen-reader, translated state matrices, physical-device, real-RLS and production acceptance remain open. Legal / Contact remains owner-deferred. No live actions or financial behavior changed.

### Batch 22 — Bengali section accessibility verification

- Extended the internal section scan loops to English/Bengali and assert the active document language. Four new Bengali cases add 28 scans over 14 sections at two widths.
- Final public suite: 125/125 passed. Public axe coverage totals 62 scans across 14 scenarios, plus one keyboard-scroll scenario. No new production defect was found and no production code changed.
- Frontend 255-test pass remains the previous Batch 21 run; no unrelated tests were repeated for this test-only change.
- Remaining acceptance requires provisioned database/RLS, physical/manual and live evidence; continued local fixture passes do not close these gates. Legal / Contact remains deferred as instructed.
