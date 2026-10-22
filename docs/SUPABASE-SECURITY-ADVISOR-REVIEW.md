# CPAY Supabase security advisor review — 2026-10-22

**Scope:** read-only metadata and catalog queries on the connected `cpay` project `riumaeihemgznvgattoc` (Asia/Dhaka), plus source-file review. This is not a security certification, owner approval, production change or permission audit of every function body.

## Confirmed environment identity

- Supabase project: `cpay`, reference `riumaeihemgznvgattoc`, ACTIVE_HEALTHY; the connected organisation was reported on Pro.
- Both `supabase/config.toml` and `public/config.js` target that same project reference. `tests/frontend/supabase-project-identity.test.mjs` detects project-reference drift in CI without contacting the production database.
- Supabase reported 163 applied migrations (latest `20261021080000`) and 16 active Edge Functions when checked. These counts do **not** prove that the production deployment uses the GitHub PR's source SHA, nor that operational secrets and schedules are configured correctly.
- Catalog check: all **33/33 ordinary tables in the `public` schema have RLS enabled**. This proves RLS is switched on, not that every policy or RPC authorizes correctly.

## Security Advisor findings and evidence

| Finding | Observation | Assessment / next check |
|---|---|---|
| RLS enabled without policy | INFO, 20 findings | Such tables generally deny access through RLS for normal roles; confirm each is intentionally inaccessible. Do not add allow-all policies merely to silence the advisor. |
| Mutable function search path | WARN, 1 finding | `public.payment_forwards_no_delete()` has no pinned `search_path`. Its inspected body only raises an exception to forbid deleting payment-forward rows. It is a trigger function, `SECURITY INVOKER`, not a `SECURITY DEFINER` RPC. Pin its search path via a reviewed **new migration**, after verifying it in the disposable database. |
| Anonymous execution of SECURITY DEFINER | WARN, 14 findings | Catalog classification: **8 trigger functions**, **5 intended public-data RPCs** (`get_invoice_public`, `get_link_preview`, `get_public_site_settings`, `get_public_store`, `lookup_payment_status`), and **1 role-check function** (`is_admin`). Warning presence is not proof of a data leak. Verify grants, body authorization, output redaction, and payer/unauthenticated use cases per function before revoking access. |
| Authenticated execution of SECURITY DEFINER | WARN, 128 findings | Requires function-by-function least-privilege review. For any elevated RPC, inspect `auth.uid()`, role checks, ownership filters, reachable schemas and grants. Blanket `REVOKE` or mass switch to `SECURITY INVOKER` can break auth, checkout, triggers and RLS. |
| Insufficient MFA options | WARN, 1 finding | The project's documented owner decision is admin passkeys with TOTP disabled. Verify actual admin/passkey access and two independent physical recovery credentials before changes to live authentication. Do not change MFA settings automatically. |

The eight anonymous-executable trigger functions identified in the catalog were `gate_custodial_payment`, `gate_custodial_withdrawal`, `gate_new_custodial_link`, `guard_direct_payment_changes`, `guard_direct_settlement_switch`, `guard_link_settlement_mode`, `guard_payment_settlement_mode`, and `guard_settlement_destination_changes`. These return `trigger` and are bound to triggers; they are not normal user-callable payment RPC endpoints. Their grants may still merit least-privilege cleanup after a regression test of those triggers.

The inspected `is_admin()` function is `SECURITY DEFINER` with `search_path=public`, and its role check queries `auth.uid()`, the profile's admin status, and strong-session/MFA requirements. That is evidence of an intended access check, **not** a complete audit of all call paths.

## Safe remediation sequence (not yet executed)

1. Confirm all 20 no-policy tables are intended to deny direct reads/writes; do not weaken their RLS rules.
2. **Source remediation implemented (not deployed):** Supabase CLI generated `supabase/migrations/20261022051634_pin_forward_delete_guard_path.sql` on an ephemeral GitHub CI runner. Its migration validates the function still returns `trigger` and remains `SECURITY INVOKER`, then pins the existing `payment_forwards_no_delete()` function to an empty `search_path`. No function body, privileges, trigger bindings or ledger state are changed. `ci/payment_forward_guard_search_path_test.sql` now checks the path was **already pinned by the applied migration**, verifies deletion is still refused, and rehearses an idempotent `ALTER FUNCTION` inside **ROLLBACK**. `.github/workflows/verify.yml` runs this after applying all migrations to disposable PostgreSQL. The change still requires the **new head's green CI** and separate owner-approved release before applying to real CPAY production. The connected production Security Advisor warning is not marked resolved unless a post-deployment read-only check confirms it. Do not modify an already applied migration.
3. Review the six anonymous-executable non-trigger functions individually with anonymous and authenticated fixtures, checking output fields and ownership/redaction. Retain only privileges justified by their public APIs.
4. Review the remaining authenticated-executable definer RPCs in batches; classify whether each needs privileged execution, and test cross-account access with synthetic fixtures before any grant changes.
5. Independently verify admin recovery, Turnstile, cron authentication, wallet solvency, restore drill, and Legal / Contact publication under the owner acceptance process in `RELEASE-BLOCKERS.md`.

**No production SQL, grant, Edge Function, secret, payment or operational configuration was changed.** Do not turn off an Advisor warning or mark a release blocker closed without validating the actual security condition. Source completion and a successful Verify workflow are not evidence of production acceptance.

Supabase reference documentation:
- https://supabase.com/docs/guides/database/functions
- https://supabase.com/docs/guides/observability/advisors
- https://supabase.com/docs/guides/database/postgres/row-level-security
