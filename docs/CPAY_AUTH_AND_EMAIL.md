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

## CAPTCHA (Supabase Auth Attack Protection)

When CAPTCHA protection is on in Supabase (Authentication → Attack
Protection), Supabase Auth refuses password sign-in, sign-up and
reset-email requests without a token: `captcha protection: request
disallowed (no captcha_token found)` (seen in production on 2026-10-15,
which blocked every login). Refresh, MFA challenge/verify and opening the
reset link (`/verify`) need no token.

- `public/turnstile.js` gets a fresh Cloudflare Turnstile token per attempt
  (tokens are single-use), with error, expiry and timeout handling.
- It is passed as `captchaToken` by: log in, payout re-confirm (`reauth.js`),
  register, forgot password and "Send a new link".
- A refused check shows "The security check did not pass…", and never says
  whether an account exists.
- Payment pages stay challenge-free unless `CPAY_TURNSTILE_PAYMENTS = true`
  (a separate decision, with `TURNSTILE_MODE` on create-invoice).
- CSP already allows `https://challenges.cloudflare.com` (script and frame).

**Required configuration** (all three must match one Turnstile widget):

1. Cloudflare → Turnstile → the widget: hostname `pay-cashapp.buzz` listed.
2. Supabase → Authentication → Attack Protection: provider **Turnstile**,
   the widget's **secret** key.
3. `public/config.js`: `CPAY_TURNSTILE_SITE_KEY` = the widget's **site** key
   (public). Tests refuse anything shaped like a secret there.

Until 3 is deployed, keep CAPTCHA protection off in Supabase, or nobody can
sign in.

## Email confirmation for new accounts

With "Confirm email" on in Supabase, a new Freelancer must open the link
sent to their address before they can log in:

- Register shows **Check your inbox** (the same screen for an address that
  already has an account, so nothing reveals who is registered).
- Log in before confirming shows **Confirm your email first** with **Send the
  confirmation email again** (Supabase `/resend`, CAPTCHA token included).
- The link opens `login.html?confirmed=1`: "Email confirmed", then the usual
  admin approval (accounts start pending unless auto-approval is on).
- A used or expired link lands on a page that explains it and offers a new
  one. Accounts created before confirmation was switched on are unaffected
  (all 18 were confirmed on 2026-10-15).
- Branded template: [email-templates/confirm-signup.html](email-templates/confirm-signup.html).

## Google sign-in (removed)

Google sign-in was removed on 2026-10-21: no button, no `oauth.js`, the
provider is off in Supabase. Do not re-add it.

## Passkeys

`public/passkey.js` (Supabase Auth passkeys, WebAuthn) lets a Freelancer or
admin sign in with the device's fingerprint, face or screen lock instead of
the password. It needs supabase-js 2.105 or later (the site uses 2.117.3)
and the client opt-in in `config.js` (`auth.experimental.passkey`).

- **Shown only when on**: **Sign in with a passkey** on log in, and the
  **Passkeys** card in Security, appear only when Supabase Auth reports
  `passkeys_enabled` (public `/settings`, read by `auth-features.js`) and the
  browser supports WebAuthn.
- **Adding one**: Security → **Add a passkey** (signed in, confirmed email).
  An account with an authenticator enters its code first; the rule is
  checked when the button is pressed. Removing one asks the same.
- **Signing in**: no email or password; the browser offers the passkeys it
  holds for `pay-cashapp.buzz`. The challenge request carries a Turnstile
  token (CAPTCHA). A passkey sign-in is aal1 with amr `passkey`, so **an
  account with an authenticator still enters its code**; the account status
  check follows, as for a password sign-in.
- **Payouts**: the re-confirm dialog offers **Use a passkey** when the
  account has one (it must be the same account, otherwise the browser is
  signed out), and **Sign in with Google again** for Google accounts. The
  payout step-up (`_shared/step-up.ts`) counts a fresh `passkey` sign-in.
- **Privacy**: the private key never leaves the device or password manager;
  the pages log and store nothing (`tests/frontend/passkey-wiring.test.mjs`).

Owner setup, once:

1. Supabase → **Authentication → Passkeys** → **Enable Passkey
   authentication**.
2. Relying Party Display Name: `CPAY`.
3. Relying Party ID: `pay-cashapp.buzz` (no `https://`, no path).
   **Do not change it later**: every passkey is bound to it, and changing it
   makes all of them stop working.
4. Relying Party Origins: `https://pay-cashapp.buzz`.
5. Save. The buttons appear on the site at the next page load; no deploy.

## Two-step sign-in (TOTP) — retired

> **Retired 2026-10-21 (20261021020000).** New authenticator enrolment is off and
> Google sign-in is removed. Sign-in is email + password (verified email) or a
> passkey; step-up uses a passkey (`strong_session()`). Codes from authenticators
> enrolled earlier are still accepted only during the switch-over. The text below
> is kept for history.


- **Who**: admins (Admin → Security) and Freelancers (desk → Security). Enrol
  with any authenticator app; the QR code and key are shown once and removed
  from the page after enrolment. Two authenticators are recommended; there
  are no recovery codes.
- **Sign-in**: an account with a verified authenticator finishes signing in
  with a code (aal2). Cancel or five wrong codes signs out. Every page that
  loads the profile repeats this check (`requireSecondStep` in `app.js`).
- **Payouts**: the payout step-up asks for the password, then the code; the
  Edge Function refuses an aal1 token when the account has a verified factor.
  See [Payout re-confirm](#payout-re-confirm-step-up) for what counts.
- **Admin work**: an admin with a verified authenticator is an admin only at
  aal2 (`is_admin()`, admin-actions, auth-settings), from migration
  20261014080000, regardless of the flag. With `admin_mfa_required` on
  (20261014030000) every admin needs aal2. Admins without an authenticator
  are unaffected while the flag is off, so nothing locks the owner out.
- **Removal**: needs a current code (aal2). While admin MFA is required, an
  admin's last authenticator cannot be removed; break-glass is in
  [RUNBOOKS.md](RUNBOOKS.md#two-step-sign-in-admin-mfa).

## Payout re-confirm (step-up)

`_shared/step-up.ts` guards `user-withdraw` confirm and the admin money
actions (`admin-actions`). It passes only when the access token shows:

- a **first-factor sign-in within `STEP_UP_MAX_AGE_SECONDS`** (default 600
  seconds): `password`, `passkey` or `oauth` (Google). `sso/saml` is
  accepted for a future enterprise SSO, which CPAY does not offer today;
- and **aal2** when the account has a verified authenticator.

**Email-link sessions never count**: a password-reset link (`recovery`), a
sign-up confirmation (`email/signup`), a magic link, a one-time email code
(`otp`), an invite or an email change. They prove access to the inbox only.
Until 2026-10-17 they counted, so someone who could read a member's email,
without the password, could open a reset link and confirm a payout from
that session. An authenticator code (`totp`) proves the second factor only;
the first factor must be fresh too. The dialog then asks for the password
(with a CAPTCHA token) and the payout goes through once
(`tests/e2e/withdrawal.spec.ts`, `step-up_test.ts`).

Rollback: revert the PR (restores the old method list). The Edge secret
`STEP_UP_MAX_AGE_SECONDS=0` switches the whole step-up off, aal2 included;
it is an emergency switch only, and `health` alerts while it is set.

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
   Add to Redirect URLs: `https://pay-cashapp.buzz/reset.html` and
   `https://pay-cashapp.buzz/login.html` (confirmation and Google). Do not add
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

Sign-up email confirmation ("Confirm email") was switched on in production
on 2026-10-15 (owner screenshot); see [auth-email-setup.md](auth-email-setup.md).
Telegram alerts never contain email addresses (20261014070000).

## Tests

- `tests/frontend/password-recovery.test.mjs`: link forwarding, link
  states, no account enumeration, script order, no logging.
- `tests/e2e/auth.spec.ts`: full reset (default link, home-page fallback,
  branded link with reuse refused), unknown email, expired link with resend,
  ordinary session refused, validation, reset with an authenticator.
- `tests/e2e/member-mfa.spec.ts`, `tests/e2e/admin-mfa.spec.ts`: enrol,
  sign-in challenge, removal, enrolled admin refused at aal1.
- `tests/e2e/passkey.spec.ts`: Chromium's virtual authenticator runs the
  real WebAuthn ceremony against the stand-in Auth (which checks the
  signature): add, sign in, code still asked, code before adding, unknown
  passkey, pending account, payout re-confirm with a passkey.
- `ci/admin_aal2_enrolled_test.sql`, `ci/admin_mfa_enforcement_test.sql`,
  Deno tests for the admin gates.
