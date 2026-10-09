import { checkTurnstile, clientKey, CLOUDFLARE_WORKER_EGRESS, parseRequestId, replayDecision, sha256Hex, turnstileMode } from "./guards.ts";

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

Deno.test("client key: cloudflare header, then x-real-ip, then first forwarded hop", () => {
  eq(clientKey(new Headers({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" })), "1.2.3.4", "cf");
  eq(clientKey(new Headers({ "x-real-ip": "5.6.7.8" })), "5.6.7.8", "real");
  eq(clientKey(new Headers({ "x-forwarded-for": "7.7.7.7, 10.0.0.1" })), "7.7.7.7", "xff");
  eq(clientKey(new Headers()), "unknown", "none");
});

Deno.test("sha256Hex is 64 lowercase hex (raw IPs are never stored)", async () => {
  const h = await sha256Hex("1.2.3.4");
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error("bad hash " + h);
  eq(h, "6694f83c9f476da31f5df6bcc520034e7e57d421d247b9d34f49edbfc84a764c", "known vector");
});

Deno.test("turnstile: off without secret+mode; monitor never blocks; enforce blocks bad/missing tokens", async () => {
  eq(turnstileMode("", "enforce"), "off", "no secret");
  eq(turnstileMode("s", undefined), "off", "no mode");
  eq(turnstileMode("s", "enforce"), "enforce", "enforce");
  eq(await checkTurnstile("off", "", undefined, "1.2.3.4"), { ok: true }, "off");
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
