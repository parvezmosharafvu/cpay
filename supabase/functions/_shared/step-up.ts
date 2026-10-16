// Step-up for money-moving confirms: the caller must have signed in with a
// first factor CPAY offers (password, passkey, Google) within the last few
// minutes, not merely hold a session that keeps refreshing. Supabase puts
// each sign-in method and its time in the access token's "amr" claim, which
// survives refreshes unchanged, so a stolen refresh token or a laptop left
// signed in for a day cannot confirm a payout without signing in again.
// When the account has a verified MFA factor, the token must also be aal2.
//
// Email-link sessions never count: a password-reset link ("recovery"), a
// sign-up confirmation, a magic link, a one-time email code or an invite
// only prove access to the inbox. Before 2026-10-17 they did, so whoever
// could read a member's email (without the password) could open a reset
// link and confirm a payout from that session. A fresh authenticator code
// (totp) proves the second factor only; the first factor must be fresh too.
//
// Only call this AFTER auth.getUser() accepted the same token: the claims are
// read without checking the signature here because Supabase Auth just did.
//
// Edge secret STEP_UP_MAX_AGE_SECONDS: default 600; "0" turns the check off
// (rollback switch).

export const DEFAULT_STEP_UP_SECONDS = 600;
// "passkey" is a passkey sign-in (aal1: an account with an authenticator
// still needs its code, checked below). "oauth" is Google. "sso/saml" is
// kept for enterprise SSO, which CPAY does not offer today.
export const FRESH_SIGN_IN_METHODS: ReadonlySet<string> = new Set(["password", "passkey", "oauth", "sso/saml"]);

export function stepUpWindow(raw: string | undefined | null): number {
  const s = String(raw ?? "").trim();
  if (s === "") return DEFAULT_STEP_UP_SECONDS;
  if (!/^\d{1,6}$/.test(s)) return DEFAULT_STEP_UP_SECONDS;
  return Number(s);
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
    const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
    return json && typeof json === "object" ? json as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export type StepUp = { ok: true } | { ok: false; reason: "stale_sign_in" | "mfa_required" | "no_token" };

// user: what auth.getUser() returned (its "factors" list, when present).
export function checkStepUp(
  token: string | null,
  user: { factors?: Array<{ status?: string }> | null } | null,
  maxAgeSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): StepUp {
  if (maxAgeSeconds <= 0) return { ok: true };
  if (!token) return { ok: false, reason: "no_token" };
  const claims = decodeJwtPayload(token);
  if (!claims) return { ok: false, reason: "no_token" };
  const hasMfa = Array.isArray(user?.factors) && user!.factors!.some((f) => f?.status === "verified");
  if (hasMfa && claims.aal !== "aal2") return { ok: false, reason: "mfa_required" };
  const amr = Array.isArray(claims.amr) ? claims.amr as Array<{ method?: unknown; timestamp?: unknown }> : [];
  let latest = 0;
  for (const e of amr) {
    const t = Number(e?.timestamp);
    if (typeof e?.method === "string" && FRESH_SIGN_IN_METHODS.has(e.method) && Number.isFinite(t) && t > latest) latest = t;
  }
  if (latest === 0 || nowSeconds - latest > maxAgeSeconds || latest > nowSeconds + 120) return { ok: false, reason: "stale_sign_in" };
  return { ok: true };
}

export const STEP_UP_MESSAGE = "For your security, enter your password again to confirm this payout.";
