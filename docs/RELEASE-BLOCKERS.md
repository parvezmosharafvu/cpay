# Release blockers

Read by `scripts/release-gate.mjs`: any row with severity Critical or High and status `open` refuses a release. Keep one row per finding; close it with the PR that fixed it.

| Finding | Severity | Status | Owner / PR |
|---|---|---|---|
| Draft legal pages (terms, privacy, refund, contact) | Medium | open | Owner legal sign-off; gate also checks text |
| Admin MFA not enrolled | Medium | open | Owner |
| Real low-value receive → withdraw reconciliation | Medium | open | Owner |
| Workflows unpinned / no permissions | High | closed | #86 |
| main not branch-protected | High | closed | repo setting 2026-10-13 |
