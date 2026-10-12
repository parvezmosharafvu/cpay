import { assert, assertEquals } from "jsr:@std/assert@1";
import { createHost } from "./runtime.ts";
import { signRequest } from "./core/auth.mjs";
import { fakeBreez } from "./core/fake-breez.mjs";
import { Buffer } from "node:buffer";

const SECRET = "s".repeat(40);

// A shared fake Postgres: the control row, the nonce table and one advisory lock.
function fakePg({ enabled = true } = {}) {
  const state = { enabled, owner: "supabase-edge", nonces: new Set<string>(), lockHolder: null as null | number, locks: 0, leases: 0, outcomes: [] as string[] };
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
    if (sql.includes("update breez_wallet.lease_log")) { state.outcomes.push(String(params[2])); return { rows: [], rowCount: 1 }; }
    if (sql.includes("as since")) return { rows: [{ since: null }] };
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

Deno.test("switch turned off while a lease is held: 503 and the lease is released", async () => {
  const pg = fakePg();
  const a = host(pg);
  const r1 = signed("GET", "/metrics");
  assertEquals((await a.h.serve("GET", "/metrics", r1.headers, r1.body)).status, 200);
  assert(a.h.holding);
  pg.state.enabled = false; // rollback step 2, while requests keep arriving
  const r2 = signed("GET", "/metrics");
  const res = await a.h.serve("GET", "/metrics", r2.headers, r2.body);
  assertEquals(res.status, 503);
  assertEquals((await res.json()).error, "wallet is not enabled on supabase");
  await a.h.idle();
  assert(!a.h.holding);
  assertEquals(pg.state.lockHolder, null);
  assertEquals(a.sdk.calls.disconnect, 1);
  const r3 = signed("GET", "/metrics");
  assertEquals((await a.h.serve("GET", "/metrics", r3.headers, r3.body)).status, 503);
  assertEquals(a.connects(), 1);
});

Deno.test("SDK connect fails: 500, lock released, lease row closed as open-failed", async () => {
  const pg = fakePg();
  const sdk = fakeBreez();
  const a = host(pg, sdk, { connectSdk: async () => { throw new Error("connect failed"); } });
  const r = signed("GET", "/metrics");
  assertEquals((await a.h.serve("GET", "/metrics", r.headers, r.body)).status, 500);
  assert(!a.h.holding);
  assertEquals(pg.state.lockHolder, null);
  assertEquals(pg.state.outcomes, ["open-failed"]);
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
