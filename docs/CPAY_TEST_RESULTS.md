# CPAY: test results (2026-10-14)

No automated test sends real money. Mainnet payments and payouts were
**not** run; see [CPAY_LIVE_TEST_RUNBOOK.md](CPAY_LIVE_TEST_RUNBOOK.md).

## CI on `main` (Verify, commit 0b715d9 and later merges)

| Job | Result |
|---|---|
| Migrations from empty + 37 SQL suites (ledger, settlement idempotency, withdrawals, cooldown on every path, emergency stops, admin audit, RLS, Telegram, lease health) | Passed |
| Payment-service suites, current and previous version | Passed |
| Wallet engine function Deno suite | Passed (27/27 locally) |
| Frontend unit tests | Passed |
| Public smoke (built site in a browser) | 15/15 |
| End-to-end: auth, authorization, admin MFA, creator dashboard, invoice lifecycle, public payment, responsive/accessibility, withdrawal (fake wallet engine, local stack) | Passed |
| Phone wallet: build rules, browser tests | Passed |
| Secrets scan, dependency audit, workflow pinning, public copy, legal-draft guard, release gate | Passed |

## Local run for this change (branch `claude/telegram-no-email`)

| Check | Result |
|---|---|
| `ci/telegram_no_email_test.sql` (new: Telegram never uses an email as the account name) | Passed |
| `ci/telegram_test.sql` (existing) | Passed |
| Frontend unit tests (`tests/frontend`) | 85/85 |
| Phone wallet build rules | 6/6 |
| Phone wallet browser tests | 15 passed, 1 skipped (live regtest: needs the external regtest network) |
| Public copy, frontend, legal, workflows, Markdown links | Passed |

## Production checks (read-only)

| Check | Result |
|---|---|
| Migrations applied up to 20261014060000 before this change | Yes |
| Health function | 200 healthy at 20:30 UTC; no 503 in the following 30 min |
| Cron jobs (6) | All last runs succeeded |
| Wallet engine lease | Every minute, owner `supabase-edge` |
| Ledger totals before and after the work | Unchanged |
| Flags | Emergency stops off, admin MFA requirement off, receipt recording off |

## Not run, and why

| Test | Why |
|---|---|
| Live website in a browser | This environment's network proxy blocks the production hostname |
| `deno check` for the functions | The module CDN is blocked here; CI runs it |
| Live regtest wallet session | External network; informational in CI |
| Real mainnet invoice, payment, settlement, payout | Real money; owner-only, see the runbook |
| Phone wallet on real phones | Not deployed (`cpay-wallet` project missing) |
