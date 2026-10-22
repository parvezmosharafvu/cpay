// Signed attribution for a proxied public invoice's client IP.
// This proves the Worker wrote an IP header; it is NOT user authentication.
// Edge verifies the same versioned bytes with a short timestamp window.
export async function signClientIp(ip, secret, nowMs = Date.now()) {
  if (!secret || !ip || !/^[0-9a-fA-F:.]{2,45}$/.test(ip) || !Number.isFinite(nowMs)) return null;
  const ts = String(Math.floor(nowMs / 1000));
  const input = new TextEncoder().encode(`cpay:create-invoice:ip:v1\n${ip}\n${ts}`);
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, input));
  const raw = String.fromCharCode(...bytes);
  return { timestamp: ts, signature: btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") };
}
