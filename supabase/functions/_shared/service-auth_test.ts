import { bearerToken, serviceAuthHeaders, serviceAuthMode, signServiceRequest } from "./service-auth.ts";

function eq(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`);
}

const SECRET = "edge-secret-".padEnd(48, "e");

Deno.test("mode defaults to bearer; only 'signed' signs", () => {
  eq(serviceAuthMode(undefined), "bearer", "unset");
  eq(serviceAuthMode(""), "bearer", "empty");
  eq(serviceAuthMode("yes"), "bearer", "unknown");
  eq(serviceAuthMode(" Signed "), "signed", "signed");
});

Deno.test("bearer mode sends the legacy header only", async () => {
  const h = await serviceAuthHeaders({ mode: "bearer", secret: SECRET, method: "POST", path: "/invoices", body: "{}" });
  eq(h["Authorization"], `Bearer ${SECRET}`, "bearer");
  eq(h["X-Cpay-Signature"], undefined, "no signature");
});

Deno.test("signed mode never sends the secret and matches the payment service's canonical form", async () => {
  const h = await serviceAuthHeaders({
    mode: "signed", secret: SECRET, method: "post", path: "/admin/wallet/send-confirm", body: '{"prepareId":"abc"}',
    now: () => 1760000000000, nonce: () => "0123456789abcdef0123",
  });
  eq(h["Authorization"], undefined, "no bearer");
  eq(JSON.stringify(h).includes(SECRET), false, "secret absent");
  eq(h["X-Cpay-Timestamp"], "1760000000000", "ts");
  eq(h["X-Cpay-Nonce"], "0123456789abcdef0123", "nonce");
  // Fixed vector, cross-checked with payment-service/auth.mjs signRequest().
  eq(h["X-Cpay-Signature"], VECTOR, "signature vector");
  const other = await signServiceRequest(SECRET, "1760000000000", "0123456789abcdef0123", "POST", "/admin/wallet/send-confirm", '{"prepareId":"abd"}');
  eq(other === VECTOR, false, "body is covered");
});

Deno.test("bearerToken extracts the JWT only from a well-formed header", () => {
  eq(bearerToken("Bearer aaa.bbb.ccc"), "aaa.bbb.ccc", "ok");
  eq(bearerToken("bearer aaa.bbb.ccc"), null, "case");
  eq(bearerToken("Basic xyz"), null, "basic");
  eq(bearerToken(null), null, "null");
  eq(bearerToken("Bearer a b"), null, "space");
});

const VECTOR = "v1=c3589e353172c81e87fd2ee4a80065ee77e19b3e8ea3315b3f8c932872db56d8";
