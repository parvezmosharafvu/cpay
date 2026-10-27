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
// Overflow (blink_sweep_overflow_enabled, needs two or more accounts): an
// account that has hit Blink's 24-hour withdrawal limit sends its USD to
// another of the owner's Blink accounts that still has withdrawal limit
// left (Blink-to-Blink, intraLedgerUsdPaymentSend, a separate Blink limit).
// That account moves it to CPAY on its next run. At most one transfer per
// account per run, to the account with the most room; recorded in
// blink_overflows before sending. A transfer has no invoice, so it is never
// retried: the next run reads the balances again.
import { parseLightningAddress } from "../_shared/lnurl.ts";
import type { Bolt11 } from "../_shared/bolt11.ts";
import type { PayStatus, UsdWallet } from "../_shared/blink.ts";
import { secretMatches } from "../_shared/secret-compare.ts";

export type SweepConfig = { enabled: boolean; overflow: boolean; keepCents: number; minCents: number; maxCents: number; destination: string | null };
export type OpenSweep = { id: string; account: string; walletId: string; bolt11: string; expiresAtMs: number; amountCents: number; destination: string };
export type SweepStatus = "sent" | "pending" | "failed" | "unknown";
export type Begin = {
  account: string; amountCents: number; amountSat: number; destination: string; walletId: string;
  bolt11: string; paymentHash: string; expiresAtMs: number;
};
export type AccountNote = { balanceCents: number | null; canSend: boolean | null; withdrawRemainingCents: number | null; result: string };
export type Transfer = { from: string; to: string; cents: number };
export type TransferStatus = "sent" | "failed" | "unknown";
/** What a run read for each account; limited = Blink's withdrawal limit stopped its move. */
export type Seen = Map<string, { wallet: UsdWallet; limited: boolean }>;

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
  /** Blink-to-Blink USD transfer from the account's own USD wallet. */
  transfer(account: string, walletId: string, recipientWalletId: string, cents: number): Promise<{ status: PayStatus; error: string | null }>;
  /** Records a transfer; null = one from that account was recorded in the last few minutes. */
  overflowBegin(t: Transfer): Promise<string | null>;
  overflowFinish(id: string, status: TransferStatus, error: string | null): Promise<void>;
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
  seen.set(account, { wallet, limited: false });
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
    if (limited) seen.set(account, { wallet, limited: true });
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

/**
 * Overflow transfers for this run: each account stopped by Blink's withdrawal
 * limit sends what it holds (less "keep", capped at "largest move" and at its
 * Blink-to-Blink limit) to the account with the most withdrawal room left
 * (its limit left minus what it already holds and has been given this run).
 */
export function overflowPlan(c: Pick<SweepConfig, "keepCents" | "minCents" | "maxCents">, seen: Seen): Transfer[] {
  const min = Math.max(c.minCents, 1);
  const room = new Map<string, number>();
  for (const [a, s] of seen) {
    if (!s.limited && s.wallet.canSend) {
      room.set(a, (s.wallet.withdrawRemainingCents ?? Infinity) - Math.max(0, s.wallet.balanceCents - c.keepCents));
    }
  }
  const out: Transfer[] = [];
  for (const [from, s] of seen) {
    if (!s.limited) continue;
    let to: string | null = null;
    for (const [a, r] of room) if (to === null || r > room.get(to)!) to = a;
    if (to === null) break;
    const cents = Math.min(s.wallet.balanceCents - c.keepCents, s.wallet.internalSendRemainingCents ?? Infinity, c.maxCents, room.get(to)!);
    if (!Number.isFinite(cents) || cents < min) continue;
    out.push({ from, to, cents });
    room.set(to, room.get(to)! - cents);
  }
  return out;
}

async function runTransfer(d: Deps, t: Transfer, seen: Seen): Promise<Record<string, unknown>> {
  const what = `${name(t.from)} → ${name(t.to)} transfer of ${usd(t.cents)}`;
  const id = await d.overflowBegin(t);
  if (!id) return { ...t, skipped: "busy" };
  let r: { status: PayStatus; error: string | null };
  try {
    r = await d.transfer(t.from, seen.get(t.from)!.wallet.id, seen.get(t.to)!.wallet.id, t.cents);
  } catch (e) {
    // Never retried: the next run reads both balances again.
    const msg = errText(e);
    await d.overflowFinish(id, "unknown", msg);
    await safeAlert(d, `⚠ ${what} could not be confirmed (${msg}). Check both accounts in Blink.`);
    return { ...t, id, status: "unknown", error: msg };
  }
  const s: TransferStatus = r.status === "SUCCESS" || r.status === "ALREADY_PAID" ? "sent" : r.status === "PENDING" ? "unknown" : "failed";
  await d.overflowFinish(id, s, r.error);
  await safeAlert(d, s === "sent"
    ? `↪ ${what}: ${name(t.from)} reached Blink's daily withdrawal limit. ${name(t.to)} moves it to CPAY next.`
    : `⚠ ${what} ${s === "failed" ? `failed: ${r.error}` : "is still pending. Check both accounts in Blink."}`);
  return { ...t, id, status: s };
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
  if (cfg.enabled && cfg.overflow) {
    const transfers: Record<string, unknown>[] = [];
    for (const t of overflowPlan(cfg, seen)) {
      try {
        transfers.push(await runTransfer(d, t, seen));
      } catch (e) {
        const msg = errText(e);
        console.error(`blink overflow ${name(t.from)} failed:`, msg);
        transfers.push({ ...t, error: msg });
      }
    }
    if (transfers.length) out.overflow = transfers;
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
