# Release blockers

Read by `scripts/release-gate.mjs`: any row with severity Critical or High and status `open` refuses a release. Keep one row per finding; close it with the PR that fixed it.

| Finding | Severity | Status | Owner / PR |
|---|---|---|---|
| Draft legal pages (terms, privacy, refund, contact) | Medium | open | Owner legal sign-off; gate also checks text |
| Admin MFA: the app has no MFA login challenge and payout re-auth gives only aal1, so enrolling a factor today blocks payouts without protecting sign-in; needs implementation (enrolment + challenge, then aal2 enforcement behind a flag), then owner enrolment and enabling the flag | Medium | open | Code PRs, then owner |
| Real low-value receive → withdraw reconciliation | Medium | open | Owner |
| Workflows unpinned / no permissions | High | closed | #86 |
| main not branch-protected | High | closed | repo setting 2026-10-13 |
