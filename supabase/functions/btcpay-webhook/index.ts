// btcpay-webhook Edge Function: wiring only; the rules are in handler.ts
// (tested by handler_test.ts). docs/BTCPAY.md.
//
// Secrets / env (names only):
//   BTCPAY_URL, BTCPAY_STORE_ID, BTCPAY_API_KEY   (invoice create + view only)
//   BTCPAY_WEBHOOK_SECRET (+ _2 … _5)             the store webhook secret(s)
//   ALERT_TELEGRAM_BOT_TOKEN, ALERT_TELEGRAM_CHAT_ID   optional alerts
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY            (set by Supabase)
// verify_jwt = false (BTCPay signs with BTCPay-Sig instead).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.3";
import { btcpayConfig, getInvoice, getPaymentMethods, webhookSecrets } from "../_shared/btcpay.ts";
import { createHandler, type SettleOutcome } from "./handler.ts";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const config = btcpayConfig(Deno.env);
const tgToken = (Deno.env.get("ALERT_TELEGRAM_BOT_TOKEN") ?? "").trim();
const tgChat = (Deno.env.get("ALERT_TELEGRAM_CHAT_ID") ?? "").trim();

Deno.serve(createHandler({
  config,
  secrets: webhookSecrets(Deno.env),
  getInvoice: (id) => getInvoice(fetch, config!, id),
  getPaymentMethods: (id) => getPaymentMethods(fetch, config!, id),
  async settle(a) {
    const { data, error } = await sb.rpc("system_settle_gateway_invoice", {
      p_gateway: "btcpay", p_invoice_id: a.invoiceId, p_payment_id: a.paymentId,
      p_paid_usd: a.paidUsd, p_amount_sat: a.amountSat, p_payment_method: a.method,
    });
    if (error) { console.error("settle failed:", error.message); return undefined; }
    return data as SettleOutcome;
  },
  async close(invoiceId, status) {
    const { data, error } = await sb.rpc("system_close_gateway_invoice", { p_gateway: "btcpay", p_invoice_id: invoiceId, p_status: status });
    if (error) { console.error("close failed:", error.message); return undefined; }
    return String(data);
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
}));
