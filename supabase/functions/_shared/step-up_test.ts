import { checkStepUp, decodeJwtPayload, stepUpWindow } from "./step-up.ts";

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
  const mfaOnly = tok({ sub: "u", aal: "aal2", amr: [{ method: "mfa/totp", timestamp: NOW - 5 }] });
  eq(checkStepUp(mfaOnly, factors, 600, NOW).ok, true, "mfa/totp spelling");
  const stale = tok({ sub: "u", aal: "aal2", amr: [{ method: "totp", timestamp: NOW - 3600 }, { method: "password", timestamp: NOW - 3700 }] });
  const r = checkStepUp(stale, factors, 600, NOW);
  eq(!r.ok && r.reason, "stale_sign_in", "an hour-old aal2 session still re-authenticates");
});

Deno.test("a fresh passkey sign-in passes; with an authenticator it still needs the code (aal2)", () => {
  const pk = tok({ sub: "u", aal: "aal1", amr: [{ method: "passkey", timestamp: NOW - 30 }] });
  eq(checkStepUp(pk, { factors: [] }, 600, NOW).ok, true, "passkey, no authenticator");
  const r = checkStepUp(pk, { factors: [{ status: "verified" }] }, 600, NOW);
  eq(!r.ok && r.reason, "mfa_required", "passkey alone is aal1");
  const both = tok({ sub: "u", aal: "aal2", amr: [{ method: "totp", timestamp: NOW - 5 }, { method: "passkey", timestamp: NOW - 30 }] });
  eq(checkStepUp(both, { factors: [{ status: "verified" }] }, 600, NOW).ok, true, "passkey + code");
  const old = tok({ sub: "u", aal: "aal1", amr: [{ method: "passkey", timestamp: NOW - 3600 }] });
  eq(checkStepUp(old, null, 600, NOW).ok, false, "an hour-old passkey sign-in re-authenticates");
});
