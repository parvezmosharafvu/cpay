// Handoff between isolates (#56): a waiting request takes the shared "want"
// lock and an idle warm holder closes for it; the cron never asks for it.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createHost } from "./runtime.ts";
import { signRequest } from "./core/auth.mjs";
import { fakeBreez } from "./core/fake-breez.mjs";
import { Buffer } from "node:buffer";

const SECRET = "s".repeat(40);
const realSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fake Postgres with the exclusive wallet lock, shared "want" locks per
// connection and the pg_locks lookup the idle holder polls.
function fakePg() {
  const state = {
    nonces: new Set<string>(), lockHolder: null as null | number, wants: new Set<number>(),
    maxWants: 0, leases: 0, wantedDelayMs: 0,
  };
  let next = 1;
  const query = (who: number) => async (sql: string, params: unknown[] = []) => {
    if (sql.includes("from breez_wallet.control")) return { rows: [{ enabled: true, owner: "supabase-edge" }] };
    if (sql.includes("claim_nonce")) {
      const n = String(params[0]);
      if (state.nonces.has(n)) return { rows: [{ ok: false }] };
      state.nonces.add(n); return { rows: [{ ok: true }] };
    }
    if (sql.includes("pg_advisory_lock_shared")) { state.wants.add(who); state.maxWants = Math.max(state.maxWants, state.wants.size); return { rows: [{}] }; }
    if (sql.includes("pg_advisory_unlock_shared")) { state.wants.delete(who); return { rows: [{ ok: true }] }; }
    if (sql.includes("from pg_locks")) {
      if (state.wantedDelayMs) await realSleep(state.wantedDelayMs);
      return { rows: [{ w: [...state.wants].some((w) => w !== who) }] };
    }
    if (sql.includes("pg_try_advisory_lock")) {
      if (state.lockHolder === null || state.lockHolder === who) { state.lockHolder = who; return { rows: [{ ok: true }] }; }
      return { rows: [{ ok: false }] };
    }
    if (sql.includes("pg_advisory_unlock")) { if (state.lockHolder === who) state.lockHolder = null; return { rows: [{ ok: true }] }; }
    if (sql.includes("insert into breez_wallet.lease_log")) { state.leases++; return { rows: [{ id: state.leases }] }; }
    if (sql.includes("as since")) return { rows: [{ since: null }] };
    return { rows: [], rowCount: 0 };
  };
  const db = { query: query(0), connect: async () => ({ query: query(0), release() {} }) };
  const lockClient = async () => { const id = next++; return { query: query(id), release() { state.wants.delete(id); } }; };
  return { state, db, lockClient };
}

// sleepMode "instant" advances the fake clock only; "real" also yields for a
// few real ms so the other host's idle poll (real setTimeout) can run.
function host(pg: ReturnType<typeof fakePg>, sleepMode: "instant" | "real" = "instant") {
  const clock = { t: 1_800_000_000_000 };
  const h = createHost({
    db: pg.db, lockClient: pg.lockClient, connectSdk: async () => fakeBreez(),
    secret: SECRET, adminJwtMode: "required", supabaseUrl: "https://x.supabase.co", anonKey: "anon",
    log: () => {}, verifyAdminToken: async () => null,
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; if (sleepMode === "real") await realSleep(5); },
  });
  return { h, clock };
}

let n = 0;
function get(h: ReturnType<typeof createHost>, path = "/metrics") {
  const ts = String(1_800_000_000_000);
  const nonce = `handoff_${String(++n).padStart(12, "0")}`;
  const headers = new Headers({
    "x-cpay-timestamp": ts, "x-cpay-nonce": nonce,
    "x-cpay-signature": signRequest({ secret: SECRET, ts, nonce, method: "GET", path, body: Buffer.from("") }),
  });
  return h.serve("GET", path, headers, new Uint8Array());
}

Deno.test("idle warm holder hands the wallet to a waiting isolate (no 20 s wait, no 503)", async () => {
  const pg = fakePg();
  const a = host(pg);
  const b = host(pg, "real");
  assertEquals((await get(a.h)).status, 200);
  assert(a.h.holding);
  const start = b.clock.t;
  const res = await get(b.h);
  assertEquals(res.status, 200);
  assert(b.clock.t - start < 20_000, "B got the wallet before its lock wait ran out");
  await a.h.idle();
  assert(!a.h.holding);
  assert(b.h.holding);
  assertEquals(pg.state.wants.size, 0, "B drops its want lock once it holds the wallet");
  await b.h.close("test");
});

Deno.test("cron (lock wait 0) never asks a warm holder to hand over", async () => {
  const pg = fakePg();
  const a = host(pg);
  const b = host(pg, "real");
  assertEquals((await get(a.h)).status, 200);
  const res = await b.h.sync();
  assertEquals(await res.json(), { ok: true, skipped: "busy" });
  await realSleep(450);
  assert(a.h.holding, "A stays warm");
  assertEquals(pg.state.maxWants, 0);
  await a.h.close("test");
});

Deno.test("a waiter that times out drops its want lock", async () => {
  const pg = fakePg();
  const a = host(pg);
  const b = host(pg); // instant sleep: runs out its 20 s before A's first poll
  assertEquals((await get(a.h)).status, 200);
  const res = await get(b.h);
  assertEquals(res.status, 503);
  assertEquals(pg.state.maxWants, 1);
  assertEquals(pg.state.wants.size, 0);
  await a.h.close("test");
});

Deno.test("a poll still in flight when a new request starts does not close the new warm window early", async () => {
  const pg = fakePg();
  const a = host(pg);
  assertEquals((await get(a.h)).status, 200); // idle window 1: until t0 + 45 s
  pg.state.wantedDelayMs = 300;
  await realSleep(260); // first poll is now waiting on its WANTED query
  a.clock.t += 30_000;
  assertEquals((await get(a.h)).status, 200); // idle window 2: until t0 + 75 s
  a.clock.t += 20_000; // past window 1, inside window 2
  pg.state.wantedDelayMs = 0;
  await realSleep(700);
  assert(a.h.holding, "the older poll chain must not close the session at window 1's deadline");
  await a.h.close("test");
});
