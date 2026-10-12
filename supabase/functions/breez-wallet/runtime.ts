// One wallet, one holder. An isolate that wants the wallet takes a
// session-level Postgres advisory lock on a dedicated connection, connects
// the SDK (state in the breez_wallet schema), serves requests while busy,
// and after WALLET_IDLE_MS drains, disconnects and unlocks. If the isolate
// is killed, its connection drops and Postgres frees the lock, so a dead
// instance can never hold the wallet. Every other isolate waits for the
// lock (up to LOCK_WAIT_MS) and then answers 503.
import { Buffer } from "node:buffer";
import { createApp as createAppJs } from "./core/app.mjs";
const createApp = createAppJs as (o: Any) => Any;
import { createAdminTokenVerifier, signRequest } from "./core/auth.mjs";
import { captureResponse, toNodeRequest } from "./node-shim.ts";

(globalThis as Record<string, unknown>).Buffer ??= Buffer;

export const LOCK_WAIT_MS = 20_000;
// Stay warm between admin clicks and the 1-minute sync cron: a cold lease
// costs an SDK build + connect (seconds), so idle close only after 45 s.
export const WALLET_IDLE_MS = 45_000;
export const HANDOFF_POLL_MS = 200;
const WANT_LOCK = "select pg_advisory_lock_shared(73501, 2)";
const WANT_UNLOCK = "select pg_advisory_unlock_shared(73501, 2)";
const WANTED = "select exists(select 1 from pg_locks where locktype = 'advisory' and classid = 73501 and objid = 2 and granted and pid <> pg_backend_pid()) as w";
// Read-only responses served from breez_wallet.response_cache when fresh,
// so they need no wallet lease (ms instead of a lease handoff). Writes to the
// wallet invalidate the balance entry.
export const CACHE_TTL_MS: Record<string, number> = {
  "/admin/wallet/info": 120_000, // invalidated by wallet writes; incoming payments show within 2 min
  "/admin/wallet/fiat": 10 * 60_000,
  "/admin/wallet/stable-routes": 10 * 60_000,
  "/withdraw/routes": 10 * 60_000,
};
const INVALIDATES_INFO = new Set(["/admin/wallet/receive", "/admin/wallet/send-confirm", "/admin/wallet/stable-confirm", "/withdraw/confirm", "/invoices"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const TS = /^\d{12,14}$/;

// deno-lint-ignore no-explicit-any
type Any = any;

export type HostDeps = {
  db: Any;                       // pg.Pool for the ledger (same role as the VM's DATABASE_URL)
  lockClient: () => Promise<Any>; // a dedicated pg client (session mode, NOT the transaction pooler)
  connectSdk: () => Promise<Any>; // builds + connects the Breez SDK with postgres storage
  secret: string;
  adminJwtMode: "optional" | "required";
  supabaseUrl: string;
  anonKey: string;
  log: (e: Record<string, unknown>) => void;
  redact?: (s: string) => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  holder?: string;
  verifyAdminToken?: (t: string) => Promise<string | null>;
};

export class WalletUnavailable extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}

export function createHost(deps: HostDeps) {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const holder = deps.holder ?? `edge-${crypto.randomUUID()}`;
  type Session = { client: Any; sdk: Any; app: Any; leaseId: number; requests: number };
  let session: Session | null = null;
  let opening: Promise<Session> | null = null;
  let busy = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<void> | null = null;

  async function enabled(): Promise<boolean> {
    const { rows } = await deps.db.query("select enabled, owner from breez_wallet.control where id");
    return Boolean(rows[0]?.enabled) && rows[0]?.owner === "supabase-edge";
  }

  // full=true (cron): ensureSynced + catchUp. Requests only need a connected
  // SDK; the cron does the heavy sync, so a cold admin request stays fast.
  async function open(lockWaitMs: number, full: boolean): Promise<Session> {
    if (!(await enabled())) throw new WalletUnavailable(503, "wallet is not enabled on supabase");
    const client = await deps.lockClient();
    let locked = false;
    let leaseId: number | null = null;
    try {
      const deadline = now() + lockWaitMs;
      // A waiting request announces itself with a shared "want" lock so an
      // idle warm holder in another isolate hands the wallet over at once
      // instead of keeping it for the whole idle window.
      let wanting = false;
      while (!locked) {
        const { rows } = await client.query("select pg_try_advisory_lock(breez_wallet.lock_key()) as ok");
        locked = rows[0]?.ok === true;
        if (!locked) {
          if (now() >= deadline) {
            if (wanting) await client.query(WANT_UNLOCK).catch(() => {});
            throw new WalletUnavailable(503, "wallet busy");
          }
          if (!wanting && lockWaitMs > 0) { await client.query(WANT_LOCK).catch(() => {}); wanting = true; }
          await sleep(150);
        }
      }
      if (wanting) await client.query(WANT_UNLOCK).catch(() => {});
      // Re-check after the lock: the owner may have switched back meanwhile.
      if (!(await enabled())) throw new WalletUnavailable(503, "wallet is not enabled on supabase");
      const { rows } = await client.query(
        "insert into breez_wallet.lease_log (holder) values ($1) returning id", [holder]);
      leaseId = Number(rows[0].id);
      const sdk = await deps.connectSdk();
      const verifyAdminToken = deps.verifyAdminToken ??
        createAdminTokenVerifier({ supabaseUrl: deps.supabaseUrl, anonKey: deps.anonKey });
      const app = createApp({
        sdk, db: deps.db, secret: deps.secret, log: deps.log, now,
        receiptRecording: "off", recordDb: null,
        requestAuthMode: "signed", adminJwtMode: deps.adminJwtMode, verifyAdminToken,
      });
      await sdk.addEventListener({ onEvent: app.onEvent });
      await sdk.getInfo({ ensureSynced: full });
      app.markSynced();
      if (full) await app.catchUp();
      app.markReady();
      deps.log({ event: "wallet-lease-acquired", holder });
      return { client, sdk, app, leaseId: Number(rows[0].id), requests: 0 };
    } catch (e) {
      // Edge function logs are not always queryable: keep a short, redacted
      // reason on the lease row (no secrets: deps.redact strips them).
      if (leaseId !== null) {
        const why = (deps.redact ?? ((x: string) => x))(String((e as Error)?.message ?? e)).slice(0, 300);
        await client.query("update breez_wallet.lease_log set released_at = now(), outcome = $2 where id = $1",
          [leaseId, `open-failed: ${why}`]).catch(() => {});
      }
      if (locked) await client.query("select pg_advisory_unlock(breez_wallet.lock_key())").catch(() => {});
      client.release?.(true);
      throw e;
    }
  }

  async function acquire(lockWaitMs = LOCK_WAIT_MS, full = false): Promise<Session> {
    if (closing) await closing;
    clearTimeout(idleTimer);
    if (session) return session;
    opening ??= open(lockWaitMs, full).finally(() => { opening = null; });
    const s = await opening;
    session = s;
    return s;
  }

  // Idle: keep the wallet warm up to WALLET_IDLE_MS, but hand it over as
  // soon as another isolate is waiting for it.
  function scheduleIdle() {
    clearTimeout(idleTimer);
    if (!session) return;
    const until = now() + WALLET_IDLE_MS;
    const tick = async () => {
      if (!session || busy || closing) return;
      if (now() >= until) return void close("idle");
      const wanted = await session.client.query(WANTED).then((r: Any) => r.rows?.[0]?.w === true, () => false);
      if (wanted && session && !busy) return void close("handoff");
      idleTimer = setTimeout(tick, HANDOFF_POLL_MS);
    };
    idleTimer = setTimeout(tick, HANDOFF_POLL_MS);
  }

  async function close(outcome: string): Promise<void> {
    if (!session || closing) return closing ?? undefined;
    const s = session;
    clearTimeout(idleTimer);
    closing = (async () => {
      const { drained } = await s.app.drain(90_000);
      let disconnected = true;
      try { await s.sdk.disconnect(); } catch { disconnected = false; }
      await s.client.query(
        "update breez_wallet.lease_log set released_at = now(), requests = $2, outcome = $3 where id = $1",
        [s.leaseId, s.requests, `${outcome}${drained ? "" : ",undrained"}${disconnected ? "" : ",disconnect-failed"}`],
      ).catch(() => {});
      await s.client.query("select pg_advisory_unlock(breez_wallet.lock_key())").catch(() => {});
      s.client.release?.(true);
      session = null;
      deps.log({ event: "wallet-lease-released", holder, outcome, drained, disconnected });
    })().finally(() => { closing = null; });
    return closing;
  }

  // Replay protection shared by all isolates: the signature is checked here
  // first (so junk cannot fill the table), then the nonce is claimed in
  // Postgres. app.mjs checks the signature again with its own nonce set.
  async function claimSignedNonce(method: string, path: string, headers: Headers, body: Uint8Array): Promise<boolean> {
    const ts = headers.get("x-cpay-timestamp") ?? "";
    const nonce = headers.get("x-cpay-nonce") ?? "";
    const sig = headers.get("x-cpay-signature") ?? "";
    if (!TS.test(ts) || !NONCE.test(nonce) || !/^v1=[0-9a-f]{64}$/.test(sig)) return false;
    if (Math.abs(now() - Number(ts)) > SIGNATURE_WINDOW_MS) return false;
    const expected = signRequest({ secret: deps.secret, ts, nonce, method, path, body: Buffer.from(body) });
    if (expected.length !== sig.length) return false;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
    if (diff) return false;
    const { rows } = await deps.db.query("select breez_wallet.claim_nonce($1, $2) as ok",
      [nonce, new Date(Number(ts) + SIGNATURE_WINDOW_MS + 1000).toISOString()]);
    return rows[0]?.ok === true;
  }

  // A cache hit still needs the same caller checks as the live route:
  // signed request (done by the caller), and for /admin/wallet/* a POST with a
  // verified admin session token whose user is an active admin.
  let tokenVerifier: ((t: string) => Promise<string | null>) | null = null;
  async function cached(key: string, ttl: number, method: string, headers: Headers, body: Uint8Array): Promise<Response | null> {
    if (key.startsWith("/admin/wallet/")) {
      if (method !== "POST") return null;
      tokenVerifier ??= deps.verifyAdminToken ?? createAdminTokenVerifier({ supabaseUrl: deps.supabaseUrl, anonKey: deps.anonKey });
      const token = headers.get("x-cpay-admin-token");
      let adminId: string | null = token ? await tokenVerifier(token) : null;
      if (!adminId && deps.adminJwtMode === "optional") {
        try { adminId = String(JSON.parse(new TextDecoder().decode(body))?.adminId ?? ""); } catch { adminId = null; }
      }
      if (!adminId || !UUID_RE.test(adminId)) return null; // live path answers 401/403
      const { rows } = await deps.db.query("select role, account_status from profiles where id = $1", [adminId]);
      if (rows[0]?.role !== "admin" || rows[0]?.account_status !== "active") return null;
    } else if (method !== "GET") return null;
    const { rows } = await deps.db.query(
      "select status, body from breez_wallet.response_cache where key = $1 and updated_at > now() - make_interval(secs => $2::float8 / 1000)", [key, ttl]);
    if (!rows[0]) return null;
    return new Response(rows[0].body, { status: rows[0].status, headers: { "content-type": "application/json", "x-cpay-cache": "hit" } });
  }

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  // path is the payment-service path (/invoices, /admin/wallet/send, ...).
  async function serve(method: string, path: string, headers: Headers, body: Uint8Array): Promise<Response> {
    if (path === "/health" || path === "/ready") {
      // Unauthenticated and cheap: never takes the wallet lease.
      const on = await enabled().catch(() => false);
      return json(on ? 200 : 503, { ok: on, enabled: on, holder: session ? "this-instance" : null });
    }
    if (!(await claimSignedNonce(method, path, headers, body))) return json(401, { error: "unauthorized" });
    // A warm lease obeys the off switch too (rollback safety).
    if (session && !(await enabled().catch(() => false))) {
      await close("disabled");
      return json(503, { error: "wallet is not enabled on supabase" });
    }
    const cacheKey = path.split("?")[0];
    const ttl = CACHE_TTL_MS[cacheKey];
    if (ttl) {
      const hit = await cached(cacheKey, ttl, method, headers, body).catch(() => null);
      if (hit) return hit;
    }
    busy++;
    try {
      const s = await acquire();
      s.requests++;
      const { res, done } = captureResponse();
      await s.app.handle(toNodeRequest(method, path, headers, body), res);
      const out = await done;
      if (ttl && out.status === 200) {
        const text = await out.clone().text();
        await deps.db.query(
          "insert into breez_wallet.response_cache (key, status, body, updated_at) values ($1, 200, $2, now()) on conflict (key) do update set status = 200, body = excluded.body, updated_at = now()",
          [cacheKey, text]).catch(() => {});
      } else if (INVALIDATES_INFO.has(cacheKey)) {
        await deps.db.query("delete from breez_wallet.response_cache where key = '/admin/wallet/info'").catch(() => {});
      }
      return out;
    } catch (e) {
      if (e instanceof WalletUnavailable) return json(e.status, { error: e.message });
      deps.log({ event: "request-failed", path, error: String((e as Error)?.message ?? e).slice(0, 300) });
      return json(500, { error: "internal error" });
    } finally {
      busy--;
      if (!busy) scheduleIdle();
    }
  }

  // Cron: incoming payments, expiry, withdrawal reconcile (app.catchUp runs
  // on every acquire; run it once more so a warm session also syncs).
  async function sync(): Promise<Response> {
    busy++;
    try {
      if (session && !(await enabled().catch(() => false))) {
        await close("disabled");
        return json(503, { error: "wallet is not enabled on supabase" });
      }
      // Never queue behind another holder: if the wallet is busy elsewhere,
      // skip this tick (that holder syncs, and the next tick retries).
      const warm = Boolean(session);
      let s: Session;
      try { s = await acquire(0, true); }
      catch (e) {
        if (e instanceof WalletUnavailable && e.message === "wallet busy") return json(200, { ok: true, skipped: "busy" });
        throw e;
      }
      if (warm) await s.app.catchUp();
      return json(200, { ok: true });
    } catch (e) {
      if (e instanceof WalletUnavailable) return json(e.status, { error: e.message });
      deps.log({ event: "sync-failed", error: String((e as Error)?.message ?? e).slice(0, 300) });
      return json(500, { error: "sync failed" });
    } finally {
      busy--;
      if (!busy) scheduleIdle();
    }
  }

  return { serve, sync, close, get holding() { return Boolean(session); }, idle: () => closing ?? Promise.resolve() };
}
