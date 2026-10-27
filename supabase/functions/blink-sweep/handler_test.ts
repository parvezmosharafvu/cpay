import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createHandler, type Deps, moveCents, outcome, type OpenSweep, run, STALE_AFTER_MS } from "./handler.ts";
import { blinkConfig } from "../_shared/blink.ts";
import type { Bolt11 } from "../_shared/bolt11.ts";

const NOW = 1_800_000_000_000;
const cfg = { enabled: true, keepCents: 0, minCents: 500, maxCents: 20_000, destination: "cpay@breez.tips" };
const bolt = (msat: bigint): Bolt11 => ({
  network: "bitcoin", amountMsat: msat, timestamp: NOW / 1000, expirySeconds: 600, expiresAtMs: NOW + 600_000,
  paymentHash: "ab".repeat(32), paymentSecret: null, description: null, descriptionHash: "cd".repeat(32), payeePubkey: null, invoice: "lnbc1test",
});

function deps(over: Partial<Deps> = {}, state: { open?: OpenSweep | null; balance?: number } = {}) {
  const calls = { begin: [] as unknown[], finish: [] as unknown[], pay: [] as unknown[], invoice: [] as unknown[], alerts: [] as string[] };
  const d: Deps = {
    cronSecret: "cron", configured: true,
    config: () => Promise.resolve({ ...cfg }),
    open: () => Promise.resolve(state.open ?? null),
    usdWallet: () => Promise.resolve({ id: "usd-wallet", balanceCents: state.balance ?? 10_000 }),
    usdToSats: (c) => Promise.resolve(c * 10), // $1 = 1,000 sats
    invoice: (a, m) => { calls.invoice.push([a, m]); return Promise.resolve(bolt(m)); },
    begin: (b) => { calls.begin.push(b); return Promise.resolve("sweep-1"); },
    finish: (id, s, e) => { calls.finish.push([id, s, e]); return Promise.resolve(); },
    pay: (w, b) => { calls.pay.push([w, b]); return Promise.resolve({ status: "SUCCESS", error: null }); },
    alert: (t) => { calls.alerts.push(t); return Promise.resolve(); },
    now: () => NOW,
    ...over,
  };
  return { d, calls };
}
const post = (h: (r: Request) => Promise<Response>, secret = "cron") =>
  h(new Request("http://x/blink-sweep", { method: "POST", headers: { "x-cron-secret": secret } }));

Deno.test("auth: wrong or missing cron secret is refused; GET is refused", async () => {
  const { d, calls } = deps();
  const h = createHandler(d);
  assertEquals((await post(h, "nope")).status, 401);
  assertEquals((await h(new Request("http://x/", { method: "POST" }))).status, 401);
  assertEquals((await h(new Request("http://x/", { method: "GET" }))).status, 405);
  assertEquals((await post(createHandler({ ...d, cronSecret: "" }), "")).status, 401);
  assertEquals(calls.pay.length, 0);
});

Deno.test("no Blink key: nothing happens", async () => {
  const { d, calls } = deps({ configured: false });
  const r = await post(createHandler(d));
  assertEquals(await r.json(), { skipped: "not_configured" });
  assertEquals(calls.pay.length, 0);
});

Deno.test("move amount: balance minus keep, capped, below the minimum is nothing", () => {
  assertEquals(moveCents(10_000, { keepCents: 0, minCents: 500, maxCents: 20_000 }), 10_000);
  assertEquals(moveCents(10_000, { keepCents: 2_000, minCents: 500, maxCents: 20_000 }), 8_000);
  assertEquals(moveCents(90_000, { keepCents: 0, minCents: 500, maxCents: 20_000 }), 20_000);
  assertEquals(moveCents(2_400, { keepCents: 2_000, minCents: 500, maxCents: 20_000 }), 0);
  assertEquals(moveCents(-50, { keepCents: 0, minCents: 0, maxCents: 20_000 }), 0);
  assertEquals(moveCents(0, { keepCents: 0, minCents: 0, maxCents: 20_000 }), 0);
});

Deno.test("status mapping", () => {
  assertEquals(outcome("SUCCESS"), "sent");
  assertEquals(outcome("ALREADY_PAID"), "sent");
  assertEquals(outcome("PENDING"), "pending");
  assertEquals(outcome("FAILURE"), "failed");
});

Deno.test("sweep: invoice from the primary wallet's address for 98% of the estimate, recorded before paying", async () => {
  const order: string[] = [];
  const { d, calls } = deps();
  const base = { ...d };
  d.begin = (b) => { order.push("begin"); return base.begin(b); };
  d.pay = (w, b) => { order.push("pay"); return base.pay(w, b); };
  const out = await run(d);
  assertEquals(out, { id: "sweep-1", status: "sent", amountCents: 10_000, amountSat: 98_000 });
  assertEquals(calls.invoice, [["cpay@breez.tips", 98_000_000n]]);
  assertEquals(order, ["begin", "pay"]);
  assertEquals(calls.pay, [["usd-wallet", "lnbc1test"]]);
  assertEquals(calls.finish, [["sweep-1", "sent", null]]);
  assert(calls.alerts[0].includes("$100.00"));
});

Deno.test("off, no destination, below the minimum, busy: nothing is paid", async () => {
  for (const [over, state, skipped] of [
    [{ config: () => Promise.resolve({ ...cfg, enabled: false }) }, {}, "off"],
    [{ config: () => Promise.resolve({ ...cfg, destination: null }) }, {}, "no_destination"],
    [{ config: () => Promise.resolve({ ...cfg, destination: "not an address" }) }, {}, "no_destination"],
    [{}, { balance: 499 }, "below_minimum"],
    [{ begin: () => Promise.resolve(null) }, {}, "busy"],
  ] as [Partial<Deps>, { balance?: number }, string][]) {
    const { d, calls } = deps(over, state);
    const out = await run(d);
    assertEquals(out.skipped, skipped);
    assertEquals(calls.pay.length, 0);
  }
});

Deno.test("Blink refuses: recorded failed with the reason, alert sent", async () => {
  const { d, calls } = deps({ pay: () => Promise.resolve({ status: "FAILURE", error: "Insufficient balance" }) });
  const out = await run(d);
  assertEquals(out.status, "failed");
  assertEquals(calls.finish, [["sweep-1", "failed", "Insufficient balance"]]);
  assert(calls.alerts[0].includes("Insufficient balance"));
});

Deno.test("network error while paying: left 'sending' for the next run", async () => {
  const { d, calls } = deps({ pay: () => Promise.reject(new Error("timeout")) });
  const out = await run(d);
  assertEquals(out.status, "sending");
  assertEquals(calls.finish.length, 0);
});

const open: OpenSweep = { id: "old", walletId: "usd-wallet", bolt11: "lnbc1old", expiresAtMs: NOW - 1000, amountCents: 5_000, destination: "cpay@breez.tips" };

Deno.test("open sweep: paid again with the same invoice; ALREADY_PAID closes it as sent; no new sweep", async () => {
  const { d, calls } = deps({ pay: (w, b) => { calls.pay.push([w, b]); return Promise.resolve({ status: "ALREADY_PAID", error: null }); } }, { open });
  const out = await run(d);
  assertEquals(out, { resolved: "old", status: "sent" });
  assertEquals(calls.pay, [["usd-wallet", "lnbc1old"]]);
  assertEquals(calls.begin.length, 0);
  assertEquals(calls.invoice.length, 0);
  assertEquals(calls.finish, [["old", "sent", null]]);
});

Deno.test("open sweep still pending: kept open; long after expiry it closes as unknown with an alert", async () => {
  const pending = { pay: () => Promise.resolve({ status: "PENDING" as const, error: null }) };
  let { d, calls } = deps(pending, { open });
  assertEquals(await run(d), { resolved: "old", status: "pending" });
  assertEquals(calls.finish.length, 0);
  ({ d, calls } = deps({ ...pending, now: () => NOW + STALE_AFTER_MS + 1 }, { open }));
  assertEquals((await run(d)).status, "unknown");
  assertEquals(calls.finish[0], ["old", "unknown", "still pending after the invoice expired"]);
  assert(calls.alerts.length === 1);
});

Deno.test("open sweep while switched off: not paid again", async () => {
  const { d, calls } = deps({ config: () => Promise.resolve({ ...cfg, enabled: false }) }, { open });
  assertEquals(await run(d), { skipped: "off", open: "old" });
  assertEquals(calls.pay.length, 0);
});

Deno.test("an error inside a run is a 502 with the message, never the key", async () => {
  const { d } = deps({ usdWallet: () => Promise.reject(new Error("Blink answered 401")) });
  const r = await post(createHandler(d));
  assertEquals(r.status, 502);
  assertEquals(await r.json(), { error: "Blink answered 401" });
});

Deno.test("blinkConfig: key needed; only Blink hosts over https", () => {
  const env = (o: Record<string, string>) => ({ get: (k: string) => o[k] });
  assertEquals(blinkConfig(env({})), null);
  assertEquals(blinkConfig(env({ BLINK_API_KEY: "k" }))?.url, "https://api.blink.sv/graphql");
  assertEquals(blinkConfig(env({ BLINK_API_KEY: "k", BLINK_API_URL: "https://api.staging.blink.sv/graphql" }))?.url, "https://api.staging.blink.sv/graphql");
  assertEquals(blinkConfig(env({ BLINK_API_KEY: "k", BLINK_API_URL: "https://evil.example/graphql" })), null);
  assertEquals(blinkConfig(env({ BLINK_API_KEY: "k", BLINK_API_URL: "http://api.blink.sv/graphql" })), null);
});
