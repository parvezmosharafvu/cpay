// Multi-wallet e2e with fake wallets and a fake Postgres: routing to the
// primary, per-wallet single-instance leases, receive-only sync of other
// active wallets, primary switch, and the pre-migration fallback.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createHost, LEGACY_WALLET_ID, lockSql } from "./runtime.ts";
import { createWalletManager, type WalletRow } from "./multi.ts";
import { signRequest } from "./core/auth.mjs";
import { fakeBreez } from "./core/fake-breez.mjs";
import { Buffer } from "node:buffer";

const SECRET = "s".repeat(40);
const W2 = "22222222-2222-4222-8222-222222222222";
const W3 = "33333333-3333-4333-8333-333333333333";

function fakePg(reg: WalletRow[] | null) {
  const state = {
    reg, locks: new Map<string, number>(), leases: [] as Array<{ wallet: string | null; role: string | null }>,
    status: new Map<string, { pub: string | null; bal: string | null }>(), settles: [] as string[], nonces: new Set<string>(),
    tryLockSql: new Set<string>(),
  };
  let next = 1;
  const query = (who: number) => async (sql: string, params: unknown[] = []) => {
    if (sql.includes("wallets_to_run()")) {
      if (!state.reg) { const e = new Error("function does not exist") as Error & { code: string }; e.code = "42883"; throw e; }
      return { rows: state.reg };
    }
    if (sql.includes("from breez_wallet.control")) return { rows: [{ enabled: true, owner: "supabase-edge" }] };
    if (sql.includes("claim_nonce")) { const n = String(params[0]); if (state.nonces.has(n)) return { rows: [{ ok: false }] }; state.nonces.add(n); return { rows: [{ ok: true }] }; }
    const lk = /pg_try_advisory_lock\((.+)\) as ok/.exec(sql);
    if (lk) {
      state.tryLockSql.add(lk[1]);
      const h = state.locks.get(lk[1]);
      if (h === undefined || h === who) { state.locks.set(lk[1], who); return { rows: [{ ok: true }] }; }
      return { rows: [{ ok: false }] };
    }
    const ul = /pg_advisory_unlock\((.+)\)$/.exec(sql);
    if (ul) { if (state.locks.get(ul[1]) === who) state.locks.delete(ul[1]); return { rows: [{ ok: true }] }; }
    if (sql.includes("insert into breez_wallet.lease_log")) {
      state.leases.push({ wallet: (params[1] as string) ?? null, role: (params[2] as string) ?? null });
      return { rows: [{ id: state.leases.length }] };
    }
    if (sql.includes("wallet_record_status")) {
      state.status.set(String(params[0]), { pub: (params[1] as string) ?? null, bal: (params[2] as string) ?? null });
      return { rows: [{ ok: true }] };
    }
    if (sql.includes("as since")) return { rows: [{ since: 1 }] };
    if (sql.includes("settle_breez_payment")) { state.settles.push(String(params[1])); return { rows: [{ outcome: "settled" }] }; }
    return { rows: [], rowCount: 0 };
  };
  const db = { query: query(0), connect: async () => ({ query: query(0), release() {} }) };
  // each host's lockClient is its own "connection"
  const lockClient = async () => { const id = next++; return { query: query(id), release() {} }; };
  return { state, db, lockClient };
}

function setup(reg: WalletRow[] | null) {
  const pg = fakePg(reg);
  const sdks = new Map<string, ReturnType<typeof fakeBreez>>();
  const made: Array<{ wallet: string | null; role: string }> = [];
  let t = 1_800_000_000_000;
  const m = createWalletManager({
    db: pg.db, network: "mainnet", log: () => {},
    makeHost: (wallet, role) => {
      made.push({ wallet: wallet?.id ?? null, role });
      return createHost({
        db: pg.db, lockClient: pg.lockClient, wallet: wallet ?? undefined, role,
        connectSdk: async () => {
          const key = wallet?.id ?? "single";
          const sdk = sdks.get(key) ?? fakeBreez();
          // each wallet its own node key and its own received payment
          // deno-lint-ignore no-explicit-any
          (sdk as any).getInfo = async () => ({ balanceSats: 1000, identityPubkey: "02" + key.replace(/-/g, "").padEnd(64, "0").slice(0, 64) });
          // deno-lint-ignore no-explicit-any
          (sdk as any).listPayments = async () => ({ payments: [{ id: `p-${key}`, paymentType: "receive", status: "completed", amount: 10n, details: { type: "lightning", htlcDetails: { paymentHash: `hash-${key}` } } }] });
          sdks.set(key, sdk);
          return sdk;
        },
        secret: SECRET, adminJwtMode: "required", supabaseUrl: "https://x.supabase.co", anonKey: "anon",
        log: () => {}, verifyAdminToken: async () => null, now: () => t, sleep: async (ms) => { t += ms; },
      });
    },
  });
  return { m, pg, made };
}

let n = 0;
function signed(method: string, path: string) {
  const ts = String(1_800_000_000_000);
  const nonce = `nonce_mw_${String(++n).padStart(12, "0")}`;
  return new Headers({ "x-cpay-timestamp": ts, "x-cpay-nonce": nonce, "x-cpay-signature": signRequest({ secret: SECRET, ts, nonce, method, path, body: Buffer.from("") }) });
}
const row = (id: string, o: Partial<WalletRow> = {}): WalletRow => ({ id, is_legacy: id === LEGACY_WALLET_ID, is_primary: false, status: "active", network: "mainnet", ...o });

Deno.test("lock keys: legacy keeps the original key, others are per wallet", () => {
  assertEquals(lockSql().tryLock, "select pg_try_advisory_lock(breez_wallet.lock_key()) as ok");
  assertEquals(lockSql({ id: LEGACY_WALLET_ID, legacy: true }).tryLock, lockSql().tryLock);
  const a = lockSql({ id: W2, legacy: false }), b = lockSql({ id: W3, legacy: false });
  assert(a.tryLock !== b.tryLock && a.want !== b.want && a.tryLock.includes(W2));
  assert(a.abandon.endsWith(`and wallet_id = '${W2}'`));
});

Deno.test("before the migration: one host, original lease, no wallet id", async () => {
  const { m, pg, made } = setup(null);
  const res = await m.serve("GET", "/metrics", signed("GET", "/metrics"), new Uint8Array());
  assertEquals(res.status, 200);
  assertEquals(made, [{ wallet: null, role: "primary" }]);
  assertEquals([...pg.state.tryLockSql], ["breez_wallet.lock_key()"]);
  assertEquals(pg.state.leases[0], { wallet: null, role: null });
  await m.closeAll();
});

Deno.test("requests go to the primary; sync runs the primary then other active wallets receive-only", async () => {
  const { m, pg, made } = setup([row(LEGACY_WALLET_ID), row(W2, { is_primary: true }), row(W3, { status: "standby" })]);
  const res = await m.serve("GET", "/metrics", signed("GET", "/metrics"), new Uint8Array());
  assertEquals(res.status, 200);
  assertEquals(made, [{ wallet: W2, role: "primary" }]);
  const s = await m.sync();
  const body = await s.json();
  assertEquals(s.status, 200);
  assertEquals(body.wallets.map((w: { id: string; role: string }) => [w.id, w.role]), [[W2, "primary"], [LEGACY_WALLET_ID, "receiver"]]);
  // the receiver settled its own payment and let go of its lease
  assert(pg.state.settles.includes(`hash-${LEGACY_WALLET_ID}`));
  assert(!pg.state.locks.has("breez_wallet.lock_key()"));
  // standby wallet never opened
  assert(!made.some((x) => x.wallet === W3));
  // per-wallet lease rows and status
  assert(pg.state.leases.some((l) => l.wallet === W2 && l.role === "primary"));
  assert(pg.state.leases.some((l) => l.wallet === LEGACY_WALLET_ID && l.role === "receiver"));
  assertEquals(pg.state.status.get(W2)?.bal, "1000");
  await m.sync(); // a second tick reuses the warm primary
  assertEquals(made.filter((x) => x.wallet === W2).length, 1);
  await m.closeAll();
});

Deno.test("single instance per wallet: a second isolate gets 'wallet busy' for the same wallet only", async () => {
  const reg = [row(LEGACY_WALLET_ID, { is_primary: true }), row(W2)];
  const a = setup(reg);
  await a.m.serve("GET", "/metrics", signed("GET", "/metrics"), new Uint8Array()); // holds wallet #1 warm
  // second isolate on the same fake Postgres
  const b = createWalletManager({
    db: a.pg.db, network: "mainnet", log: () => {},
    makeHost: (wallet, role) => createHost({
      db: a.pg.db, lockClient: a.pg.lockClient, wallet: wallet ?? undefined, role,
      connectSdk: async () => fakeBreez(), secret: SECRET, adminJwtMode: "required", supabaseUrl: "https://x", anonKey: "a",
      log: () => {}, verifyAdminToken: async () => null, now: () => 1_800_000_000_000, sleep: async () => {},
    }),
  });
  const s = await b.sync();
  const body = await s.json();
  // wallet #1 is busy elsewhere: skipped, not opened twice; wallet 2 synced fine
  assertEquals(body.wallets[0].body, { ok: true, skipped: "busy" });
  assertEquals(body.wallets[1].status, 200);
  await a.m.closeAll();
  await b.closeAll();
});

Deno.test("switching the primary closes the old primary session", async () => {
  const reg = [row(LEGACY_WALLET_ID, { is_primary: true }), row(W2)];
  const { m, pg } = setup(reg);
  await m.serve("GET", "/metrics", signed("GET", "/metrics"), new Uint8Array());
  assert(pg.state.locks.has("breez_wallet.lock_key()"));
  pg.state.reg = [row(LEGACY_WALLET_ID), row(W2, { is_primary: true })];
  await m.serve("GET", "/metrics", signed("GET", "/metrics"), new Uint8Array());
  assert(!pg.state.locks.has("breez_wallet.lock_key()"));
  assertEquals([...pg.state.locks.keys()].length, 1);
  await m.closeAll();
});

Deno.test("no active primary: 503, nothing opened; receivers refuse requests", async () => {
  const { m, made } = setup([row(W2, { is_primary: true, network: "regtest" })]);
  const res = await m.serve("GET", "/metrics", signed("GET", "/metrics"), new Uint8Array());
  assertEquals(res.status, 503);
  assertEquals(made.length, 0);
  const pg = fakePg([]);
  const h = createHost({ db: pg.db, lockClient: pg.lockClient, wallet: { id: W2, legacy: false }, role: "receiver",
    connectSdk: async () => fakeBreez(), secret: SECRET, adminJwtMode: "required", supabaseUrl: "https://x", anonKey: "a",
    log: () => {}, verifyAdminToken: async () => null, now: () => 1_800_000_000_000 });
  assertEquals((await h.serve("GET", "/metrics", signed("GET", "/metrics"), new Uint8Array())).status, 503);
});
