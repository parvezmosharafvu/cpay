// Blink sweep rules (docs/BLINK-SWEEP.md). Wiring is in index.ts; this file
// has no Deno or network globals so handler_test.ts can drive it.
//
// One run (pg_cron, every 10 minutes) goes through every configured Blink
// account (BLINK_API_KEY, BLINK_API_KEY_2 … _10) in turn. For each one:
//   1. A sweep of that account still in flight (sending/pending) is finished
//      first by paying its stored invoice again: Blink answers ALREADY_PAID
//      for a paid one, so this can never pay twice. Nothing new starts for
//      that account while one is open.
//   2. The account is read (balance, send permission, Blink's 24-hour
//      withdrawal limit left) and noted for Admin → Settings, even while off.
//      Off, or no Lightning address on the primary CPAY wallet: nothing more.
//   3. A key without Blink's WRITE scope cannot send: recorded, skipped.
//   4. Move = USD balance − "keep", capped at "largest move" and at what
//      Blink still lets the account withdraw in its rolling 24 hours; below
//      "smallest move" nothing happens.
//   5. The invoice comes from the primary CPAY wallet's own Lightning
//      address (read from the database, never typed in), is checked
//      (network, exact amount, description hash, expiry), recorded, then
//      paid from that account's USD wallet.
// One account failing never stops the others.
//
// Receive switch (blink_receive_switch_enabled; the BTCPay key needs Modify
// store settings):
// BTCPay pays every invoice into one Blink account. When that account has
// less than "switch below" of Blink's 24-hour withdrawal limit left (less
// what it already holds), BTCPay's Lightning connection is pointed at the
// account that can send with the most limit left. At most one switch per 30
// minutes (recorded in blink_receive_switches first), then read back.
//
// Rescue (always, after a switch): BTCPay can miss payments to invoices that
// were open on the old account. For two days the old account is asked
// whether each such invoice was paid; when Blink shows it received, the
// payment is recorded exactly like the BTCPay webhook would.
import { parseLightningAddress } from "../_shared/lnurl.ts";
import { type Bolt11, decodeBolt11 } from "../_shared/bolt11.ts";
import type { PayStatus, UsdWallet } from "../_shared/blink.ts";
import { secretMatches } from "../_shared/secret-compare.ts";

export type SweepConfig = {
  enabled: boolean; receiveSwitch: boolean; switchBelowCents: number;
  keepCents: number; minCents: number; maxCents: number; destination: string | null;
};
/** Which account BTCPay pays into; account null = not one of CPAY's Blink accounts. */
export type Receiving = { account: string | null; keyKind: "receive" | "api" | null };
export type SwitchStatus = "done" | "failed" | "unknown";
export type RescueCandidate = { paymentId: string; bolt11: string; amountUsd: string; account: string };
export type OpenSweep = { id: string; account: string; walletId: string; bolt11: string; expiresAtMs: number; amountCents: number; destination: string };
export type SweepStatus = "sent" | "pending" | "failed" | "unknown";
export type Begin = {
  account: string; amountCents: number; amountSat: number; destination: string; walletId: string;
  bolt11: string; paymentHash: string; expiresAtMs: number;
};
export type AccountNote = { balanceCents: number | null; canSend: boolean | null; withdrawRemainingCents: number | null; result: string };
/** What a run read for each account. */
export type Seen = Map<string, { wallet: UsdWallet }>;

export type Deps = {
  cronSecret: string;
  /** Labels of the configured Blink accounts ("1", "2", …). */
  accounts: string[];
  config(): Promise<SweepConfig>;
  open(): Promise<OpenSweep[]>;
  usdWallet(account: string): Promise<UsdWallet>;
  usdToSats(account: string, cents: number): Promise<number>;
  invoice(address: string, amountMsat: bigint): Promise<Bolt11>;
  begin(row: Begin): Promise<string | null>;
  finish(id: string, status: SweepStatus, error: string | null): Promise<void>;
  pay(account: string, walletId: string, bolt11: string): Promise<{ status: PayStatus; error: string | null }>;
  note(account: string, n: AccountNote): Promise<void>;
  /** BTCPay is configured (BTCPAY_URL, BTCPAY_STORE_ID and a key). */
  canSwitch: boolean;
  /** Reads BTCPay's Lightning connection; usdWalletIds = each account's USD wallet id seen this run. */
  receiving(usdWalletIds: Map<string, string>): Promise<Receiving>;
  /** Points BTCPay at this account's USD wallet; returns the key kind it used. */
  switchTo(account: string, usdWalletId: string): Promise<"receive" | "api">;
  receiveNote(r: Receiving, result: string): Promise<void>;
  /** Records a switch; null = one was recorded in the last 30 minutes. */
  switchBegin(from: string | null, to: string): Promise<string | null>;
  switchFinish(id: string, status: SwitchStatus, error: string | null): Promise<void>;
  rescueCandidates(): Promise<RescueCandidate[]>;
  invoicePaid(account: string, paymentHash: string): Promise<boolean>;
  rescueSettle(paymentId: string, account: string, amountSat: number): Promise<string>;
  alert(text: string): Promise<void>;
  now(): number;
};

/** Sats asked for are 98% of Blink's estimate: room for price moves and Blink's fee. */
export const SAT_MARGIN = 0.98;
/** An in-flight sweep whose invoice expired this long ago is closed as "unknown". */
export const STALE_AFTER_MS = 60 * 60_000;

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const name = (account: string) => `Blink #${account}`;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export function outcome(s: PayStatus): SweepStatus {
  return s === "SUCCESS" || s === "ALREADY_PAID" ? "sent" : s === "PENDING" ? "pending" : "failed";
}

/** How much to move now, in cents (0 = nothing). remaining = Blink's withdrawal limit left (null = none). */
export function moveCents(balanceCents: number, c: Pick<SweepConfig, "keepCents" | "minCents" | "maxCents">, remaining: number | null = null): number {
  const amount = Math.min(balanceCents - c.keepCents, c.maxCents, remaining ?? Infinity);
  return amount >= Math.max(c.minCents, 1) ? amount : 0;
}

async function safeAlert(d: Deps, text: string) {
  try { await d.alert(text); } catch (e) { console.error("alert failed:", errText(e)); }
}
async function safeNote(d: Deps, account: string, n: AccountNote) {
  try { await d.note(account, n); } catch (e) { console.error("note failed:", errText(e)); }
}

async function resolveOpen(d: Deps, row: OpenSweep) {
  const stale = d.now() > row.expiresAtMs + STALE_AFTER_MS;
  const who = name(row.account);
  let r: { status: PayStatus; error: string | null };
  try {
    r = await d.pay(row.account, row.walletId, row.bolt11);
  } catch (e) {
    const msg = errText(e);
    if (!stale) return { resolved: row.id, status: "open", error: msg };
    await d.finish(row.id, "unknown", msg);
    await safeAlert(d, `⚠ ${who} → CPAY move of ${usd(row.amountCents)} could not be confirmed (${msg}). Check Blink and the CPAY wallet.`);
    return { resolved: row.id, status: "unknown" };
  }
  const s = outcome(r.status);
  if (s === "pending") {
    if (!stale) return { resolved: row.id, status: "pending" };
    await d.finish(row.id, "unknown", "still pending after the invoice expired");
    await safeAlert(d, `⚠ ${who} → CPAY move of ${usd(row.amountCents)} is still pending after its invoice expired. Check Blink.`);
    return { resolved: row.id, status: "unknown" };
  }
  await d.finish(row.id, s, r.error);
  await safeAlert(d, s === "sent"
    ? `✅ ${who} → CPAY: ${usd(row.amountCents)} arrived at ${row.destination}.`
    : `⚠ ${who} → CPAY move of ${usd(row.amountCents)} failed: ${r.error}`);
  return { resolved: row.id, status: s };
}

export async function runAccount(d: Deps, cfg: SweepConfig, account: string, open: OpenSweep | undefined, seen: Seen = new Map()): Promise<Record<string, unknown>> {
  if (open) {
    // Switched off while one was in flight: leave it for the next run after
    // it is switched back on, or for the owner to check in Blink.
    if (!cfg.enabled) return { skipped: "off", open: open.id };
    return await resolveOpen(d, open);
  }
  // Read-only even while off, so Admin → Settings shows each account's
  // balance, send permission and limit before the sweep is turned on.
  const wallet = await d.usdWallet(account);
  seen.set(account, { wallet });
  const base = { balanceCents: wallet.balanceCents, canSend: wallet.canSend, withdrawRemainingCents: wallet.withdrawRemainingCents };
  if (!cfg.enabled) {
    await safeNote(d, account, { ...base, result: "off" });
    return { skipped: "off" };
  }
  const addr = parseLightningAddress(cfg.destination);
  if (!addr) {
    await safeNote(d, account, { ...base, result: "no_destination" });
    return { skipped: "no_destination" };
  }
  if (!wallet.canSend) {
    await safeNote(d, account, { ...base, result: "no_write" });
    return { skipped: "no_write" };
  }
  const cents = moveCents(wallet.balanceCents, cfg, wallet.withdrawRemainingCents);
  if (!cents) {
    const limited = wallet.withdrawRemainingCents !== null && moveCents(wallet.balanceCents, cfg) > 0;
    const result = limited ? "daily_limit" : "below_minimum";
    await safeNote(d, account, { ...base, result });
    return { skipped: result, balanceCents: wallet.balanceCents };
  }

  const sats = Math.floor((await d.usdToSats(account, cents)) * SAT_MARGIN);
  if (sats < 1) return { skipped: "too_small" };
  const inv = await d.invoice(addr.address, BigInt(sats) * 1000n);

  const id = await d.begin({
    account, amountCents: cents, amountSat: sats, destination: addr.address, walletId: wallet.id,
    bolt11: inv.invoice, paymentHash: inv.paymentHash, expiresAtMs: inv.expiresAtMs,
  });
  if (!id) return { skipped: "busy" };

  let r: { status: PayStatus; error: string | null };
  try {
    r = await d.pay(account, wallet.id, inv.invoice);
  } catch (e) {
    // Left "sending": the next run pays the same invoice again (safe).
    await safeNote(d, account, { ...base, result: "sending" });
    return { id, status: "sending", error: errText(e) };
  }
  const s = outcome(r.status);
  await d.finish(id, s, r.error);
  await safeNote(d, account, { ...base, result: s });
  if (s === "sent") await safeAlert(d, `✅ ${name(account)} → CPAY: moved ${usd(cents)} (${sats.toLocaleString("en-US")} sats) to ${addr.address}.`);
  if (s === "failed") await safeAlert(d, `⚠ ${name(account)} → CPAY move of ${usd(cents)} failed: ${r.error}`);
  return { id, status: s, amountCents: cents, amountSat: sats };
}

/** Withdrawal limit left once what the account already holds is moved (Infinity = no limit reported). */
export function roomCents(w: UsdWallet, keepCents: number): number {
  return (w.withdrawRemainingCents ?? Infinity) - Math.max(0, w.balanceCents - keepCents);
}

/** The account to switch BTCPay to: can send, not the current one, at least twice "switch below" of room, the most room. */
export function switchTarget(c: Pick<SweepConfig, "keepCents" | "switchBelowCents">, seen: Seen, current: string): string | null {
  let best: string | null = null;
  let bestRoom = -Infinity;
  for (const [a, s] of seen) {
    if (a === current || !s.wallet.canSend) continue;
    const r = roomCents(s.wallet, c.keepCents);
    if (r >= 2 * c.switchBelowCents && r > bestRoom) { best = a; bestRoom = r; }
  }
  return best;
}

async function safeReceiveNote(d: Deps, r: Receiving, result: string) {
  try { await d.receiveNote(r, result); } catch (e) { console.error("receive note failed:", errText(e)); }
}

async function runSwitch(d: Deps, cfg: SweepConfig, seen: Seen): Promise<Record<string, unknown>> {
  const walletIds = new Map([...seen].map(([a, s]) => [a, s.wallet.id]));
  const none: Receiving = { account: null, keyKind: null };
  let r: Receiving;
  try {
    r = await d.receiving(walletIds);
  } catch (e) {
    const msg = errText(e);
    await safeReceiveNote(d, none, `error: ${msg}`);
    return { error: msg };
  }
  if (!r.account) {
    await safeReceiveNote(d, r, "unknown_account");
    return { skipped: "unknown_account" };
  }
  const cur = seen.get(r.account);
  if (!cur) {
    await safeReceiveNote(d, r, "not_read");
    return { account: r.account, skipped: "not_read" };
  }
  if (roomCents(cur.wallet, cfg.keepCents) >= cfg.switchBelowCents) {
    await safeReceiveNote(d, r, "ok");
    return { account: r.account };
  }
  if (!cfg.enabled || !cfg.receiveSwitch) {
    await safeReceiveNote(d, r, "low_limit");
    return { account: r.account, skipped: "off" };
  }
  const to = switchTarget(cfg, seen, r.account);
  if (!to) {
    await safeReceiveNote(d, r, "no_target");
    return { account: r.account, skipped: "no_target" };
  }
  const id = await d.switchBegin(r.account, to);
  if (!id) {
    await safeReceiveNote(d, r, "busy");
    return { account: r.account, skipped: "busy" };
  }
  const what = `BTCPay receive switch ${name(r.account)} → ${name(to)}`;
  try {
    await d.switchTo(to, seen.get(to)!.wallet.id);
  } catch (e) {
    const msg = errText(e);
    await d.switchFinish(id, "failed", msg);
    await safeReceiveNote(d, r, "switch_failed");
    await safeAlert(d, `⚠ ${what} failed: ${msg}. BTCPay still pays into ${name(r.account)}.`);
    return { account: r.account, to, id, status: "failed", error: msg };
  }
  // Read back: only a confirmed switch is "done". Either way the rescue
  // checks invoices made before it.
  let after: Receiving | null = null;
  try { after = await d.receiving(walletIds); } catch { after = null; }
  const ok = after?.account === to;
  await d.switchFinish(id, ok ? "done" : "unknown", ok ? null : "BTCPay did not read back the new account");
  await safeReceiveNote(d, ok ? after! : r, ok ? "switched" : "check_btcpay");
  await safeAlert(d, ok
    ? `🔀 ${what}: ${name(r.account)} had ${usd(Math.max(0, roomCents(cur.wallet, cfg.keepCents)))} of Blink's daily withdrawal limit left. New invoices are paid into ${name(to)}${after!.keyKind === "api" ? " (BTCPay holds a key that can spend: add BLINK_RECEIVE_KEY for it)" : ""}. CPAY checks invoices still open on ${name(r.account)}.`
    : `⚠ ${what} sent, but BTCPay did not read back ${name(to)}. Check BTCPay → Lightning settings.`);
  return { account: r.account, to, id, status: ok ? "done" : "unknown" };
}

async function runRescue(d: Deps): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const c of await d.rescueCandidates()) {
    if (!d.accounts.includes(c.account)) continue;
    try {
      const inv = decodeBolt11(c.bolt11);
      if (!(await d.invoicePaid(c.account, inv.paymentHash))) continue;
      const sats = inv.amountMsat ? Number(inv.amountMsat / 1000n) : 0;
      const r = await d.rescueSettle(c.paymentId, c.account, sats);
      out.push({ paymentId: c.paymentId, account: c.account, outcome: r });
      if (r === "settled") {
        await safeAlert(d, `🛟 A $${c.amountUsd} payment was paid into ${name(c.account)} after BTCPay switched away from it. CPAY recorded it (BTCPay may still show the invoice unpaid).`);
      }
    } catch (e) {
      out.push({ paymentId: c.paymentId, account: c.account, error: errText(e) });
    }
  }
  return out;
}

export async function run(d: Deps): Promise<Record<string, unknown>> {
  const cfg = await d.config();
  const open = await d.open();
  const accounts: Record<string, unknown> = {};
  const seen: Seen = new Map();
  for (const account of d.accounts) {
    try {
      accounts[account] = await runAccount(d, cfg, account, open.find((o) => o.account === account), seen);
    } catch (e) {
      const msg = errText(e);
      console.error(`blink sweep ${name(account)} failed:`, msg);
      await safeNote(d, account, { balanceCents: null, canSend: null, withdrawRemainingCents: null, result: `error: ${msg}` });
      accounts[account] = { error: msg };
    }
  }
  const out: Record<string, unknown> = { accounts };
  if (d.canSwitch) {
    try {
      out.receive = await runSwitch(d, cfg, seen);
    } catch (e) {
      out.receive = { error: errText(e) };
    }
  }
  try {
    const rescued = await runRescue(d);
    if (rescued.length) out.rescued = rescued;
  } catch (e) {
    out.rescued = { error: errText(e) };
  }
  // An open sweep of an account whose key was removed is left alone.
  const orphaned = open.filter((o) => !d.accounts.includes(o.account)).map((o) => o.id);
  if (orphaned.length) out.orphaned = orphaned;
  return out;
}

export function createHandler(d: Deps) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return json(405, { error: "method not allowed" });
    if (!d.cronSecret || !secretMatches(req.headers.get("x-cron-secret"), d.cronSecret)) return json(401, { error: "unauthorized" });
    if (!d.accounts.length) return json(200, { skipped: "not_configured" });
    try {
      return json(200, await run(d));
    } catch (e) {
      const msg = errText(e);
      console.error("blink sweep failed:", msg);
      return json(502, { error: msg });
    }
  };
}
