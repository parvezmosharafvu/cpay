# Release blockers

Read by `scripts/release-gate.mjs`: any row with severity Critical or High and status `open` refuses a release. Keep one row per finding; close it with the PR that fixed it.

| Finding | Severity | Status | Owner / PR |
|---|---|---|---|
| Draft legal pages (terms, privacy, refund, contact) | Medium | open | Owner legal sign-off; gate also checks text |
| Admin MFA: implemented (#101 enrolment + challenge, #102 aal2 enforcement behind `admin_mfa_required`, off); still needs the owner to enrol two authenticators, test sign-in and a payout at aal2, then turn the flag on and set `ADMIN_MFA_EXPECTED=true` | Medium | open | Owner (RUNBOOKS "Two-step sign-in") |
| Real low-value receive → withdraw reconciliation | Medium | open | Owner |
| Workflows unpinned / no permissions | High | closed | #86 |
| main not branch-protected | High | closed | repo setting 2026-10-13 |
