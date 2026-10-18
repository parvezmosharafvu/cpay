import { assert, assertEquals } from "jsr:@std/assert@1";
import { createHandler, type Db, type DirectRow, type Link, type NewRow, type PublicRow } from "./handler.ts";
import type { SettlementProvider } from "../_shared/direct-settlement.ts";
import { LnurlError, type Verification } from "../_shared/lnurl.ts";
import { decodeBolt11 } from "../_shared/bolt11.ts";
import { buildInvoice, randomPreimage } from "../_shared/bolt11_testkit.ts";

const NOW = 1_800_000_000_000;
const LINK: Link = { link_id: "11111111-1111-4111-8111-111111111111", user_id: "22222222-2222-4222-8222-222222222222", is_active: true, cost_percent: 10, settlement_mode: "direct" };
const DEST = { id: "33333333-3333-4333-8333-333333333333", address: "alice@pay.example.com" };
const RATE = { usdPerBtc: 100_000, usdPerBtcCents: 10_000_000n, sources: ["a", "b"] };

type Row = NewRow & { id: string; status: "pending" | "paid" | "expired"; preimage: string | null; paid_at: string | null };

function world(over: Partial<{ createAllowed: boolean; stopped: boolean | undefined; enabled: boolean | undefined; link: Link | null | undefined; dest: typeof DEST | null; maxCents: number }> = {}) {
  const rows = new Map<string, Row>();
  const preimages = new Map<string, string>();
  const verdicts = new Map<string, Verification | "throw">();
  const calls = { release: 0, provider: 0, checks: 0, claims: 0 };
  let claimAllowed = true;
  const env = {
    stopped: "stopped" in over ? over.stopped : false,
    enabled: "enabled" in over ? over.enabled : true,
    link: "link" in over ? over.link : LINK,
    dest: "dest" in over ? over.dest : DEST,
    maxCents: over.maxCents ?? 500000,
  };
  const pub = (r: Row): PublicRow => ({
    id: r.id, status: r.status, bolt11: r.bolt11, amount_usd: r.amount_usd, amount_sats: Number(BigInt(r.amount_msat) / 1000n),
    expires_at: r.expires_at, merchant_name: "Alice", link_slug: "alice-pay", destination_address: r.destination_address,
    paid_at: r.paid_at, preimage: r.preimage, payment_hash: r.payment_hash,
  });
  const direct = (r: Row): DirectRow => ({ ...r });
  let raceWinner: Row | null = null;
  const db: Db = {
    paymentsStopped: () => Promise.resolve(env.stopped),
    directEnabled: () => Promise.resolve(env.enabled),
    claimPublic: () => Promise.resolve(true),
    linkForSlug: () => Promise.resolve(env.link),
    profileMaxCents: () => Promise.resolve(env.maxCents),
    claimOwnerRate: () => Promise.resolve(true),
    releaseOwnerRate: () => { calls.release++; return Promise.resolve(); },
    destinationFor: () => Promise.resolve(env.dest),
    findByRequest: (linkId, requestId) => {
      const r = [...rows.values()].find((x) => x.payment_link_id === linkId && x.client_request_id === requestId) ?? raceWinner;
      return Promise.resolve(r ? direct(r) : null);
    },
    insert: (row) => {
      if (raceWinner) return Promise.resolve("request_conflict" as const);
      const id = crypto.randomUUID();
      rows.set(id, { ...row, id, status: "pending", preimage: null, paid_at: null });
      return Promise.resolve({ id });
    },
    publicRow: (id) => Promise.resolve(rows.has(id) ? pub(rows.get(id)!) : null),
    claimCheck: (id) => {
      calls.claims++;
      const r = rows.get(id);
      return Promise.resolve(r && r.status !== "paid" && claimAllowed ? direct(r) : null);
    },
    claimChecks: () => Promise.resolve([...rows.values()].filter((r) => r.status !== "paid").map(direct)),
    recordProof: async (id, preimage) => {
      const r = rows.get(id)!;
      const { sha256HexBytes, hexToBytes } = await import("../_shared/bolt11.ts");
      if ((await sha256HexBytes(hexToBytes(preimage))) !== r.payment_hash) throw new Error("check_violation");
      r.status = "paid"; r.preimage = preimage; r.paid_at = new Date(NOW).toISOString();
      return "paid";
    },
    expire: (id) => { const r = rows.get(id)!; if (r.status === "pending") r.status = "expired"; return Promise.resolve(r.status); },
  };
  const provider: SettlementProvider = {
    kind: "lightning_address",
    checkDestination: () => Promise.reject(new Error("unused")),
    async createInvoice(address, amountMsat) {
      calls.provider++;
      if (address === "broken@pay.example.com") throw new LnurlError("provider_error", "<b>internal provider text</b>");
      const { preimage, paymentHash } = await randomPreimage();
      preimages.set(paymentHash, preimage);
      const inv = buildInvoice({ amountMsat, paymentHash, timestamp: NOW / 1000, expirySeconds: 3600, descriptionHash: "ab".repeat(32) });
      return { invoice: decodeBolt11(inv), verifyUrl: `https://pay.example.com/verify/${paymentHash}`, payRequestDescription: "x" };
    },
    check(p) {
      calls.checks++;
      const v = verdicts.get(p.paymentHash) ?? { state: "not_paid" as const };
      return v === "throw" ? Promise.reject(new Error("down")) : Promise.resolve(v);
    },
  };
  let now = NOW;
  const handler = createHandler({
    db, provider, rate: () => Promise.resolve(RATE),
    turnstile: (token) => Promise.resolve(token === "bad" ? { ok: false } : { ok: true }),
    createAllowed: over.createAllowed ?? true,
    reconcileSecret: "s3cret", now: () => now, log: () => {},
  });
  const post = async (body: unknown, headers: Record<string, string> = {}) => {
    const res = await handler(new Request("https://fn/direct-invoice", { method: "POST", body: JSON.stringify(body), headers }));
    return { status: res.status, body: await res.json() };
  };
  return {
    rows, preimages, verdicts, calls, env, post, handler,
    setNow: (t: number) => { now = t; },
    denyClaims: () => { claimAllowed = false; },
    race: (r: Row) => { raceWinner = r; },
  };
}

Deno.test("CORS preflight and methods", async () => {
  const w = world();
  assertEquals((await w.handler(new Request("https://fn", { method: "OPTIONS" }))).status, 200);
  assertEquals((await w.handler(new Request("https://fn", { method: "GET" }))).status, 405);
  assertEquals((await w.handler(new Request("https://fn", { method: "POST", body: "{" }))).status, 400);
  assertEquals((await w.post({ action: "nope" })).status, 400);
});

Deno.test("create refuses while stopped, switched off, or unreadable", async () => {
  assertEquals((await world({ stopped: true }).post({ slug: "alice-pay", amount: 10 })).status, 503);
  assertEquals((await world({ stopped: undefined }).post({ slug: "alice-pay", amount: 10 })).status, 503);
  const off = await world({ enabled: false }).post({ slug: "alice-pay", amount: 10 });
  assertEquals([off.status, off.body.error], [503, "Direct payments are not available."]);
  assertEquals((await world({ enabled: undefined }).post({ slug: "alice-pay", amount: 10 })).status, 503);
});

Deno.test("create refuses while Turnstile is not enforced; status and reconcile still work", async () => {
  const w = world({ createAllowed: false });
  const r = await w.post({ slug: "alice-pay", amount: 10 });
  assertEquals([r.status, r.body.error], [503, "Direct payments are not available."]);
  assertEquals(w.rows.size, 0);
  assertEquals(w.calls.provider, 0);
  const rec = await w.post({ action: "reconcile" }, { "x-direct-reconcile-secret": "s3cret" });
  assertEquals(rec.status, 200);
});

Deno.test("create validates input, Turnstile and the link", async () => {
  const w = world();
  assertEquals((await w.post({ slug: "x", amount: 10 })).status, 400);
  assertEquals((await w.post({ slug: "alice-pay", amount: 0.5 })).status, 400);
  assertEquals((await w.post({ slug: "alice-pay", amount: 6000 })).status, 400);
  assertEquals((await w.post({ slug: "alice-pay", amount: 10, turnstileToken: "bad" })).status, 403);
  assertEquals((await world({ link: null }).post({ slug: "alice-pay", amount: 10 })).status, 404);
  assertEquals((await world({ link: { ...LINK, is_active: false } }).post({ slug: "alice-pay", amount: 10 })).status, 410);
  const custodial = await world({ link: { ...LINK, settlement_mode: "custodial" } }).post({ slug: "alice-pay", amount: 10 });
  assertEquals([custodial.status, custodial.body.code], [409, "custodial_link"]);
  assertEquals((await world({ maxCents: 1000 }).post({ slug: "alice-pay", amount: 10 })).status, 400); // 10 + 10 % = 11 > 10
  assertEquals(w.calls.provider, 0);
});

Deno.test("no ready address: refused before the provider, owner slot released", async () => {
  const w = world({ dest: null });
  const r = await w.post({ slug: "alice-pay", amount: 10 });
  assertEquals([r.status, r.body.error], [409, "This merchant is not taking payments right now."]);
  assertEquals([w.calls.provider, w.calls.release], [0, 1]);
});

Deno.test("provider failure: 502, provider text never shown, nothing recorded", async () => {
  const w = world({ dest: { ...DEST, address: "broken@pay.example.com" } });
  const r = await w.post({ slug: "alice-pay", amount: 10 });
  assertEquals(r.status, 502);
  assert(!JSON.stringify(r.body).includes("internal provider text"));
  assertEquals([w.rows.size, w.calls.release], [0, 1]);
});

Deno.test("create: the merchant's invoice, priced with markup, recorded once per request id", async () => {
  const w = world();
  const requestId = "44444444-4444-4444-8444-444444444444";
  const r = await w.post({ slug: "alice-pay", amount: "20", requestId });
  assertEquals(r.status, 200);
  assertEquals(r.body.settlement, "direct");
  assertEquals(r.body.amountRequested, 22); // $20 + 10 %
  assertEquals(r.body.destination, DEST.address);
  const row = w.rows.get(r.body.paymentId)!;
  assertEquals(row.amount_msat, "22000000"); // $22 at $100k = 22 000 sat
  assertEquals(row.buyer_amount, "20.00");
  assertEquals(row.amount_usd, "22.00");
  assertEquals(row.expires_at, new Date(NOW + 3600_000).toISOString());
  assertEquals(decodeBolt11(r.body.payCode).amountMsat, 22_000_000n);
  // Same attempt again: the same payment, no second provider call.
  const again = await w.post({ slug: "alice-pay", amount: "20", requestId });
  assertEquals([again.status, again.body.paymentId, w.calls.provider], [200, r.body.paymentId, 1]);
  assertEquals((await w.post({ slug: "alice-pay", amount: "25", requestId })).status, 409);
  w.setNow(NOW + 3600_000);
  assertEquals((await w.post({ slug: "alice-pay", amount: "20", requestId })).status, 409);
});

Deno.test("create: a concurrent request with the same id wins; this one returns it", async () => {
  const w = world();
  const first = await w.post({ slug: "alice-pay", amount: 10, requestId: "55555555-5555-4555-8555-555555555555" });
  const winner = w.rows.get(first.body.paymentId)!;
  const w2 = world();
  w2.race({ ...winner, client_request_id: "66666666-6666-4666-8666-666666666666" });
  const r = await w2.post({ slug: "alice-pay", amount: 10, requestId: "66666666-6666-4666-8666-666666666666" });
  assertEquals([r.status, r.body.paymentId], [200, winner.id]);
});

Deno.test("status: paid only with proof; unproven and errors stay open; claims bound provider calls", async () => {
  const w = world();
  const c = await w.post({ slug: "alice-pay", amount: 10 });
  const id = c.body.paymentId;
  const hash = w.rows.get(id)!.payment_hash;
  assertEquals((await w.post({ action: "status", id: "not-a-uuid" })).status, 404);
  assertEquals((await w.post({ action: "status", id: crypto.randomUUID() })).status, 404);
  let s = await w.post({ action: "status", id });
  assertEquals([s.status, s.body.status, s.body.proof], [200, "new", null]);
  w.verdicts.set(hash, { state: "unproven", reason: "x" });
  assertEquals((await w.post({ action: "status", id })).body.status, "new");
  w.verdicts.set(hash, "throw");
  assertEquals((await w.post({ action: "status", id })).body.status, "new");
  w.verdicts.set(hash, { state: "paid", preimage: w.preimages.get(hash)! });
  s = await w.post({ action: "status", id });
  assertEquals([s.body.status, s.body.proof, s.body.paymentHash], ["settled", w.preimages.get(hash), hash]);
  const checks = w.calls.checks;
  await w.post({ action: "status", id });
  assertEquals(w.calls.checks, checks); // paid: no more provider calls
  const w2 = world();
  const c2 = await w2.post({ slug: "alice-pay", amount: 10 });
  w2.denyClaims();
  await w2.post({ action: "status", id: c2.body.paymentId });
  assertEquals(w2.calls.checks, 0); // another poller holds the check slot
});

Deno.test("status: expires only after expiry plus grace; a late proof still counts", async () => {
  const w = world();
  const id = (await w.post({ slug: "alice-pay", amount: 10 })).body.paymentId;
  const hash = w.rows.get(id)!.payment_hash;
  w.setNow(NOW + 3600_000 + 60_000);
  assertEquals((await w.post({ action: "status", id })).body.status, "new");
  w.setNow(NOW + 3600_000 + 11 * 60_000);
  assertEquals((await w.post({ action: "status", id })).body.status, "expired");
  w.verdicts.set(hash, { state: "paid", preimage: w.preimages.get(hash)! });
  assertEquals((await w.post({ action: "status", id })).body.status, "settled");
});

Deno.test("reconcile: secret required; checks open payments", async () => {
  const w = world();
  const id = (await w.post({ slug: "alice-pay", amount: 10 })).body.paymentId;
  const hash = w.rows.get(id)!.payment_hash;
  assertEquals((await w.post({ action: "reconcile" })).status, 403);
  assertEquals((await w.post({ action: "reconcile" }, { "x-direct-reconcile-secret": "wrong" })).status, 403);
  w.verdicts.set(hash, { state: "paid", preimage: w.preimages.get(hash)! });
  const r = await w.post({ action: "reconcile" }, { "x-direct-reconcile-secret": "s3cret" });
  assertEquals([r.status, r.body], [200, { checked: 1, paid: 1, expired: 0 }]);
  const unset = createHandler({
    db: {} as Db, provider: {} as SettlementProvider, rate: () => Promise.reject(new Error()), turnstile: () => Promise.resolve({ ok: true }), createAllowed: true, reconcileSecret: "",
  });
  assertEquals((await unset(new Request("https://fn", { method: "POST", body: JSON.stringify({ action: "reconcile" }) }))).status, 503);
});
