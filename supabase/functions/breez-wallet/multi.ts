// Multi-wallet manager (20261021030000). One host (runtime.ts) per wallet.
//
// Routing rule (docs/MULTI-WALLET.md):
//   * every signed request (/invoices, /withdraw/*, /admin/wallet/*) goes to
//     the PRIMARY wallet, so new invoices, forwards and withdrawals all use
//     the primary;
//   * the cron tick syncs the primary in full, then each other ACTIVE
//     wallet receive-only (short lease, closed right after);
//   * standby and disabled wallets are never opened.
// Before the migration (no registry) it behaves exactly like the single
// wallet: one host with the original lease keys and the Edge secret seed.
import { createHost, WalletUnavailable } from "./runtime.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
type Host = ReturnType<typeof createHost>;
export type WalletRow = { id: string; is_legacy: boolean; is_primary: boolean; status: string; network: string };
export type Role = "primary" | "receiver";

const MISSING = new Set(["42883", "42P01", "3F000"]); // function / table / schema not there yet

export function createWalletManager(opts: {
  db: Any;
  network: string;
  log: (e: Record<string, unknown>) => void;
  makeHost: (wallet: { id: string; legacy: boolean } | null, role: Role) => Host;
}) {
  const hosts = new Map<string, { host: Host; role: Role }>();
  let single: Host | null = null;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  async function registry(): Promise<WalletRow[] | null> {
    try {
      const { rows } = await opts.db.query("select id, is_legacy, is_primary, status, network from breez_wallet.wallets_to_run()");
      return rows as WalletRow[];
    } catch (e) {
      if (MISSING.has(String((e as Any)?.code ?? ""))) return null;
      throw e;
    }
  }

  async function hostFor(w: WalletRow, role: Role): Promise<Host> {
    // The pre-registry host uses the same lock as wallet #1: let it go first.
    if (single) { await single.close("registry"); single = null; }
    const e = hosts.get(w.id);
    if (e && e.role === role) return e.host;
    if (e) { await e.host.close("role-change"); hosts.delete(w.id); }
    const host = opts.makeHost({ id: w.id, legacy: w.is_legacy }, role);
    hosts.set(w.id, { host, role });
    return host;
  }

  async function closeOthers(primaryId: string | null) {
    for (const [id, e] of hosts) {
      if (id !== primaryId && e.role === "primary") { await e.host.close("not-primary"); hosts.delete(id); }
    }
  }

  function primaryOf(reg: WalletRow[]): WalletRow | null {
    return reg.find((w) => w.is_primary && w.status === "active" && w.network === opts.network) ?? null;
  }

  async function serve(method: string, path: string, headers: Headers, body: Uint8Array): Promise<Response> {
    const reg = await registry();
    if (!reg) return (single ??= opts.makeHost(null, "primary")).serve(method, path, headers, body);
    const p = primaryOf(reg);
    await closeOthers(p?.id ?? null);
    if (!p) {
      if (path === "/health" || path === "/ready") return json(503, { ok: false, enabled: false, holder: null });
      return json(503, { error: "no primary wallet" });
    }
    return (await hostFor(p, "primary")).serve(method, path, headers, body);
  }

  async function sync(): Promise<Response> {
    const reg = await registry();
    if (!reg) return (single ??= opts.makeHost(null, "primary")).sync();
    const p = primaryOf(reg);
    await closeOthers(p?.id ?? null);
    const wallets: Array<{ id: string; role: Role; status: number; body: unknown }> = [];
    let primaryRes: Response | null = null;
    if (p) {
      primaryRes = await (await hostFor(p, "primary")).sync();
      wallets.push({ id: p.id, role: "primary", status: primaryRes.status, body: await primaryRes.clone().json().catch(() => null) });
    }
    for (const w of reg) {
      if (w.is_primary || w.status !== "active") continue;
      if (w.network !== opts.network) { wallets.push({ id: w.id, role: "receiver", status: 409, body: { error: "network mismatch" } }); continue; }
      try {
        const h = await hostFor(w, "receiver");
        const r = await h.sync();
        wallets.push({ id: w.id, role: "receiver", status: r.status, body: await r.json().catch(() => null) });
        await h.close("receiver-done");
        hosts.delete(w.id);
      } catch (e) {
        const msg = e instanceof WalletUnavailable ? e.message : "sync failed";
        opts.log({ event: "receiver-sync-failed", wallet: w.id });
        wallets.push({ id: w.id, role: "receiver", status: 500, body: { error: msg } });
      }
    }
    const status = primaryRes ? primaryRes.status : 503;
    return json(status, { ok: status === 200, ...(p ? {} : { error: "no primary wallet" }), wallets });
  }

  async function idle() {
    await Promise.all([single?.idle(), ...[...hosts.values()].map((e) => e.host.idle())]);
  }

  async function closeAll(outcome = "shutdown") {
    await single?.close(outcome);
    single = null;
    for (const [id, e] of hosts) { await e.host.close(outcome); hosts.delete(id); }
  }

  return { serve, sync, idle, closeAll, registry, get hostCount() { return hosts.size + (single ? 1 : 0); } };
}
