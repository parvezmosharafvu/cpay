// blink-sweep Edge Function: wiring only; the rules are in handler.ts
// (tested by handler_test.ts). docs/BLINK-SWEEP.md.
//
// Moves the Blink USD balance (where BTCPay's Blink Lightning payments land)
// into the primary CPAY wallet, through that wallet's own Lightning address.
//
// Secrets / env (names only):
//   BLINK_API_KEY                 Blink API key with Read + Write
//   BLINK_API_URL                 optional, Blink hosts only (staging)
//   BLINK_SWEEP_CRON_SECRET       optional, else CRON_SECRET (x-cron-secret)
//   ALERT_TELEGRAM_BOT_TOKEN, ALERT_TELEGRAM_CHAT_ID   optional alerts
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY            (set by Supabase)
// verify_jwt = false (pg_cron sends x-cron-secret instead).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.3";
import { blinkConfig, payInvoice, usdToSats, usdWallet } from "../_shared/blink.ts";
import { denoResolver, fetchPayRequest, guardedFetch, parseLightningAddress, requestInvoice } from "../_shared/lnurl.ts";
import { configuredCronSecret } from "../_shared/scoped-cron-secret.mjs";
import { createHandler, type SweepStatus } from "./handler.ts";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const blink = blinkConfig(Deno.env);
const tgToken = (Deno.env.get("ALERT_TELEGRAM_BOT_TOKEN") ?? "").trim();
const tgChat = (Deno.env.get("ALERT_TELEGRAM_CHAT_ID") ?? "").trim();
const lnurlFetch = guardedFetch(fetch, denoResolver());

async function rpc(name: string, args: Record<string, unknown> = {}) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}

Deno.serve(createHandler({
  cronSecret: configuredCronSecret((name) => Deno.env.get(name), "BLINK_SWEEP_CRON_SECRET").trim(),
  configured: blink !== null,
  async config() {
    const c = (await rpc("system_blink_sweep_config")) ?? {};
    const cents = (v: unknown, dflt: number) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) : dflt);
    return {
      enabled: c.enabled === true,
      keepCents: cents(c.keep_usd, 0),
      minCents: cents(c.min_usd, 500),
      maxCents: cents(c.max_usd, 20000),
      destination: typeof c.destination === "string" ? c.destination : null,
    };
  },
  async open() {
    const r = await rpc("system_blink_sweep_open");
    if (!r || !r.id) return null;
    return {
      id: r.id, walletId: r.blink_wallet_id, bolt11: r.bolt11, destination: r.destination,
      amountCents: Number(r.amount_cents), expiresAtMs: new Date(r.invoice_expires_at).getTime(),
    };
  },
  usdWallet: () => usdWallet(fetch, blink!),
  usdToSats: (cents) => usdToSats(fetch, blink!, cents),
  async invoice(address, amountMsat) {
    const addr = parseLightningAddress(address)!;
    const pay = await fetchPayRequest(addr, lnurlFetch);
    return (await requestInvoice(pay, amountMsat, { network: "bitcoin", nowMs: Date.now() }, lnurlFetch)).invoice;
  },
  async begin(b) {
    const id = await rpc("system_blink_sweep_begin", {
      p_amount_cents: b.amountCents, p_amount_sat: b.amountSat, p_destination: b.destination,
      p_blink_wallet_id: b.walletId, p_bolt11: b.bolt11, p_payment_hash: b.paymentHash,
      p_invoice_expires_at: new Date(b.expiresAtMs).toISOString(),
    });
    return typeof id === "string" ? id : null;
  },
  async finish(id: string, status: SweepStatus, error: string | null) {
    await rpc("system_blink_sweep_finish", { p_id: id, p_status: status, p_error: error });
  },
  pay: (walletId, bolt11) => payInvoice(fetch, blink!, walletId, bolt11, "CPAY wallet top-up"),
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
