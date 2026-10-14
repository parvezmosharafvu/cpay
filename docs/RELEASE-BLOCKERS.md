# Release blockers

Read by `scripts/release-gate.mjs`: any row with severity Critical or High and status `open` refuses a release (and fails CI). Owner-only items are Medium, so the gate does not stop on them: **every open row below must be closed or explicitly accepted by the owner before a release.** Keep one row per finding; close it with the PR that fixed it.

| Finding | Severity | Status | Owner / PR |
|---|---|---|---|
| Draft legal pages (terms, privacy, refund, contact) | Medium | open | Owner legal sign-off; gate also checks text |
| Admin MFA: implemented (#101 enrolment + challenge, #102 aal2 enforcement behind `admin_mfa_required`, off); still needs the owner to enrol two authenticators, test sign-in and a payout at aal2, then turn the flag on and set `ADMIN_MFA_EXPECTED=true`. While the flag is off the server accepts an admin session that skipped its code (the desk pages now ask for it) | Medium | open | Owner (RUNBOOKS "Two-step sign-in") |
| Real low-value receive → withdraw reconciliation (no real-money end-to-end evidence yet) | Medium | open | Owner |
| No database backup beyond the nightly git snapshot: the Supabase organisation is on the Free plan (no PITR, no downloadable backups; `auth.users`, audit log and wallet schema not backed up) | Medium | open | Owner: upgrade to Pro (+ PITR for a money ledger) or record a tested manual-dump routine; see docs/BACKUP-RECOVERY.md |
| Public invoice endpoint can be flooded per link/owner (Turnstile off unless `TURNSTILE_MODE=enforce`; `x-cpay-client-ip` from a Cloudflare Worker is not signed) | Medium | open | Owner: set `TURNSTILE_MODE=enforce` after a test payment; see docs/AUDIT-2026-10-14.md |
| One `CRON_SECRET` shared by six functions and suggested for an external monitor | Medium | open | Owner: do not give it to a monitor; separate secrets per docs/AUDIT-2026-10-14.md |
| Supabase Auth leaked-password protection off (advisor) | Medium | open | Owner: Auth → Passwords → enable |
| Workflows unpinned / no permissions | High | closed | #86 |
| main not branch-protected | High | closed | repo setting 2026-10-13 |
