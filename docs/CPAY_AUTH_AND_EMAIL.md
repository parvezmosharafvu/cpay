# CPAY: sign-in, password reset, two-step sign-in and email

Supabase Auth does all of this. CPAY has no password store, OTP table or
email sender of its own. This page records what runs, what was verified on
2026-10-14, and the owner steps that need dashboard access.

## Password reset

| Step | What happens |
|---|---|
| Request | Log in → **Forgot password?**. `auth-link.js` calls `resetPasswordForEmail(email, { redirectTo: <origin>/reset.html })`. The answer is always the same ("If an account uses that email…"), whether or not the address has an account, and also when Supabase refuses with its per-address rate limit (that limit applies only to real accounts, so showing it would reveal one). Only a malformed address or no network is reported. The button then waits 60 s ("Send again in …"). |
| Email | Supabase Auth sends it through Resend SMTP from `no-reply@pay-cashapp.buzz`. |
| Link | Default template: Supabase verifies the token and redirects with a recovery session in the URL fragment. Branded template ([email-templates/recovery.html](email-templates/recovery.html)): `reset.html?token_hash=…&type=recovery`, used only when the person taps **Continue**, so mail scanners that open links cannot use it up. |
| Landing | If Supabase falls back to the Site URL (the home page), `auth-link.js` on the home page forwards the link unchanged to `reset.html`. Before this change such a link signed the person in and sent them to the desk without ever showing the password form. |
| Form | `reset.html` states: checking, Continue (branded link), form, link problem (expired, already used, malformed, or no reset session) with **Send a new link**, done. Only a session made from a reset link may set a password there; an ordinary signed-in session may not. New password: 8 to 72 characters, typed twice. |
| Two-step | If the account has an authenticator, the code is asked before the password is saved (Supabase Auth refuses otherwise). Cancelling leaves the password unchanged. |
| After | `signOut({ scope: 'global' })` ends every session of the account; the person logs in with the new password. |

Nothing on these pages logs, stores or sends the link, password or code
(checked by `tests/frontend/password-recovery.test.mjs`). The reset page
sets `noindex` and `no-referrer`.

## Two-step sign-in (TOTP)

- **Who**: admins (Admin → Security) and Freelancers (desk → Security). Enrol
  with any authenticator app; the QR code and key are shown once and removed
  from the page after enrolment. Two authenticators are recommended; there
  are no recovery codes.
- **Sign-in**: an account with a verified authenticator finishes signing in
  with a code (aal2). Cancel or five wrong codes signs out. Every page that
  loads the profile repeats this check (`requireSecondStep` in `app.js`).
- **Payouts**: the payout step-up asks for the password, then the code; the
  Edge Function refuses an aal1 token when the account has a verified factor.
- **Admin work**: an admin with a verified authenticator is an admin only at
  aal2 (`is_admin()`, admin-actions, auth-settings), from migration
  20261014080000, regardless of the flag. With `admin_mfa_required` on
  (20261014030000) every admin needs aal2. Admins without an authenticator
  are unaffected while the flag is off, so nothing locks the owner out.
- **Removal**: needs a current code (aal2). While admin MFA is required, an
  admin's last authenticator cannot be removed; break-glass is in
  [RUNBOOKS.md](RUNBOOKS.md#two-step-sign-in-admin-mfa).

## Verified on 2026-10-14 (read-only)

| Item | Evidence | Status |
|---|---|---|
| Sending domain | Resend domain `pay-cashapp.buzz`: verified, sending enabled, open/click tracking off | Configured |
| Auth email goes through Resend | Supabase Auth reset emails appear in Resend's log, from `"cpay" <no-reply@pay-cashapp.buzz>` | Configured |
| Delivery events | 3 reset emails in Resend: 2 `delivered` (2026-09-25, 2026-09-30), 1 `bounced` (2026-10-09, an audit probe address) | Accepted and delivered by the receiving server; **inbox placement not verified** |
| Template in use | Supabase default "Reset your password" | Works; branded template optional |
| Site URL | Reset links redirect to `https://pay-cashapp.buzz` | Correct (no longer localhost) |
| Redirect URLs | Links did not use `/reset.html` but fell back to the Site URL | `/reset.html` is most likely **not** on the list. The home-page forwarding makes resets work either way |
| Accounts | 18 users, 0 unconfirmed; 3 reset emails in the last 30 days | — |
| Authenticators | 0 verified factors; 1 admin, without one | Two-step sign-in not used yet |
| Not visible to this audit | Auth settings themselves (Redirect URLs list, password minimum, TOTP enabled, rate limits, templates) | Owner checks below |

A Resend `delivered` status means the recipient's mail server accepted the
message. It does not prove it reached the inbox rather than spam.

## Owner steps (Supabase dashboard)

1. **Authentication → URL Configuration**: Site URL `https://pay-cashapp.buzz`.
   Add to Redirect URLs: `https://pay-cashapp.buzz/reset.html`. Do not add
   preview hosts (`*.workers.dev`): a reset requested from a preview then
   lands on production, which is the safe default.
2. **Authentication → Emails → Templates → Reset password** (optional): paste
   [email-templates/recovery.html](email-templates/recovery.html), subject
   "Reset your CPAY password".
3. **Authentication → Providers → Email**: minimum password length 8 or more
   (the pages require 8). Leaked-password protection needs the Pro plan.
4. **Authentication → Multi-Factor**: TOTP enabled (the default).
5. **Test with your own address**: request a reset, confirm the email is in
   the inbox (not spam) from `no-reply@pay-cashapp.buzz`, the link opens the
   reset page, the new password works, the old one does not.
6. **Admin rollout**: enrol two authenticators in Admin → Security, sign out
   and in with a code, confirm one payout; then Admin → Settings → "Require
   two-step sign-in for admins"; then set the Edge secret
   `ADMIN_MFA_EXPECTED=true`. Details: [RUNBOOKS.md](RUNBOOKS.md#two-step-sign-in-admin-mfa).

Sign-up email confirmation is off in production, so no confirmation email
is sent; turning it on is described in [auth-email-setup.md](auth-email-setup.md).
Telegram alerts never contain email addresses (20261014070000).

## Tests

- `tests/frontend/password-recovery.test.mjs`: link forwarding, link
  states, no account enumeration, script order, no logging.
- `tests/e2e/auth.spec.ts`: full reset (default link, home-page fallback,
  branded link with reuse refused), unknown email, expired link with resend,
  ordinary session refused, validation, reset with an authenticator.
- `tests/e2e/member-mfa.spec.ts`, `tests/e2e/admin-mfa.spec.ts`: enrol,
  sign-in challenge, removal, enrolled admin refused at aal1.
- `ci/admin_aal2_enrolled_test.sql`, `ci/admin_mfa_enforcement_test.sql`,
  Deno tests for the admin gates.
