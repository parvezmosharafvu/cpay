import { checkTurnstile, clientKey, CLOUDFLARE_WORKER_EGRESS, parseRequestId, replayDecision, sha256Hex, turnstileMode, turnstileRemoteIp, verifiedClientKey } from "./guards.ts";
import { signClientIp } from "../../../worker/ip-signature.mjs";

function eq(a: unknown, b: unknown, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
const NOW = Date.parse("2026-10-07T12:00:00Z");
const open = { id: "p1", status: "new", amount_requested: "12.34", expires_at: "2026-10-07T12:30:00Z", lightning_invoice: "lnbc1" };

Deno.test("request ids: uuid only, normalised", () => {
  eq(parseRequestId("0F8FAD5B-D9CB-469F-A165-70867728950E"), "0f8fad5b-d9cb-469f-a165-70867728950e", "upper");
  for (const bad of [undefined, null, 5, "", "abc", "0f8fad5b-d9cb-469f-a165-70867728950", "'; drop table--"]) eq(parseRequestId(bad), null, String(bad));
});

Deno.test("replay: same open request returns the same payment, never a second", () => {
  eq(replayDecision(open, 1234, NOW), { kind: "reuse", paymentId: "p1", bolt11: "lnbc1", expiresAt: open.expires_at }, "reuse");
  eq(replayDecision({ ...open, lightning_invoice: null }, 1234, NOW).kind, "reuse", "in-flight first request");
  eq(replayDecision({ ...open, amount_requested: 12.34 }, 1234, NOW).kind, "reuse", "numeric amount");
});

Deno.test("replay: different amount, used or expiring request is refused (409)", () => {
  eq(replayDecision(open, 1235, NOW).kind, "error", "amount changed");
  eq((replayDecision({ ...open, status: "settled" }, 1234, NOW) as { status: number }).status, 409, "settled");
  eq(replayDecision({ ...open, status: "expired" }, 1234, NOW).kind, "error", "expired status");
  eq(replayDecision({ ...open, expires_at: "2026-10-07T12:00:30Z" }, 1234, NOW).kind, "error", "expires within a minute");
});

Deno.test("client key: untrusted forwarding headers cannot split rate-limit buckets", async () => {
  eq(clientKey(new Headers({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" })), "1.2.3.4", "cf");
  eq(clientKey(new Headers({ "x-real-ip": "5.6.7.8" })), "unknown", "real header untrusted");
  eq(clientKey(new Headers({ "x-forwarded-for": "7.7.7.7, 10.0.0.1" })), "unknown", "xff untrusted");
  eq(await verifiedClientKey(new Headers({ "x-forwarded-for": "7.7.7.7" }), "scoped-secret"), "unknown", "signed-IP helper also ignores untrusted headers");
  eq(clientKey(new Headers()), "unknown", "none");
});

Deno.test("sha256Hex is 64 lowercase hex (raw IPs are never stored)", async () => {
  const h = await sha256Hex("1.2.3.4");
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error("bad hash " + h);
  eq(h, "6694f83c9f476da31f5df6bcc520034e7e57d421d247b9d34f49edbfc84a764c", "known vector");
});

Deno.test("turnstile: explicit enforce without secret never downgrades to off", async () => {
  eq(turnstileMode("", "enforce"), "enforce", "missing secret still requires enforcement");
  eq(turnstileMode("  ", "enforce"), "enforce", "whitespace secret still requires enforcement");
  eq(turnstileMode("", "monitor"), "monitor", "monitor reports missing secret");
  eq(turnstileMode("s", undefined), "off", "no mode");
  eq(turnstileMode("s", "enforce"), "enforce", "enforce");
  eq(await checkTurnstile("off", "", undefined, "1.2.3.4"), { ok: true }, "off");
  let attempts = 0;
  const unexpected = (() => { attempts++; return Promise.resolve(new Response(JSON.stringify({ success: true }))); }) as unknown as typeof fetch;
  eq(await checkTurnstile("enforce", "", "tok", "1.2.3.4", unexpected), { ok: false, reason: "configuration" }, "missing secret blocks despite token");
  eq(await checkTurnstile("enforce", "  ", "tok", "1.2.3.4", unexpected), { ok: false, reason: "configuration" }, "blank secret blocks");
  eq(await checkTurnstile("monitor", "", "tok", "1.2.3.4", unexpected), { ok: true, reason: "monitor:configuration" }, "monitor logs config failure");
  eq(attempts, 0, "do not call remote verifier without a secret");
  const ok = (() => Promise.resolve(new Response(JSON.stringify({ success: true })))) as unknown as typeof fetch;
  const no = (() => Promise.resolve(new Response(JSON.stringify({ success: false })))) as unknown as typeof fetch;
  const down = (() => Promise.reject(new Error("down"))) as unknown as typeof fetch;
  eq(await checkTurnstile("enforce", "s", "tok", "1.2.3.4", ok), { ok: true }, "valid");
  eq((await checkTurnstile("enforce", "s", "tok", "1.2.3.4", no)).ok, false, "rejected");
  eq((await checkTurnstile("enforce", "s", "", "1.2.3.4", ok)).ok, false, "missing");
  eq((await checkTurnstile("enforce", "s", "tok", "1.2.3.4", down)).ok, false, "outage fails closed in enforce");
  eq((await checkTurnstile("monitor", "s", "tok", "1.2.3.4", no)).ok, true, "monitor never blocks");
});

Deno.test("client key: a Worker subrequest is keyed by the payer address our Worker forwards", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  if (clientKey(h({ "cf-connecting-ip": CLOUDFLARE_WORKER_EGRESS, "x-cpay-client-ip": "198.51.100.7" })) !== "proxied:198.51.100.7") throw new Error("proxied");
  if (clientKey(h({ "cf-connecting-ip": CLOUDFLARE_WORKER_EGRESS, "x-cpay-client-ip": "not an ip<>" })) !== `worker:${CLOUDFLARE_WORKER_EGRESS}`) throw new Error("junk header");
  if (clientKey(h({ "cf-connecting-ip": "203.0.113.9", "x-cpay-client-ip": "198.51.100.7" })) !== "203.0.113.9") throw new Error("direct ignores header");
});


Deno.test("Worker IP HMAC: trusted only with valid signature and fresh timestamp", async () => {
  const now = Date.parse("2026-10-22T07:30:00Z");
  const ip = "198.51.100.7";
  const secret = "test-scope-key-never-use-live";
  const mkHeaders = (ipValue: string, signature: { timestamp: string; signature: string } | null) => new Headers({
    "cf-connecting-ip": CLOUDFLARE_WORKER_EGRESS,
    "x-cpay-client-ip": ipValue,
    ...(signature ? { "x-cpay-ip-timestamp": signature.timestamp, "x-cpay-ip-signature": signature.signature } : {}),
  });
  const signed = await signClientIp(ip, secret, now);
  if (!signed) throw new Error("no test signature");
  eq(await verifiedClientKey(mkHeaders(ip, signed), secret, now), `proxied:${ip}`, "valid attribution");
  eq(await verifiedClientKey(mkHeaders("198.51.100.8", signed), secret, now), `worker:${CLOUDFLARE_WORKER_EGRESS}`, "tampered IP");
  eq(await verifiedClientKey(mkHeaders(ip, signed), "other-secret", now), `worker:${CLOUDFLARE_WORKER_EGRESS}`, "wrong key");
  eq(await verifiedClientKey(mkHeaders(ip, signed), secret, now + 91_000), `worker:${CLOUDFLARE_WORKER_EGRESS}`, "expired signature");
  eq(await verifiedClientKey(mkHeaders(ip, null), secret, now), `worker:${CLOUDFLARE_WORKER_EGRESS}`, "unsigned refused once key is enabled");
  eq(await verifiedClientKey(mkHeaders(ip, null), "", now), `proxied:${ip}`, "legacy until activated");
  const direct = new Headers({ "cf-connecting-ip": "203.0.113.3", "x-cpay-client-ip": ip, "x-cpay-ip-timestamp": signed.timestamp, "x-cpay-ip-signature": signed.signature });
  eq(await verifiedClientKey(direct, secret, now), "203.0.113.3", "direct client IP cannot be overridden");
  eq(turnstileRemoteIp(`proxied:${ip}`), ip, "send bare IP to Turnstile");
  eq(turnstileRemoteIp(`worker:${CLOUDFLARE_WORKER_EGRESS}`), "", "do not send egress bucket to Turnstile");
});
