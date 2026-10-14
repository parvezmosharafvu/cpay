import { adminMfaEnforced, adminMfaHealth, mfaFlagOn, sessionIsAal2 } from "./admin-mfa.ts";

function eq(a: unknown, b: unknown, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
const b64u = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const tok = (aal: string) => `Bearer ${b64u({ alg: "ES256" })}.${b64u({ sub: "u", aal })}.sig`;
const reader = (result: { data: unknown; error: unknown }) => ({
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(result) }) }) }),
});

Deno.test("flag: JSON true or the string \"true\" only", () => {
  eq([true, "true"].map(mfaFlagOn), [true, true], "on");
  eq([false, "false", null, undefined, 1, "TRUE "].map(mfaFlagOn), [false, false, false, false, false, false], "off");
});

Deno.test("enforced: reads the flag; a failed read fails closed", async () => {
  eq(await adminMfaEnforced(reader({ data: { value: true }, error: null })), true, "true");
  eq(await adminMfaEnforced(reader({ data: { value: false }, error: null })), false, "false");
  eq(await adminMfaEnforced(reader({ data: null, error: null })), false, "no row");
  eq(await adminMfaEnforced(reader({ data: null, error: { message: "boom" } })), true, "read error");
});

Deno.test("aal2 session: only an aal2 token", () => {
  eq(sessionIsAal2(tok("aal2")), true, "aal2");
  eq(sessionIsAal2(tok("aal1")), false, "aal1");
  eq(sessionIsAal2("Bearer not-a-jwt"), false, "junk");
  eq(sessionIsAal2(null), false, "none");
});

Deno.test("health verdict: lockout risk and owner expectation are unsafe", () => {
  eq(adminMfaHealth({ enforced: true, admins_without_factor: 0 }, false).ok, true, "required, everyone enrolled");
  eq(adminMfaHealth({ enforced: true, admins_without_factor: 1 }, false).ok, false, "required, an admin without a factor");
  eq(adminMfaHealth({ enforced: false }, false).ok, true, "not required, not expected (rollout pending)");
  eq(adminMfaHealth({ enforced: false }, true).ok, false, "expected but switched off");
  eq(adminMfaHealth(null, false).ok, true, "no data, not expected");
});
