// Blink sweep rules (docs/BLINK-SWEEP.md). Wiring is in index.ts; this file
// has no Deno or network globals so handler_test.ts can drive it.
//
// One run (pg_cron, every 10 minutes):
//   1. A sweep still in flight (sending/pending) is finished first by paying
//      its stored invoice again: Blink answers ALREADY_PAID for a paid one,
//      so this can never pay twice. Nothing new starts while one is open.
//   2. Off, no Blink key, or no Lightning address on the primary CPAY
//      wallet: nothing happens.
//   3. Move = USD balance − "keep", capped at "largest move"; below
//      "smallest move" nothing happens.
//   4. The invoice comes from the primary CPAY wallet's own Lightning
//      address (read from the database, never typed in), is checked
//      (network, exact amount, description hash, expiry), recorded, then
//      paid from the Blink USD wallet.
import { parseLightningAddress } from "../_shared/lnurl.ts";
import type { Bolt11 } from "../_shared/bolt11.ts";
import type { PayStatus } from "../_shared/blink.ts";
import { secretMatches } from "../_shared/secret-compare.ts";

export type SweepConfig = { enabled: boolean; keepCents: number; minCents: number; maxCents: number; destination: string | null };
export type OpenSweep = { id: string; walletId: string; bolt11: string; expiresAtMs: number; amountCents: number; destination: string };
export type SweepStatus = "sent" | "pending" | "failed" | "unknown";
export type Begin = {
  amountCents: number; amountSat: number; destination: string; walletId: string;
  bolt11: string; paymentHash: string; expiresAtMs: number;
};

export type Deps = {
  cronSecret: string;
  configured: boolean;
  config(): Promise<SweepConfig>;
  open(): Promise<OpenSweep | null>;
  usdWallet(): Promise<{ id: string; balanceCents: number }>;
  usdToSats(cents: number): Promise<number>;
  invoice(address: string, amountMsat: bigint): Promise<Bolt11>;
  begin(row: Begin): Promise<string | null>;
  finish(id: string, status: SweepStatus, error: string | null): Promise<void>;
  pay(walletId: string, bolt11: string): Promise<{ status: PayStatus; error: string | null }>;
  alert(text: string): Promise<void>;
  now(): number;
};

/** Sats asked for are 98% of Blink's estimate: room for price moves and Blink's fee. */
export const SAT_MARGIN = 0.98;
/** An in-flight sweep whose invoice expired this long ago is closed as "unknown". */
export const STALE_AFTER_MS = 60 * 60_000;

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export function outcome(s: PayStatus): SweepStatus {
  return s === "SUCCESS" || s === "ALREADY_PAID" ? "sent" : s === "PENDING" ? "pending" : "failed";
}

/** How much to move now, in cents (0 = nothing). */
export function moveCents(balanceCents: number, c: Pick<SweepConfig, "keepCents" | "minCents" | "maxCents">): number {
  const amount = Math.min(balanceCents - c.keepCents, c.maxCents);
  return amount >= Math.max(c.minCents, 1) ? amount : 0;
}

async function safeAlert(d: Deps, text: string) {
  try { await d.alert(text); } catch (e) { console.error("alert failed:", e instanceof Error ? e.message : e); }
}

async function resolveOpen(d: Deps, row: OpenSweep) {
  const stale = d.now() > row.expiresAtMs + STALE_AFTER_MS;
  let r: { status: PayStatus; error: string | null };
  try {
    r = await d.pay(row.walletId, row.bolt11);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!stale) return { resolved: row.id, status: "open", error: msg };
    await d.finish(row.id, "unknown", msg);
    await safeAlert(d, `⚠ Blink → CPAY move of ${usd(row.amountCents)} could not be confirmed (${msg}). Check Blink and the CPAY wallet.`);
    return { resolved: row.id, status: "unknown" };
  }
  const s = outcome(r.status);
  if (s === "pending") {
    if (!stale) return { resolved: row.id, status: "pending" };
    await d.finish(row.id, "unknown", "still pending after the invoice expired");
    await safeAlert(d, `⚠ Blink → CPAY move of ${usd(row.amountCents)} is still pending after its invoice expired. Check Blink.`);
    return { resolved: row.id, status: "unknown" };
  }
  await d.finish(row.id, s, r.error);
  await safeAlert(d, s === "sent"
    ? `✅ Blink → CPAY: ${usd(row.amountCents)} arrived at ${row.destination}.`
    : `⚠ Blink → CPAY move of ${usd(row.amountCents)} failed: ${r.error}`);
  return { resolved: row.id, status: s };
}

export async function run(d: Deps): Promise<Record<string, unknown>> {
  const cfg = await d.config();
  const open = await d.open();
  if (open) {
    // Switched off while one was in flight: leave it for the next run after
    // it is switched back on, or for the owner to check in Blink.
    if (!cfg.enabled) return { skipped: "off", open: open.id };
    return await resolveOpen(d, open);
  }
  if (!cfg.enabled) return { skipped: "off" };
  const addr = parseLightningAddress(cfg.destination);
  if (!addr) return { skipped: "no_destination" };

  const wallet = await d.usdWallet();
  const cents = moveCents(wallet.balanceCents, cfg);
  if (!cents) return { skipped: "below_minimum", balanceCents: wallet.balanceCents };

  const sats = Math.floor((await d.usdToSats(cents)) * SAT_MARGIN);
  if (sats < 1) return { skipped: "too_small" };
  const inv = await d.invoice(addr.address, BigInt(sats) * 1000n);

  const id = await d.begin({
    amountCents: cents, amountSat: sats, destination: addr.address, walletId: wallet.id,
    bolt11: inv.invoice, paymentHash: inv.paymentHash, expiresAtMs: inv.expiresAtMs,
  });
  if (!id) return { skipped: "busy" };

  let r: { status: PayStatus; error: string | null };
  try {
    r = await d.pay(wallet.id, inv.invoice);
  } catch (e) {
    // Left "sending": the next run pays the same invoice again (safe).
    return { id, status: "sending", error: e instanceof Error ? e.message : String(e) };
  }
  const s = outcome(r.status);
  await d.finish(id, s, r.error);
  if (s === "sent") await safeAlert(d, `✅ Blink → CPAY: moved ${usd(cents)} (${sats.toLocaleString("en-US")} sats) to ${addr.address}.`);
  if (s === "failed") await safeAlert(d, `⚠ Blink → CPAY move of ${usd(cents)} failed: ${r.error}`);
  return { id, status: s, amountCents: cents, amountSat: sats };
}

export function createHandler(d: Deps) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return json(405, { error: "method not allowed" });
    if (!d.cronSecret || !secretMatches(req.headers.get("x-cron-secret"), d.cronSecret)) return json(401, { error: "unauthorized" });
    if (!d.configured) return json(200, { skipped: "not_configured" });
    try {
      return json(200, await run(d));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("blink sweep failed:", msg);
      return json(502, { error: msg.slice(0, 200) });
    }
  };
}
