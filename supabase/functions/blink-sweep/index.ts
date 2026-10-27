// blink-sweep Edge Function: wiring only; the rules are in handler.ts
// (tested by handler_test.ts). docs/BLINK-SWEEP.md.
//
// Moves the Blink USD balance (where BTCPay's Blink Lightning payments land)
// of one or more Blink accounts into the primary CPAY wallet, through that
// wallet's own Lightning address.
//
// Secrets / env (names only):
//   BLINK_API_KEY, BLINK_API_KEY_2 … _10   Blink API keys with Read + Write,
//                                          one per Blink account
//   BLINK_RECEIVE_KEY, _2 … _10   optional, Read + Receive key of the same
//                                 account: what BTCPay gets on a receive switch
//   BTCPAY_URL, BTCPAY_STORE_ID, BTCPAY_API_KEY   receive switch (the key
//                                 needs Modify store settings on 'cpay');
//                                 BTCPAY_SWITCH_API_KEY, optional, used instead
//   BLINK_API_URL                 optional, Blink hosts only (staging)
//   BLINK_SWEEP_CRON_SECRET       optional, else CRON_SECRET (x-cron-secret)
//   ALERT_TELEGRAM_BOT_TOKEN, ALERT_TELEGRAM_CHAT_ID   optional alerts
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY            (set by Supabase)
// verify_jwt = false (pg_cron sends x-cron-secret instead).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.3";
import {
  blinkAccounts, connectionString, invoicePaid, payInvoice, receivingAccount, usdToSats, usdWallet,
} from "../_shared/blink.ts";
import { btcpaySwitchConfig, getLightningConnection, setLightningConnection } from "../_shared/btcpay-store.ts";
import { denoResolver, fetchPayRequest, guardedFetch, parseLightningAddress, requestInvoice } from "../_shared/lnurl.ts";
import { configuredCronSecret } from "../_shared/scoped-cron-secret.mjs";
import { createHandler, type SweepStatus, type SwitchStatus } from "./handler.ts";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const blink = new Map(blinkAccounts(Deno.env).map((a) => [a.label, a]));
const btcpay = btcpaySwitchConfig(Deno.env);
const tgToken = (Deno.env.get("ALERT_TELEGRAM_BOT_TOKEN") ?? "").trim();
const tgChat = (Deno.env.get("ALERT_TELEGRAM_CHAT_ID") ?? "").trim();
const lnurlFetch = guardedFetch(fetch, denoResolver());

async function rpc(name: string, args: Record<string, unknown> = {}) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}
function account(label: string) {
  const a = blink.get(label);
  if (!a) throw new Error(`Blink #${label} has no API key`);
  return a;
}

Deno.serve(createHandler({
  cronSecret: configuredCronSecret((name) => Deno.env.get(name), "BLINK_SWEEP_CRON_SECRET").trim(),
  accounts: [...blink.keys()],
  async config() {
    const c = (await rpc("system_blink_sweep_config")) ?? {};
    const cents = (v: unknown, dflt: number) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) : dflt);
    return {
      enabled: c.enabled === true,
      receiveSwitch: c.receive_switch === true,
      switchBelowCents: cents(c.switch_below_usd, 5000),
      keepCents: cents(c.keep_usd, 0),
      minCents: cents(c.min_usd, 500),
      maxCents: cents(c.max_usd, 20000),
      destination: typeof c.destination === "string" ? c.destination : null,
    };
  },
  async open() {
    const rows = await rpc("system_blink_sweep_open_all");
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      id: r.id, account: String(r.account), walletId: r.blink_wallet_id, bolt11: r.bolt11, destination: r.destination,
      amountCents: Number(r.amount_cents), expiresAtMs: new Date(r.invoice_expires_at).getTime(),
    }));
  },
  usdWallet: (label) => usdWallet(fetch, account(label)),
  usdToSats: (label, cents) => usdToSats(fetch, account(label), cents),
  async invoice(address, amountMsat) {
    const addr = parseLightningAddress(address)!;
    const pay = await fetchPayRequest(addr, lnurlFetch);
    return (await requestInvoice(pay, amountMsat, { network: "bitcoin", nowMs: Date.now() }, lnurlFetch)).invoice;
  },
  async begin(b) {
    const id = await rpc("system_blink_sweep_begin", {
      p_amount_cents: b.amountCents, p_amount_sat: b.amountSat, p_destination: b.destination,
      p_blink_wallet_id: b.walletId, p_bolt11: b.bolt11, p_payment_hash: b.paymentHash,
      p_invoice_expires_at: new Date(b.expiresAtMs).toISOString(), p_account: b.account,
    });
    return typeof id === "string" ? id : null;
  },
  async finish(id: string, status: SweepStatus, error: string | null) {
    await rpc("system_blink_sweep_finish", { p_id: id, p_status: status, p_error: error });
  },
  pay: (label, walletId, bolt11) => payInvoice(fetch, account(label), walletId, bolt11, "CPAY wallet top-up"),
  async note(label, n) {
    await rpc("system_blink_sweep_note_account", {
      p_account: label, p_balance_cents: n.balanceCents, p_can_send: n.canSend,
      p_withdraw_remaining_cents: n.withdrawRemainingCents, p_result: n.result,
    });
  },
  canSwitch: btcpay !== null,
  async receiving(usdWalletIds) {
    const conn = await getLightningConnection(fetch, btcpay!);
    return receivingAccount(conn, [...blink.values()], usdWalletIds) ?? { account: null, keyKind: null };
  },
  async switchTo(label, usdWalletId) {
    const c = connectionString(account(label), usdWalletId);
    await setLightningConnection(fetch, btcpay!, c.value);
    return c.keyKind;
  },
  async receiveNote(r, result) {
    await rpc("system_blink_receive_note", { p_account: r.account, p_key_kind: r.keyKind, p_result: result });
  },
  async switchBegin(from, to) {
    const id = await rpc("system_blink_switch_begin", { p_from: from, p_to: to });
    return typeof id === "string" ? id : null;
  },
  async switchFinish(id: string, status: SwitchStatus, error: string | null) {
    await rpc("system_blink_switch_finish", { p_id: id, p_status: status, p_error: error });
  },
  async rescueCandidates() {
    const rows = await rpc("system_blink_rescue_candidates");
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      paymentId: String(r.payment_id), bolt11: String(r.bolt11), amountUsd: String(r.amount_usd), account: String(r.account),
    }));
  },
  invoicePaid: (label, paymentHash) => invoicePaid(fetch, account(label), paymentHash),
  async rescueSettle(paymentId, label, amountSat) {
    return String(await rpc("system_blink_rescue_settle", { p_payment_id: paymentId, p_account: label, p_amount_sat: amountSat }));
  },
  async alert(text) {
    if (!tgToken || !tgChat) return;
    // Fixed host on purpose: the bot token is only ever sent to Telegram.
    const r = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: tgChat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
    await r.body?.cancel();
  },
  now: () => Date.now(),
}));
