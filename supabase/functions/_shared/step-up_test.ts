import { checkStepUp, decodeJwtPayload, sessionIsStrong, stepUpWindow } from "./step-up.ts";

function eq(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`);
}
const b64u = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const tok = (claims: Record<string, unknown>) => `${b64u({ alg: "ES256" })}.${b64u(claims)}.sig`;
const NOW = 1_800_000_000;

Deno.test("window: default 600, explicit seconds, 0 = off, junk = default", () => {
  eq(stepUpWindow(undefined), 600, "unset");
  eq(stepUpWindow("300"), 300, "300");
  eq(stepUpWindow("0"), 0, "off");
  eq(stepUpWindow("ten"), 600, "junk");
});

Deno.test("a recent password sign-in passes; an old one or a refresh-only session does not", () => {
  const fresh = tok({ sub: "u", aal: "aal1", amr: [{ method: "password", timestamp: NOW - 60 }] });
  eq(checkStepUp(fresh, { factors: [] }, 600, NOW).ok, true, "fresh");
  const old = tok({ sub: "u", aal: "aal1", amr: [{ method: "password", timestamp: NOW - 3600 }] });
  const r = checkStepUp(old, null, 600, NOW);
  eq(r.ok, false, "old");
  eq(!r.ok && r.reason, "stale_sign_in", "reason");
  eq(checkStepUp(tok({ sub: "u", amr: [] }), null, 600, NOW).ok, false, "no amr");
  eq(checkStepUp(tok({ sub: "u", amr: [{ method: "anonymous", timestamp: NOW }] }), null, 600, NOW).ok, false, "anonymous");
  eq(checkStepUp(tok({ sub: "u", amr: [{ method: "password", timestamp: NOW + 3600 }] }), null, 600, NOW).ok, false, "future");
  eq(checkStepUp(old, null, 0, NOW).ok, true, "switched off");
});

Deno.test("an account with verified MFA needs an aal2 token", () => {
  const aal1 = tok({ sub: "u", aal: "aal1", amr: [{ method: "password", timestamp: NOW - 10 }] });
  const r = checkStepUp(aal1, { factors: [{ status: "verified" }] }, 600, NOW);
  eq(!r.ok && r.reason, "mfa_required", "aal1 refused");
  const aal2 = tok({ sub: "u", aal: "aal2", amr: [{ method: "totp", timestamp: NOW - 10 }, { method: "password", timestamp: NOW - 20 }] });
  eq(checkStepUp(aal2, { factors: [{ status: "verified" }] }, 600, NOW).ok, true, "aal2 ok");
  eq(checkStepUp(aal1, { factors: [{ status: "unverified" }] }, 600, NOW).ok, true, "unverified factor ignored");
});

Deno.test("malformed tokens never pass", () => {
  eq(checkStepUp(null, null, 600, NOW).ok, false, "null");
  eq(checkStepUp("a.b", null, 600, NOW).ok, false, "two parts");
  eq(checkStepUp("a.!!!.c", null, 600, NOW).ok, false, "bad b64");
  eq(decodeJwtPayload("x.e30.y") !== null, true, "empty object decodes");
});

Deno.test("password then TOTP (what reauth.js now produces) passes; aal2 with a stale TOTP does not", () => {
  const factors = { factors: [{ status: "verified" }] };
  const fresh = tok({ sub: "u", aal: "aal2", amr: [{ method: "totp", timestamp: NOW - 5 }, { method: "password", timestamp: NOW - 20 }] });
  eq(checkStepUp(fresh, factors, 600, NOW).ok, true, "fresh password + totp, aal2");
  const mfaSpelling = tok({ sub: "u", aal: "aal2", amr: [{ method: "mfa/totp", timestamp: NOW - 5 }, { method: "password", timestamp: NOW - 20 }] });
  eq(checkStepUp(mfaSpelling, factors, 600, NOW).ok, true, "mfa/totp spelling with a fresh password");
  const stale = tok({ sub: "u", aal: "aal2", amr: [{ method: "totp", timestamp: NOW - 3600 }, { method: "password", timestamp: NOW - 3700 }] });
  const r = checkStepUp(stale, factors, 600, NOW);
  eq(!r.ok && r.reason, "stale_sign_in", "an hour-old aal2 session still re-authenticates");
});

Deno.test("a fresh passkey sign-in passes, also on an account with an old authenticator (20261021020000)", () => {
  const pk = tok({ sub: "u", aal: "aal1", amr: [{ method: "passkey", timestamp: NOW - 30 }] });
  eq(checkStepUp(pk, { factors: [] }, 600, NOW).ok, true, "passkey, no authenticator");
  eq(checkStepUp(pk, { factors: [{ status: "verified" }] }, 600, NOW).ok, true, "passkey is the strong factor");
  const both = tok({ sub: "u", aal: "aal2", amr: [{ method: "totp", timestamp: NOW - 5 }, { method: "passkey", timestamp: NOW - 30 }] });
  eq(checkStepUp(both, { factors: [{ status: "verified" }] }, 600, NOW).ok, true, "passkey + code");
  const old = tok({ sub: "u", aal: "aal1", amr: [{ method: "passkey", timestamp: NOW - 3600 }] });
  eq(checkStepUp(old, null, 600, NOW).ok, false, "an hour-old passkey sign-in re-authenticates");
});

Deno.test("an account with an old authenticator: a password alone (aal1) is still refused", () => {
  const pw = tok({ sub: "u", aal: "aal1", amr: [{ method: "password", timestamp: NOW - 30 }] });
  const r = checkStepUp(pw, { factors: [{ status: "verified" }] }, 600, NOW);
  eq(!r.ok && r.reason, "mfa_required", "no weakening: needs the passkey");
  // An earlier passkey sign-in in the same session plus a fresh password passes,
  // like an aal2 session with a fresh password did before.
  const mix = tok({ sub: "u", aal: "aal1", amr: [{ method: "password", timestamp: NOW - 30 }, { method: "passkey", timestamp: NOW - 5000 }] });
  eq(checkStepUp(mix, { factors: [{ status: "verified" }] }, 600, NOW).ok, true, "strong session + fresh password");
});

Deno.test("sessionIsStrong: aal2 or a passkey sign-in; password, Google and email links are not", () => {
  eq(sessionIsStrong("Bearer " + tok({ sub: "u", aal: "aal2", amr: [] })), true, "aal2");
  eq(sessionIsStrong(tok({ sub: "u", aal: "aal1", amr: [{ method: "passkey", timestamp: NOW }] })), true, "passkey");
  for (const method of ["password", "oauth", "recovery", "magiclink", "otp"]) {
    eq(sessionIsStrong(tok({ sub: "u", aal: "aal1", amr: [{ method, timestamp: NOW }] })), false, method);
  }
  eq(sessionIsStrong(null), false, "no token");
  eq(sessionIsStrong("garbage"), false, "bad token");
});

Deno.test("email-link sessions never satisfy step-up: reset, confirmation, magic link, email code, invite", () => {
  for (const method of ["recovery", "email/signup", "magiclink", "otp", "invite", "email_change", "anonymous", "token_refresh"]) {
    const t = tok({ sub: "u", aal: "aal1", amr: [{ method, timestamp: NOW - 5 }] });
    const r = checkStepUp(t, { factors: [] }, 600, NOW);
    eq(r.ok, false, `${method} must not count`);
    eq(!r.ok && r.reason, "stale_sign_in", `${method} reason`);
  }
});

Deno.test("a reset link plus the authenticator code is still not a fresh sign-in", () => {
  // Inbox + second factor, but no first factor: refused until a password,
  // passkey or Google sign-in.
  const factors = { factors: [{ status: "verified" }] };
  const t = tok({ sub: "u", aal: "aal2", amr: [{ method: "totp", timestamp: NOW - 5 }, { method: "recovery", timestamp: NOW - 30 }] });
  eq(checkStepUp(t, factors, 600, NOW).ok, false, "recovery + totp");
  const totpOnly = tok({ sub: "u", aal: "aal2", amr: [{ method: "totp", timestamp: NOW - 5 }] });
  eq(checkStepUp(totpOnly, factors, 600, NOW).ok, false, "a code alone is not a sign-in");
});

Deno.test("the first factors CPAY offers pass when fresh: password, passkey; Google no longer counts", () => {
  const g = tok({ sub: "u", aal: "aal1", amr: [{ method: "oauth", timestamp: NOW - 60 }] });
  eq(checkStepUp(g, { factors: [] }, 600, NOW).ok, false, "oauth (Google) is off since 2026-10-21");
  for (const method of ["password", "passkey"]) {
    const t = tok({ sub: "u", aal: "aal1", amr: [{ method, timestamp: NOW - 60 }] });
    eq(checkStepUp(t, { factors: [] }, 600, NOW).ok, true, method);
  }
  // An old password sign-in followed by a fresh reset link stays stale.
  const mixed = tok({ sub: "u", aal: "aal1", amr: [{ method: "recovery", timestamp: NOW - 5 }, { method: "password", timestamp: NOW - 3600 }] });
  eq(checkStepUp(mixed, { factors: [] }, 600, NOW).ok, false, "stale password + fresh recovery");
});
