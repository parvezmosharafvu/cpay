// Headers for a call to the payment service (payment-service/auth.mjs).
//
// PAYMENT_SERVICE_AUTH_MODE (Edge secret):
//   bearer (default, rollout) — the legacy "Authorization: Bearer <secret>"
//   signed (target)           — an HMAC-SHA256 signature over timestamp,
//                               nonce, method, path and body; the secret
//                               itself never leaves the function
// Switch to "signed" only once the running payment service accepts signed
// requests (its /metrics shows requestAuthMode), then set the service's
// REQUEST_AUTH_MODE=signed to retire the bearer.

export type ServiceAuthMode = "bearer" | "signed";

export function serviceAuthMode(raw: string | undefined | null): ServiceAuthMode {
  return String(raw ?? "").trim().toLowerCase() === "signed" ? "signed" : "bearer";
}

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256HexOf(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

export function canonicalRequest(ts: string, nonce: string, method: string, path: string, bodySha: string): string {
  return `cpay-v1\n${ts}\n${nonce}\n${method.toUpperCase()}\n${path}\n${bodySha}`;
}

export async function signServiceRequest(secret: string, ts: string, nonce: string, method: string, path: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(canonicalRequest(ts, nonce, method, path, await sha256HexOf(body))));
  return `v1=${hex(mac)}`;
}

function newNonce(): string {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// path is the request path plus query exactly as sent (e.g. "/admin/wallet/info");
// body is the exact string sent ("" for none).
export async function serviceAuthHeaders(
  opts: { mode: ServiceAuthMode; secret: string; method: string; path: string; body: string; now?: () => number; nonce?: () => string },
): Promise<Record<string, string>> {
  if (opts.mode !== "signed") return { "Authorization": `Bearer ${opts.secret}` };
  const ts = String((opts.now ?? Date.now)());
  const nonce = (opts.nonce ?? newNonce)();
  return {
    "X-Cpay-Timestamp": ts,
    "X-Cpay-Nonce": nonce,
    "X-Cpay-Signature": await signServiceRequest(opts.secret, ts, nonce, opts.method, opts.path, opts.body),
  };
}

// The caller's raw access token from "Authorization: Bearer <jwt>", for
// forwarding to the payment service as X-Cpay-Admin-Token.
export function bearerToken(header: string | null): string | null {
  const m = /^Bearer\s+([A-Za-z0-9._-]+)$/.exec(String(header ?? "").trim());
  return m ? m[1] : null;
}
