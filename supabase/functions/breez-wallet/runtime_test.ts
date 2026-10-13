import { assert, assertEquals } from "jsr:@std/assert@1";
import { createHost } from "./runtime.ts";
import { signRequest } from "./core/auth.mjs";
import { fakeBreez } from "./core/fake-breez.mjs";
import { Buffer } from "node:buffer";

const SECRET = "s".repeat(40);

// A shared fake Postgres: the control row, the nonce table and one advisory lock.
function fakePg({ enabled = true } = {}) {
  const state = { enabled, owner: "supabase-edge", nonces: new Set<string>(), lockHolder: null as null | number, locks: 0, leases: 0, cache: new Map<string, { body: string; ageMs: number }>(), cacheWrites: 0 };
  let next = 1;
  const query = (who: number) => async (sql: string, params: unknown[] = []) => {
    if (sql.includes("from breez_wallet.control")) return { rows: [{ enabled: state.enabled, owner: state.owner }] };
    if (sql.includes("claim_nonce")) {
      const n = String(params[0]);
      if (state.nonces.has(n)) return { rows: [{ ok: false }] };
      state.nonces.add(n); return { rows: [{ ok: true }] };
    }
    if (sql.includes("pg_try_advisory_lock")) {
      if (state.lockHolder === null || state.lockHolder === who) { state.lockHolder = who; state.locks++; return { rows: [{ ok: true }] }; }
      return { rows: [{ ok: false }] };
    }
    if (sql.includes("pg_advisory_unlock")) { if (state.lockHolder === who) state.lockHolder = null; return { rows: [{ ok: true }] }; }
    if (sql.includes("insert into breez_wallet.lease_log")) { state.leases++; return { rows: [{ id: state.leases }] }; }
    if (sql.includes("as since")) return { rows: [{ since: null }] };
    // response_cache: ageMs per key stands in for now() - updated_at.
    if (sql.includes("from breez_wallet.response_cache where key = $1")) {
      const e = state.cache.get(String(params[0]));
      if (!e || e.ageMs > Number(params[2] ?? params[1])) return { rows: [] };
      return { rows: [{ status: 200, body: e.body, fresh: e.ageMs <= Number(params[1]) }] };
    }
    if (sql.includes("from breez_wallet.response_cache where key = any")) {
      const keys = params[0] as string[];
      return { rows: [{ n: keys.filter((k) => (state.cache.get(k)?.ageMs ?? Infinity) <= Number(params[1])).length }] };
    }
    if (sql.includes("insert into breez_wallet.response_cache")) { state.cache.set(String(params[0]), { body: String(params[1]), ageMs: 0 }); state.cacheWrites++; return { rows: [] }; }
    return { rows: [], rowCount: 0 };
  };
  const db = { query: query(0), connect: async () => ({ query: query(0), release() {} }) };
  const lockClient = async () => { const id = next++; return { query: query(id), release() {} }; };
  return { state, db, lockClient };
}

function host(pgf: ReturnType<typeof fakePg>, sdk = fakeBreez(), extra = {}) {
  let connects = 0;
  let t = 1_800_000_000_000;
  const h = createHost({
    db: pgf.db, lockClient: pgf.lockClient,
    connectSdk: async () => { connects++; return sdk; },
    secret: SECRET, adminJwtMode: "required", supabaseUrl: "https://x.supabase.co", anonKey: "anon",
    log: (e: unknown) => { if (Deno.env.get("DBG")) console.error(JSON.stringify(e)); }, verifyAdminToken: async () => null,
    now: () => t, sleep: async (ms) => { t += ms; }, ...extra,
  });
  return { h, connects: () => connects, sdk };
}

let n = 0;
function signed(method: string, path: string, body = "") {
  const ts = String(1_800_000_000_000);
  const nonce = `nonce_${String(++n).padStart(12, "0")}`;
  const headers = new Headers({
    "x-cpay-timestamp": ts, "x-cpay-nonce": nonce,
    "x-cpay-signature": signRequest({ secret: SECRET, ts, nonce, method, path, body: Buffer.from(body) }),
  });
  return { headers, body: new TextEncoder().encode(body) };
}

Deno.test("disabled: 503 and the wallet is never connected", async () => {
  const pg = fakePg({ enabled: false });
  const { h, connects } = host(pg);
  const r = signed("GET", "/metrics");
  const res = await h.serve("GET", "/metrics", r.headers, r.body);
  assertEquals(res.status, 503);
  assertEquals(connects(), 0);
  assertEquals(pg.state.locks, 0);
});

Deno.test("unsigned or bad signature: 401 without touching the wallet", async () => {
  const pg = fakePg();
  const { h, connects } = host(pg);
  const res = await h.serve("GET", "/metrics", new Headers({ authorization: `Bearer ${SECRET}` }), new Uint8Array());
  assertEquals(res.status, 401);
  const r = signed("GET", "/metrics");
  r.headers.set("x-cpay-signature", "v1=" + "0".repeat(64));
  assertEquals((await h.serve("GET", "/metrics", r.headers, r.body)).status, 401);
  assertEquals(connects(), 0);
});

Deno.test("signed request is served by the same app; replayed nonce is refused across isolates", async () => {
  const pg = fakePg();
  const a = host(pg);
  const r = signed("GET", "/metrics");
  const res = await a.h.serve("GET", "/metrics", r.headers, r.body);
  assertEquals(res.status, 200);
  const m = await res.json();
  assertEquals(m.requestAuthMode, "signed");
  assertEquals(m.adminJwtMode, "required");
  assertEquals(m.singleWallet, true);
  await a.h.close("test");
  const b = host(pg);
  assertEquals((await b.h.serve("GET", "/metrics", r.headers, r.body)).status, 401);
});

Deno.test("only one instance holds the wallet; the other gets 503 'wallet busy'", async () => {
  const pg = fakePg();
  const a = host(pg);
  const b = host(pg);
  const r1 = signed("GET", "/metrics");
  assertEquals((await a.h.serve("GET", "/metrics", r1.headers, r1.body)).status, 200);
  assert(a.h.holding);
  const r2 = signed("GET", "/metrics");
  const res = await b.h.serve("GET", "/metrics", r2.headers, r2.body);
  assertEquals(res.status, 503);
  assertEquals((await res.json()).error, "wallet busy");
  assertEquals(b.connects(), 0);
  await a.h.close("test");
  assertEquals(pg.state.lockHolder, null);
  assertEquals(a.sdk.calls.disconnect, 1);
  const r3 = signed("GET", "/metrics");
  assertEquals((await b.h.serve("GET", "/metrics", r3.headers, r3.body)).status, 200);
  await b.h.close("test");
});

Deno.test("admin wallet routes need a verified admin token (ADMIN_JWT_MODE=required)", async () => {
  const pg = fakePg();
  const { h } = host(pg);
  const body = JSON.stringify({ adminId: crypto.randomUUID(), amountUsd: "1.00", address: "x" });
  const r = signed("POST", "/admin/wallet/send", body);
  const res = await h.serve("POST", "/admin/wallet/send", r.headers, r.body);
  assertEquals(res.status, 401);
  await h.close("test");
});

Deno.test("health never takes the lease", async () => {
  const pg = fakePg();
  const { h, connects } = host(pg);
  assertEquals((await h.serve("GET", "/health", new Headers(), new Uint8Array())).status, 200);
  assertEquals(connects(), 0);
});

Deno.test("core/ matches payment-service byte for byte", async () => {
  for (const m of ["app", "ledger", "receipts", "withdraw", "wallet", "auth", "money", "fake-breez"]) {
    const a = await Deno.readTextFile(new URL(`./core/${m}.mjs`, import.meta.url));
    const b = await Deno.readTextFile(new URL(`../../../payment-service/${m}.mjs`, import.meta.url));
    assertEquals(a, b, `${m}.mjs drifted; run scripts/sync-breez-core.sh`);
  }
});

// Records getInfo({ ensureSynced }) so tests can tell a light open from a full one.
function recordingSdk() {
  const ensureSynced: unknown[] = [];
  const sdk = Object.assign(fakeBreez(), { ensureSynced });
  const getInfo = sdk.getInfo.bind(sdk);
  // deno-lint-ignore no-explicit-any
  (sdk as any).getInfo = async (o?: { ensureSynced?: boolean }) => { ensureSynced.push(o?.ensureSynced); return await getInfo(); };
  return sdk;
}

async function catchUps(h: ReturnType<typeof host>["h"]): Promise<number> {
  const r = signed("GET", "/metrics");
  return (await (await h.serve("GET", "/metrics", r.headers, r.body)).json()).catchUps;
}

Deno.test("requests open light (no ensureSynced); a cold cron tick opens full", async () => {
  const pg = fakePg();
  const sdkA = recordingSdk();
  const a = host(pg, sdkA);
  const r = signed("GET", "/metrics");
  assertEquals((await a.h.serve("GET", "/metrics", r.headers, r.body)).status, 200);
  assertEquals(sdkA.ensureSynced[0], false);
  await a.h.close("test");
  const sdkB = recordingSdk();
  const b = host(pg, sdkB);
  assertEquals((await b.h.sync()).status, 200);
  assertEquals(sdkB.ensureSynced[0], true);
  await b.h.close("test");
});

Deno.test("cron tick skips (200 skipped:busy) instead of queueing behind another holder", async () => {
  const pg = fakePg();
  const a = host(pg);
  const b = host(pg);
  const r = signed("GET", "/metrics");
  assertEquals((await a.h.serve("GET", "/metrics", r.headers, r.body)).status, 200);
  const res = await b.h.sync();
  assertEquals(res.status, 200);
  assertEquals((await res.json()).skipped, "busy");
  assertEquals(b.connects(), 0);
  await a.h.close("test");
});

Deno.test("a warm lease closes and answers 503 when the off switch flips (request and cron)", async () => {
  const pg = fakePg();
  const a = host(pg);
  const r1 = signed("GET", "/metrics");
  assertEquals((await a.h.serve("GET", "/metrics", r1.headers, r1.body)).status, 200);
  assert(a.h.holding);
  pg.state.enabled = false;
  const r2 = signed("GET", "/metrics");
  assertEquals((await a.h.serve("GET", "/metrics", r2.headers, r2.body)).status, 503);
  assert(!a.h.holding);
  assertEquals(pg.state.lockHolder, null);
  assertEquals(a.sdk.calls.disconnect, 1);
  pg.state.enabled = true;
  assertEquals((await a.h.sync()).status, 200);
  pg.state.enabled = false;
  assertEquals((await a.h.sync()).status, 503);
  assert(!a.h.holding);
  assertEquals(pg.state.lockHolder, null);
});

Deno.test("a cron tick that joins a request's light open still catches up", async () => {
  const pg = fakePg();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let entered!: () => void;
  const inOpen = new Promise<void>((r) => { entered = r; });
  const sdk = fakeBreez();
  const a = host(pg, sdk, { connectSdk: async () => { entered(); await gate; return sdk; } });
  const r = signed("GET", "/metrics");
  const req = a.h.serve("GET", "/metrics", r.headers, r.body);
  await inOpen; // the request is mid-open (light)
  const tick = a.h.sync();
  release();
  assertEquals((await req).status, 200);
  assertEquals((await tick).status, 200);
  assertEquals(await catchUps(a.h), 1);
  await a.h.close("test");
});

Deno.test("a request that joins a cron tick's no-wait open waits its own LOCK_WAIT_MS", async () => {
  const pg = fakePg();
  const a = host(pg);
  const r1 = signed("GET", "/metrics");
  assertEquals((await a.h.serve("GET", "/metrics", r1.headers, r1.body)).status, 200); // a holds the wallet
  let t = 1_800_000_000_000;
  let tries = 0;
  const b = host(pg, fakeBreez(), {
    now: () => t,
    sleep: async (ms: number) => { t += ms; tries++; if (tries === 4) await a.h.close("test"); },
  });
  const tick = b.h.sync(); // opens with no wait: busy
  const r2 = signed("GET", "/metrics");
  const req = b.h.serve("GET", "/metrics", r2.headers, r2.body); // joins, then retries with its own wait
  assertEquals((await (await tick).json()).skipped, "busy");
  assertEquals((await req).status, 200);
  await b.h.close("test");
});

// The SDK's own pg pool outlived disconnect() by recycleTimeoutSecs, so quick
// handoffs ran the session pooler out of clients (EMAXCONNSESSION).
Deno.test("closing a lease ends the SDK's pg pool before the lock is released", async () => {
  const pg = fakePg();
  const order: string[] = [];
  const sdk = fakeBreez();
  const a = host(pg, sdk, {
    releaseSdk: async () => { order.push(`release:lock=${pg.state.lockHolder !== null}`); },
  });
  const r = signed("GET", "/metrics");
  assertEquals((await a.h.serve("GET", "/metrics", r.headers, r.body)).status, 200);
  await a.h.close("handoff");
  assertEquals(sdk.calls.disconnect, 1);
  assertEquals(order, ["release:lock=true"]);
  assertEquals(pg.state.lockHolder, null);
});

Deno.test("a failed open disconnects the half-open SDK and ends its pool before unlocking", async () => {
  const pg = fakePg();
  const order: string[] = [];
  const sdk = fakeBreez();
  sdk.getInfo = async () => { throw new Error("Failed to initialize PostgreSQL database: (EMAXCONNSESSION)"); };
  const disconnect = sdk.disconnect.bind(sdk);
  sdk.disconnect = async () => { order.push(`disconnect:lock=${pg.state.lockHolder !== null}`); await disconnect(); };
  const a = host(pg, sdk, {
    releaseSdk: async () => { order.push(`release:lock=${pg.state.lockHolder !== null}`); },
  });
  const r = signed("GET", "/metrics");
  assertEquals((await a.h.serve("GET", "/metrics", r.headers, r.body)).status, 500);
  assertEquals(order, ["disconnect:lock=true", "release:lock=true"]);
  assertEquals(pg.state.lockHolder, null);
  assertEquals(a.h.holding, false);
});

Deno.test("an SDK build that fails still ends whatever pool it made; a throwing release never keeps the lock", async () => {
  const pg = fakePg();
  let released = 0;
  const a = host(pg, fakeBreez(), {
    connectSdk: async () => { throw new Error("max clients reached in session mode"); },
    releaseSdk: async () => { released++; throw new Error("pool end failed"); },
  });
  const r = signed("GET", "/metrics");
  assertEquals((await a.h.serve("GET", "/metrics", r.headers, r.body)).status, 500);
  assertEquals(released, 1);
  assertEquals(pg.state.lockHolder, null);
});

// Routes catalog: served from the shared cache past its TTL (stale) instead of
// queueing behind the lease; never replaced by an empty list; the cron tick
// refreshes it.
const GOOD = JSON.stringify({ routes: [{ id: "orchestra:arbitrum:usdt", asset: "USDT", chain: "arbitrum" }], cache: {} });

Deno.test("routes: a stale cached catalog is served while another instance holds the wallet", async () => {
  const pg = fakePg();
  const a = host(pg);
  const b = host(pg);
  const r1 = signed("GET", "/metrics");
  assertEquals((await a.h.serve("GET", "/metrics", r1.headers, r1.body)).status, 200); // a holds the lease
  pg.state.cache.set("/withdraw/routes", { body: GOOD, ageMs: 3 * 60 * 60_000 }); // 3 h old, past the 10 min TTL
  const r2 = signed("GET", "/withdraw/routes");
  const res = await b.h.serve("GET", "/withdraw/routes", r2.headers, r2.body);
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("x-cpay-cache"), "stale");
  assertEquals((await res.json()).routes.length, 1);
  assertEquals(b.connects(), 0, "no lease needed");
  // older than a day: not served, the live path answers (here: busy)
  pg.state.cache.set("/withdraw/routes", { body: GOOD, ageMs: 25 * 60 * 60_000 });
  const r3 = signed("GET", "/withdraw/routes");
  assertEquals((await b.h.serve("GET", "/withdraw/routes", r3.headers, r3.body)).status, 503);
  await a.h.close("test");
});

Deno.test("routes: an empty live list is returned but never cached over a good one", async () => {
  const pg = fakePg();
  const sdk = fakeBreez();
  sdk.getCrossChainRoutes = async () => [];
  pg.state.cache.set("/withdraw/routes", { body: GOOD, ageMs: 60 * 60_000 }); // stale but good
  pg.state.cache.set("/admin/wallet/stable-routes", { body: GOOD, ageMs: 60 * 60_000 });
  const { h } = host(pg, sdk);
  await h.sync(); // the cron tick must not overwrite with an empty list
  assertEquals(pg.state.cache.get("/withdraw/routes")?.body, GOOD);
  pg.state.cache.delete("/withdraw/routes");
  const r = signed("GET", "/withdraw/routes");
  const res = await h.serve("GET", "/withdraw/routes", r.headers, r.body);
  assertEquals(res.status, 200);
  assertEquals((await res.json()).routes.length, 0);
  assertEquals(pg.state.cache.has("/withdraw/routes"), false, "empty list not cached");
  await h.close("test");
});

Deno.test("routes: the cron tick refreshes a catalog past half its TTL, for both keys", async () => {
  const pg = fakePg();
  const sdk = fakeBreez();
  let calls = 0;
  sdk.getCrossChainRoutes = async (req: unknown) => {
    calls++;
    const fam = (req as { addressDetails: { addressFamily: string } }).addressDetails.addressFamily;
    return fam === "evm" ? [{ provider: "orchestra", chain: "arbitrum", asset: "USDT", decimals: 6, exactOutEligible: true, deliveryMethods: ["spark"],
      acceptedAssets: [{ asset: { type: "bitcoin" }, limits: { minUsdCents: 100, maxUsdCents: 1_000_000 } }] }] : [];
  };
  const c = host(pg, sdk);
  assertEquals((await c.h.sync()).status, 200);
  const w = pg.state.cache.get("/withdraw/routes");
  const s = pg.state.cache.get("/admin/wallet/stable-routes");
  assert(w && s, "both keys written");
  assert(JSON.parse(w.body).routes.length > 0);
  assertEquals(w.body, s.body);
  // fresh now: the next tick does not call the provider again
  const before = calls;
  assertEquals((await c.h.sync()).status, 200);
  assertEquals(calls, before);
  await c.h.close("test");
});
