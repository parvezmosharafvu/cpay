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
  type Session = { client: Any; sdk: Any; app: Any; leaseId: number; requests: number; full: boolean };
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
      while (!locked) {
        const { rows } = await client.query("select pg_try_advisory_lock(breez_wallet.lock_key()) as ok");
        locked = rows[0]?.ok === true;
        if (!locked) {
          if (now() >= deadline) throw new WalletUnavailable(503, "wallet busy");
          await sleep(250);
        }
      }
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
      return { client, sdk, app, leaseId: Number(rows[0].id), requests: 0, full };
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
    // Concurrent callers share one open. A request that joined the cron's
    // no-wait open must not fail fast with "wallet busy": retry with its own wait.
    const joined = opening !== null;
    opening ??= open(lockWaitMs, full).finally(() => { opening = null; });
    let s: Session;
    try { s = await opening; }
    catch (e) {
      if (joined && lockWaitMs > 0 && e instanceof WalletUnavailable && e.message === "wallet busy") {
        return acquire(lockWaitMs, full);
      }
      throw e;
    }
    session = s;
    return s;
  }

  function scheduleIdle() {
    clearTimeout(idleTimer);
    if (!session) return;
    idleTimer = setTimeout(() => { if (!busy) void close("idle"); }, WALLET_IDLE_MS);
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
    busy++;
    try {
      const s = await acquire();
      s.requests++;
      const { res, done } = captureResponse();
      await s.app.handle(toNodeRequest(method, path, headers, body), res);
      return await done;
    } catch (e) {
      if (e instanceof WalletUnavailable) return json(e.status, { error: e.message });
      deps.log({ event: "request-failed", path, error: String((e as Error)?.message ?? e).slice(0, 300) });
      return json(500, { error: "internal error" });
    } finally {
      busy--;
      if (!busy) scheduleIdle();
    }
  }

  // Cron: incoming payments, expiry, withdrawal reconcile. A cold tick opens
  // full (ensureSynced + catchUp); otherwise it runs catchUp on the session.
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
      // A fresh full open already synced. A warm session, or a light one a
      // request was opening when this tick joined it, has not: catch up now.
      if (warm || !s.full) await s.app.catchUp();
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
