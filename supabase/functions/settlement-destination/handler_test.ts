import { assertEquals } from "jsr:@std/assert@1";
import { createHandler, type Db, type User } from "./handler.ts";
import type { DestinationCheck, SettlementProvider } from "../_shared/direct-settlement.ts";
import { LnurlError } from "../_shared/lnurl.ts";
import type { StepUp } from "../_shared/step-up.ts";

const USER: User = { id: "77777777-7777-4777-8777-777777777777" };
const CHECKED: DestinationCheck = {
  address: "alice@pay.example.com", domain: "pay.example.com", callbackHost: "pay.example.com",
  minSendableMsat: 1500n, maxSendableMsat: 1_000_000_000n, description: "Pay alice",
};

function setup(o: { fresh?: boolean; passkey?: boolean; limit?: boolean | undefined; saveError?: string; providerError?: LnurlError } = {}) {
  const saved: string[] = [];
  let removed = 0;
  const provider: SettlementProvider = {
    kind: "lightning_address",
    checkDestination: (a) => o.providerError ? Promise.reject(o.providerError) : Promise.resolve({ ...CHECKED, address: a.trim().toLowerCase() }),
    createInvoice: () => Promise.reject(new Error("unused")),
    check: () => Promise.reject(new Error("unused")),
  };
  const db: Db = {
    claimLimit: () => Promise.resolve("limit" in o ? o.limit : true),
    save: (_u, d) => {
      if (o.saveError) return Promise.resolve({ error: o.saveError });
      saved.push(d.address);
      return Promise.resolve({ address: d.address, ready_at: "2026-10-19T00:00:00Z", unchanged: false });
    },
    remove: () => { removed++; return Promise.resolve(1); },
  };
  const handler = createHandler({
    getUser: (h) => Promise.resolve(h === "Bearer good" ? USER : null),
    stepUp: (): StepUp => (o.fresh === false ? { ok: false, reason: "stale_sign_in" } : { ok: true }),
    passkeyStepUp: (): StepUp => (o.fresh === false ? { ok: false, reason: "stale_sign_in" } : o.passkey === false ? { ok: false, reason: "passkey_required" } : { ok: true }),
    provider, db, cors: () => Promise.resolve({ "Access-Control-Allow-Origin": "https://site.example" }), log: () => {},
  });
  const call = async (body: unknown, auth = "Bearer good") => {
    const res = await handler(new Request("https://fn", { method: "POST", body: JSON.stringify(body), headers: auth ? { Authorization: auth } : {} }));
    return { status: res.status, body: await res.json(), cors: res.headers.get("access-control-allow-origin") };
  };
  return { call, saved, removed: () => removed };
}

Deno.test("signed-in members only", async () => {
  const s = setup();
  assertEquals((await s.call({ action: "check", address: "a@b.com" }, "")).status, 401);
  assertEquals((await s.call({ action: "check", address: "a@b.com" }, "Bearer bad")).status, 401);
  assertEquals((await s.call({ action: "nope" })).status, 400);
});

Deno.test("check: provider verdict, nothing saved", async () => {
  const s = setup();
  const r = await s.call({ action: "check", address: " Alice@Pay.Example.com " });
  assertEquals([r.status, r.body.address, r.body.minSats, r.body.maxSats, r.cors], [200, "alice@pay.example.com", 2, 1_000_000, "https://site.example"]);
  assertEquals(s.saved, []);
  const bad = setup({ providerError: new LnurlError("no_verify", "This wallet provider does not confirm payments (LUD-21), so CPAY could not tell your payers when they have paid.") });
  const b = await bad.call({ action: "check", address: "x@y.com" });
  assertEquals(b.status, 422);
  assertEquals(b.body.error.includes("does not confirm payments"), true);
  const raw = setup({ providerError: new LnurlError("provider_error", "<b>provider says</b>") });
  assertEquals((await raw.call({ action: "check", address: "x@y.com" })).body.error.includes("provider says"), false);
  assertEquals((await setup({ limit: false }).call({ action: "check", address: "x@y.com" })).status, 429);
  assertEquals((await setup({ limit: undefined }).call({ action: "check", address: "x@y.com" })).status, 503);
});

Deno.test("save and remove need a fresh sign-in", async () => {
  const stale = setup({ fresh: false });
  const r = await stale.call({ action: "save", address: "alice@pay.example.com" });
  assertEquals([r.status, r.body.code], [403, "reauth_required"]);
  assertEquals(r.body.error, "Confirm with your passkey to change address");
  const rm = await stale.call({ action: "remove" });
  assertEquals([rm.status, rm.body.error], [403, "For your security, sign in again with your passkey or password to remove your payout address."]);
  assertEquals([stale.saved.length, stale.removed()], [0, 0]);
});

Deno.test("save: checked again on the server, then saved with its wait", async () => {
  const s = setup();
  const r = await s.call({ action: "save", address: "Alice@Pay.Example.com" });
  assertEquals([r.status, r.body.readyAt, s.saved], [200, "2026-10-19T00:00:00Z", ["alice@pay.example.com"]]);
  const off = setup({ saveError: "Direct payments are not available yet" });
  assertEquals((await off.call({ action: "save", address: "a@b.com" })).body.error, "Direct payments are not available yet");
  const odd = setup({ saveError: "duplicate key value violates something internal" });
  assertEquals((await odd.call({ action: "save", address: "a@b.com" })).body.error, "Could not save that. Try again in a moment.");
  const rm = await s.call({ action: "remove" });
  assertEquals([rm.status, rm.body.removed, s.removed()], [200, 1, 1]);
});

Deno.test("save needs a passkey session; a fresh password session is refused, remove still works with it", async () => {
  const pw = setup({ passkey: false });
  const r = await pw.call({ action: "save", address: "alice@pay.example.com" });
  assertEquals([r.status, r.body.code, r.body.reason, r.body.error], [403, "reauth_required", "passkey_required", "Confirm with your passkey to change address"]);
  assertEquals(pw.saved.length, 0);
  assertEquals((await pw.call({ action: "remove" })).status, 200);
});
