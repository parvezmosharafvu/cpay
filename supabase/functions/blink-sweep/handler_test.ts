import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createHandler, type Deps, moveCents, outcome, type OpenSweep, type Receiving, roomCents, run, type Seen, STALE_AFTER_MS, switchTarget,
} from "./handler.ts";
import { blinkAccounts, blinkConfig, type UsdWallet } from "../_shared/blink.ts";
import type { Bolt11 } from "../_shared/bolt11.ts";
import { buildInvoice } from "../_shared/bolt11_testkit.ts";

const NOW = 1_800_000_000_000;
const cfg = { enabled: true, receiveSwitch: false, switchBelowCents: 5_000, keepCents: 0, minCents: 500, maxCents: 20_000, destination: "cpay@breez.tips" };
const bolt = (msat: bigint, n = 1): Bolt11 => ({
  network: "bitcoin", amountMsat: msat, timestamp: NOW / 1000, expirySeconds: 600, expiresAtMs: NOW + 600_000,
  paymentHash: String(n).repeat(64).slice(0, 64), paymentSecret: null, description: null, descriptionHash: "cd".repeat(32), payeePubkey: null, invoice: `lnbc1test${n}`,
});
const wallet = (over: Partial<UsdWallet> = {}): UsdWallet => ({ id: "usd-wallet", balanceCents: 10_000, canSend: true, withdrawRemainingCents: null, ...over });

function deps(over: Partial<Deps> = {}, state: { open?: OpenSweep[]; wallets?: Record<string, Partial<UsdWallet>> } = {}) {
  const calls = { begin: [] as unknown[], finish: [] as unknown[], pay: [] as unknown[], invoice: [] as unknown[], notes: [] as unknown[], alerts: [] as string[],
    switches: [] as unknown[], receiveNotes: [] as unknown[], switchBegin: [] as unknown[], switchFinish: [] as unknown[], rescues: [] as unknown[] };
  let n = 0;
  const d: Deps = {
    cronSecret: "cron", accounts: ["1"],
    config: () => Promise.resolve({ ...cfg }),
    open: () => Promise.resolve(state.open ?? []),
    usdWallet: (a) => Promise.resolve(wallet({ id: `usd-${a}`, ...(state.wallets?.[a] ?? {}) })),
    usdToSats: (_a, c) => Promise.resolve(c * 10), // $1 = 1,000 sats
    invoice: (a, m) => { calls.invoice.push([a, m]); return Promise.resolve(bolt(m, ++n)); },
    begin: (b) => { calls.begin.push(b); return Promise.resolve(`sweep-${b.account}`); },
    finish: (id, s, e) => { calls.finish.push([id, s, e]); return Promise.resolve(); },
    pay: (a, w, b) => { calls.pay.push([a, w, b]); return Promise.resolve({ status: "SUCCESS", error: null }); },
    note: (a, x) => { calls.notes.push([a, x.result]); return Promise.resolve(); },
    canSwitch: false,
    receiving: () => Promise.resolve({ account: null, keyKind: null }),
    switchTo: (a, w) => { calls.switches.push([a, w]); return Promise.resolve("receive"); },
    receiveNote: (r, x) => { calls.receiveNotes.push([r.account, x]); return Promise.resolve(); },
    switchBegin: (f, t) => { calls.switchBegin.push([f, t]); return Promise.resolve(`sw-${t}`); },
    switchFinish: (id, st, e) => { calls.switchFinish.push([id, st, e]); return Promise.resolve(); },
    rescueCandidates: () => Promise.resolve([]),
    invoicePaid: () => Promise.resolve(false),
    rescueSettle: (p, a, sats) => { calls.rescues.push([p, a, sats]); return Promise.resolve("settled"); },
    alert: (t) => { calls.alerts.push(t); return Promise.resolve(); },
    now: () => NOW,
    ...over,
  };
  return { d, calls };
}
const post = (h: (r: Request) => Promise<Response>, secret = "cron") =>
  h(new Request("http://x/blink-sweep", { method: "POST", headers: { "x-cron-secret": secret } }));
const one = async (d: Deps) => ((await run(d)).accounts as Record<string, Record<string, unknown>>)["1"];

Deno.test("auth: wrong or missing cron secret is refused; GET is refused", async () => {
  const { d, calls } = deps();
  const h = createHandler(d);
  assertEquals((await post(h, "nope")).status, 401);
  assertEquals((await h(new Request("http://x/", { method: "POST" }))).status, 401);
  assertEquals((await h(new Request("http://x/", { method: "GET" }))).status, 405);
  assertEquals((await post(createHandler({ ...d, cronSecret: "" }), "")).status, 401);
  assertEquals(calls.pay.length, 0);
});

Deno.test("no Blink key: nothing happens", async () => {
  const { d, calls } = deps({ accounts: [] });
  const r = await post(createHandler(d));
  assertEquals(await r.json(), { skipped: "not_configured" });
  assertEquals(calls.pay.length, 0);
});

Deno.test("move amount: balance minus keep, capped, Blink's limit left, below the minimum is nothing", () => {
  const c = { keepCents: 0, minCents: 500, maxCents: 20_000 };
  assertEquals(moveCents(10_000, c), 10_000);
  assertEquals(moveCents(10_000, { ...c, keepCents: 2_000 }), 8_000);
  assertEquals(moveCents(90_000, c), 20_000);
  assertEquals(moveCents(2_400, { ...c, keepCents: 2_000 }), 0);
  assertEquals(moveCents(-50, { ...c, minCents: 0 }), 0);
  assertEquals(moveCents(0, { ...c, minCents: 0 }), 0);
  assertEquals(moveCents(10_000, c, 3_000), 3_000);
  assertEquals(moveCents(10_000, c, 400), 0);
  assertEquals(moveCents(10_000, c, null), 10_000);
});

Deno.test("status mapping", () => {
  assertEquals(outcome("SUCCESS"), "sent");
  assertEquals(outcome("ALREADY_PAID"), "sent");
  assertEquals(outcome("PENDING"), "pending");
  assertEquals(outcome("FAILURE"), "failed");
});

Deno.test("sweep: invoice from the primary wallet's address for 98% of the estimate, recorded before paying", async () => {
  const order: string[] = [];
  const { d, calls } = deps();
  const base = { ...d };
  d.begin = (b) => { order.push("begin"); return base.begin(b); };
  d.pay = (a, w, b) => { order.push("pay"); return base.pay(a, w, b); };
  assertEquals(await one(d), { id: "sweep-1", status: "sent", amountCents: 10_000, amountSat: 98_000 });
  assertEquals(calls.invoice, [["cpay@breez.tips", 98_000_000n]]);
  assertEquals(order, ["begin", "pay"]);
  assertEquals(calls.pay, [["1", "usd-1", "lnbc1test1"]]);
  assertEquals(calls.finish, [["sweep-1", "sent", null]]);
  assertEquals(calls.notes, [["1", "sent"]]);
  assert(calls.alerts[0].includes("$100.00") && calls.alerts[0].includes("Blink #1"));
});

Deno.test("several accounts: each is swept with its own wallet and invoice; one failing never stops the others", async () => {
  const { d, calls } = deps({ accounts: ["1", "2", "3"] }, { wallets: { "2": { balanceCents: 30_000 } } });
  const base = { ...d };
  d.usdWallet = (a) => (a === "1" ? Promise.reject(new Error("Blink answered 401")) : base.usdWallet(a));
  const out = (await run(d)).accounts as Record<string, Record<string, unknown>>;
  assertEquals(out["1"], { error: "Blink answered 401" });
  assertEquals(out["2"].amountCents, 20_000);
  assertEquals(out["3"].amountCents, 10_000);
  assertEquals(calls.pay, [["2", "usd-2", "lnbc1test1"], ["3", "usd-3", "lnbc1test2"]]);
  assertEquals(calls.notes[0], ["1", "error: Blink answered 401"]);
});

Deno.test("Blink's 24-hour withdrawal limit caps the move; none left is noted as daily_limit", async () => {
  let { d, calls } = deps({}, { wallets: { "1": { withdrawRemainingCents: 6_000 } } });
  assertEquals((await one(d)).amountCents, 6_000);
  ({ d, calls } = deps({}, { wallets: { "1": { withdrawRemainingCents: 0 } } }));
  assertEquals((await one(d)).skipped, "daily_limit");
  assertEquals(calls.notes, [["1", "daily_limit"]]);
  assertEquals(calls.pay.length, 0);
});

Deno.test("a key without WRITE cannot send: noted, nothing paid", async () => {
  const { d, calls } = deps({}, { wallets: { "1": { canSend: false } } });
  assertEquals((await one(d)).skipped, "no_write");
  assertEquals(calls.notes, [["1", "no_write"]]);
  assertEquals(calls.invoice.length + calls.pay.length, 0);
});

Deno.test("off: the account is still read and noted, nothing is paid", async () => {
  const { d, calls } = deps({ config: () => Promise.resolve({ ...cfg, enabled: false }) });
  assertEquals((await one(d)).skipped, "off");
  assertEquals(calls.notes, [["1", "off"]]);
  assertEquals(calls.pay.length, 0);
});

Deno.test("no destination, below the minimum, busy: nothing is paid", async () => {
  for (const [over, state, skipped] of [
    [{ config: () => Promise.resolve({ ...cfg, destination: null }) }, {}, "no_destination"],
    [{ config: () => Promise.resolve({ ...cfg, destination: "not an address" }) }, {}, "no_destination"],
    [{}, { wallets: { "1": { balanceCents: 499 } } }, "below_minimum"],
    [{ begin: () => Promise.resolve(null) }, {}, "busy"],
  ] as [Partial<Deps>, { wallets?: Record<string, Partial<UsdWallet>> }, string][]) {
    const { d, calls } = deps(over, state);
    assertEquals((await one(d)).skipped, skipped);
    assertEquals(calls.pay.length, 0);
  }
});

Deno.test("Blink refuses: recorded failed with the reason, alert sent", async () => {
  const { d, calls } = deps({ pay: () => Promise.resolve({ status: "FAILURE", error: "Insufficient balance" }) });
  assertEquals((await one(d)).status, "failed");
  assertEquals(calls.finish, [["sweep-1", "failed", "Insufficient balance"]]);
  assert(calls.alerts[0].includes("Insufficient balance"));
});

Deno.test("network error while paying: left 'sending' for the next run", async () => {
  const { d, calls } = deps({ pay: () => Promise.reject(new Error("timeout")) });
  assertEquals((await one(d)).status, "sending");
  assertEquals(calls.finish.length, 0);
});

const open: OpenSweep = { id: "old", account: "1", walletId: "usd-1", bolt11: "lnbc1old", expiresAtMs: NOW - 1000, amountCents: 5_000, destination: "cpay@breez.tips" };

Deno.test("open sweep: paid again with the same invoice; ALREADY_PAID closes it as sent; no new sweep for that account only", async () => {
  const { d, calls } = deps({ accounts: ["1", "2"] }, { open: [open] });
  const base = { ...d };
  d.pay = (a, w, b) => (b === "lnbc1old" ? (calls.pay.push([a, w, b]), Promise.resolve({ status: "ALREADY_PAID" as const, error: null })) : base.pay(a, w, b));
  const out = (await run(d)).accounts as Record<string, Record<string, unknown>>;
  assertEquals(out["1"], { resolved: "old", status: "sent" });
  assertEquals(out["2"].status, "sent");
  assertEquals(calls.pay, [["1", "usd-1", "lnbc1old"], ["2", "usd-2", "lnbc1test1"]]);
  assertEquals(calls.begin.length, 1);
  assertEquals(calls.finish[0], ["old", "sent", null]);
});

Deno.test("open sweep still pending: kept open; long after expiry it closes as unknown with an alert", async () => {
  const pending = { pay: () => Promise.resolve({ status: "PENDING" as const, error: null }) };
  let { d, calls } = deps(pending, { open: [open] });
  assertEquals(await one(d), { resolved: "old", status: "pending" });
  assertEquals(calls.finish.length, 0);
  ({ d, calls } = deps({ ...pending, now: () => NOW + STALE_AFTER_MS + 1 }, { open: [open] }));
  assertEquals((await one(d)).status, "unknown");
  assertEquals(calls.finish[0], ["old", "unknown", "still pending after the invoice expired"]);
  assert(calls.alerts.length === 1);
});

Deno.test("open sweep while switched off: not paid again", async () => {
  const { d, calls } = deps({ config: () => Promise.resolve({ ...cfg, enabled: false }) }, { open: [open] });
  assertEquals(await one(d), { skipped: "off", open: "old" });
  assertEquals(calls.pay.length, 0);
});

Deno.test("open sweep of a removed key is reported, not touched", async () => {
  const { d, calls } = deps({}, { open: [{ ...open, account: "7" }] });
  const out = await run(d);
  assertEquals(out.orphaned, ["old"]);
  assertEquals(calls.pay.filter((p) => (p as string[])[2] === "lnbc1old").length, 0);
});

Deno.test("an error before the accounts is a 502 with the message, never the key", async () => {
  const { d } = deps({ config: () => Promise.reject(new Error("system_blink_sweep_config: boom")) });
  const r = await post(createHandler(d));
  assertEquals(r.status, 502);
  assertEquals(await r.json(), { error: "system_blink_sweep_config: boom" });
});

Deno.test("blinkConfig / blinkAccounts: keys 1…10 in order; only Blink hosts over https", () => {
  const env = (o: Record<string, string>) => ({ get: (k: string) => o[k] });
  assertEquals(blinkConfig(env({})), null);
  assertEquals(blinkConfig(env({ BLINK_API_KEY: "k" }))?.url, "https://api.blink.sv/graphql");
  assertEquals(blinkConfig(env({ BLINK_API_KEY: "k", BLINK_API_URL: "https://api.staging.blink.sv/graphql" }))?.url, "https://api.staging.blink.sv/graphql");
  assertEquals(blinkConfig(env({ BLINK_API_KEY: "k", BLINK_API_URL: "https://evil.example/graphql" })), null);
  assertEquals(blinkConfig(env({ BLINK_API_KEY: "k", BLINK_API_URL: "http://api.blink.sv/graphql" })), null);
  const many = blinkAccounts(env({ BLINK_API_KEY_3: "c", BLINK_API_KEY: "a", BLINK_API_KEY_10: "j", BLINK_API_KEY_11: "x", BLINK_API_KEY_2: " " }));
  assertEquals(many.map((a) => [a.label, a.apiKey]), [["1", "a"], ["3", "c"], ["10", "j"]]);
  assertEquals(blinkAccounts(env({ BLINK_API_KEY_2: "b", BLINK_API_URL: "https://evil.example/graphql" })), []);
});

// Receive switch: BTCPay pays into #1, which has little withdrawal limit left; #2 has room.
const switchOn = { config: () => Promise.resolve({ ...cfg, receiveSwitch: true }), accounts: ["1", "2"], canSwitch: true };
const lowOne = { wallets: { "1": { balanceCents: 0, withdrawRemainingCents: 2_000 }, "2": { balanceCents: 0, withdrawRemainingCents: 99_900 } } };
const at = (account: string | null, keyKind: Receiving["keyKind"] = "receive"): Receiving => ({ account, keyKind });

Deno.test("receive switch: low limit on the receiving account points BTCPay at the account with room, recorded first, read back", async () => {
  const order: string[] = [];
  let current = "1";
  const { d, calls } = deps({
    ...switchOn,
    receiving: (ids) => {
      assertEquals(ids.get("2"), "usd-2");
      return Promise.resolve(at(current));
    },
    switchBegin: (f, t) => {
      order.push("begin");
      calls.switchBegin.push([f, t]);
      return Promise.resolve("sw-1");
    },
    switchTo: (a, w) => {
      order.push("switch");
      calls.switches.push([a, w]);
      current = a;
      return Promise.resolve("receive");
    },
  }, lowOne);
  const r = await run(d);
  assertEquals(r.receive, { account: "1", to: "2", id: "sw-1", status: "done" });
  assertEquals(order, ["begin", "switch"]);
  assertEquals(calls.switches, [["2", "usd-2"]]);
  assertEquals(calls.switchFinish, [["sw-1", "done", null]]);
  assertEquals(calls.receiveNotes, [["2", "switched"]]);
  assert(calls.alerts.some((a) => a.includes("Blink #1 → Blink #2") && a.includes("$20.00")));
});

Deno.test("receive switch: enough room, switch off, sweep off, no target or busy: BTCPay is left alone", async () => {
  const on1 = () => Promise.resolve(at("1"));
  const room = deps({ ...switchOn, receiving: on1 }, { wallets: { "1": { balanceCents: 0, withdrawRemainingCents: 90_000 } } });
  assertEquals((await run(room.d)).receive, { account: "1" });
  const off = deps({ ...switchOn, config: () => Promise.resolve({ ...cfg }), receiving: on1 }, lowOne);
  assertEquals((await run(off.d)).receive, { account: "1", skipped: "off" });
  assertEquals(off.calls.receiveNotes, [["1", "low_limit"]]);
  const sweepOff = deps({ ...switchOn, config: () => Promise.resolve({ ...cfg, enabled: false, receiveSwitch: true }), receiving: on1 }, lowOne);
  assertEquals((await run(sweepOff.d)).receive, { account: "1", skipped: "off" });
  const noTarget = deps({ ...switchOn, receiving: on1 }, { wallets: { ...lowOne.wallets, "2": { withdrawRemainingCents: 9_000, balanceCents: 0 } } });
  assertEquals((await run(noTarget.d)).receive, { account: "1", skipped: "no_target" });
  const busy = deps({ ...switchOn, receiving: on1, switchBegin: () => Promise.resolve(null) }, lowOne);
  assertEquals((await run(busy.d)).receive, { account: "1", skipped: "busy" });
  for (const x of [room, off, sweepOff, noTarget, busy]) assertEquals(x.calls.switches.length, 0);
  const noKey = deps({ accounts: ["1", "2"], config: () => Promise.resolve({ ...cfg, receiveSwitch: true }) }, lowOne);
  assertEquals((await run(noKey.d)).receive, undefined);
});

Deno.test("receive switch: BTCPay on an unknown account or unreadable is noted, never switched", async () => {
  const unknown = deps({ ...switchOn, receiving: () => Promise.resolve(at(null, null)) }, lowOne);
  assertEquals((await run(unknown.d)).receive, { skipped: "unknown_account" });
  const broken = deps({ ...switchOn, receiving: () => Promise.reject(new Error("BTCPay GET Lightning settings: HTTP 403")) }, lowOne);
  assertEquals((await run(broken.d)).receive, { error: "BTCPay GET Lightning settings: HTTP 403" });
  assertEquals(broken.calls.receiveNotes, [[null, "error: BTCPay GET Lightning settings: HTTP 403"]]);
  assertEquals(unknown.calls.switches.length + broken.calls.switches.length, 0);
});

Deno.test("receive switch: BTCPay refuses: failed with an alert; not read back: unknown", async () => {
  const on1 = () => Promise.resolve(at("1"));
  const refused = deps({ ...switchOn, receiving: on1, switchTo: () => Promise.reject(new Error("HTTP 422")) }, lowOne);
  assertEquals((await run(refused.d)).receive, { account: "1", to: "2", id: "sw-2", status: "failed", error: "HTTP 422" });
  assertEquals(refused.calls.switchFinish, [["sw-2", "failed", "HTTP 422"]]);
  assert(refused.calls.alerts.some((a) => a.includes("still pays into Blink #1")));
  const unread = deps({ ...switchOn, receiving: on1 }, lowOne);
  assertEquals(((await run(unread.d)).receive as Record<string, unknown>).status, "unknown");
  assertEquals(unread.calls.switchFinish, [["sw-2", "unknown", "BTCPay did not read back the new account"]]);
});

Deno.test("switch target: can send, not current, at least twice the threshold, most room; room counts what it holds", () => {
  const seen: Seen = new Map([
    ["1", { wallet: wallet({ balanceCents: 0, withdrawRemainingCents: 1_000 }) }],
    ["2", { wallet: wallet({ balanceCents: 50_000, withdrawRemainingCents: 60_000 }) }],
    ["3", { wallet: wallet({ balanceCents: 0, withdrawRemainingCents: 40_000 }) }],
    ["4", { wallet: wallet({ balanceCents: 0, withdrawRemainingCents: 99_000, canSend: false }) }],
  ]);
  assertEquals(roomCents(seen.get("2")!.wallet, 0), 10_000);
  assertEquals(roomCents(wallet({ withdrawRemainingCents: null }), 0), Infinity);
  assertEquals(switchTarget({ keepCents: 0, switchBelowCents: 5_000 }, seen, "1"), "3");
  assertEquals(switchTarget({ keepCents: 0, switchBelowCents: 25_000 }, seen, "1"), null);
  assertEquals(switchTarget({ keepCents: 0, switchBelowCents: 5_000 }, seen, "3"), "2");
});

const HASH = "ab".repeat(32);
const candidate = { paymentId: "p-1", bolt11: buildInvoice({ amountMsat: 25_000_000n, paymentHash: HASH }), amountUsd: "25.00", account: "1" };

Deno.test("rescue: an invoice open on the old account that Blink shows paid is recorded once, with an alert", async () => {
  const asked: unknown[] = [];
  const { d, calls } = deps({
    rescueCandidates: () => Promise.resolve([candidate, { ...candidate, paymentId: "p-2", account: "9" }]),
    invoicePaid: (a, h) => {
      asked.push([a, h]);
      return Promise.resolve(true);
    },
  });
  const r = await run(d);
  assertEquals(asked, [["1", HASH]]);
  assertEquals(calls.rescues, [["p-1", "1", 25_000]]);
  assertEquals(r.rescued, [{ paymentId: "p-1", account: "1", outcome: "settled" }]);
  assert(calls.alerts.some((a) => a.includes("$25.00") && a.includes("Blink #1")));
});

Deno.test("rescue: unpaid, already settled, bad invoice or Blink error: nothing recorded, no alert", async () => {
  const unpaid = deps({ rescueCandidates: () => Promise.resolve([candidate]) });
  assertEquals((await run(unpaid.d)).rescued, undefined);
  assertEquals(unpaid.calls.rescues.length, 0);
  const done = deps({ rescueCandidates: () => Promise.resolve([candidate]), invoicePaid: () => Promise.resolve(true), rescueSettle: () => Promise.resolve("already_settled") });
  assertEquals((await run(done.d)).rescued, [{ paymentId: "p-1", account: "1", outcome: "already_settled" }]);
  assertEquals(done.calls.alerts.filter((a) => a.includes("🛟")).length, 0);
  const bad = deps({ rescueCandidates: () => Promise.resolve([{ ...candidate, bolt11: "lnbc1nonsense" }]), invoicePaid: () => Promise.resolve(true) });
  assertEquals(((await run(bad.d)).rescued as Record<string, unknown>[])[0].outcome, undefined);
  assertEquals(bad.calls.rescues.length, 0);
  const err = deps({ rescueCandidates: () => Promise.resolve([candidate]), invoicePaid: () => Promise.reject(new Error("Blink answered 500")) });
  assertEquals((await run(err.d)).rescued, [{ paymentId: "p-1", account: "1", error: "Blink answered 500" }]);
});
