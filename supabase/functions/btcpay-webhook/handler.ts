// btcpay-webhook logic (docs/BTCPAY.md). index.ts only wires it up.
//
// 1. Verify BTCPay-Sig (HMAC-SHA256 of the raw body) against every
//    configured secret. Bad or missing signature: 401.
// 2. Only the configured 'cpay' store; other stores are ignored (200).
// 3. Never trust the body: re-fetch the invoice and its payment methods from
//    the Greenfield API before recording anything.
// 4. InvoiceSettled -> system_settle_gateway_invoice (dedupe per invoice,
//    platform fee and auto withdraw exactly like a wallet-settled payment).
//    'unknown' answers 404 so BTCPay retries (the row may not be attached
//    yet). InvoiceExpired / InvoiceInvalid -> system_close_gateway_invoice.
// 5. Telegram alert (best effort, never blocks the answer).
// Nothing here sends money.
import {
  type BtcpayConfig, type BtcpayInvoice, type BtcpayPaymentMethod, orderIdFor, settledFigures, verifyBtcpaySig,
} from "../_shared/btcpay.ts";

export type SettleOutcome =
  | "settled" | "already_settled" | "duplicate" | "unknown" | "mismatch" | "underpaid" | "not_settleable";

export type Deps = {
  config: BtcpayConfig | null;
  secrets: string[];
  getInvoice(id: string): Promise<BtcpayInvoice>;
  getPaymentMethods(id: string): Promise<BtcpayPaymentMethod[]>;
  settle(a: { invoiceId: string; paymentId: string | null; paidUsd: string; amountSat: number; method: string | null }): Promise<SettleOutcome | undefined>;
  close(invoiceId: string, status: "expired" | "invalid"): Promise<string | undefined>;
  alert(text: string): Promise<void>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVOICE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export function createHandler(d: Deps) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const raw = new Uint8Array(await req.arrayBuffer());
    if (raw.length > 64 * 1024) return json({ error: "Too large" }, 413);
    if (!d.config || d.secrets.length === 0) {
      console.error("btcpay-webhook: BTCPAY_URL / BTCPAY_STORE_ID / BTCPAY_API_KEY / BTCPAY_WEBHOOK_SECRET not set");
      return json({ error: "Not configured" }, 503);
    }
    if (!(await verifyBtcpaySig(raw, req.headers.get("BTCPay-Sig"), d.secrets))) {
      return json({ error: "Bad signature" }, 401);
    }
    let ev: { type?: unknown; invoiceId?: unknown; storeId?: unknown; deliveryId?: unknown };
    try { ev = JSON.parse(new TextDecoder().decode(raw)); } catch { return json({ error: "Invalid JSON" }, 400); }
    const type = String(ev.type ?? "");
    const invoiceId = String(ev.invoiceId ?? "");
    if (ev.storeId !== undefined && String(ev.storeId) !== d.config.storeId) return json({ ignored: "other store" });
    if (!["InvoiceSettled", "InvoiceExpired", "InvoiceInvalid"].includes(type)) return json({ ignored: type || "no type" });
    if (!INVOICE_ID.test(invoiceId)) return json({ error: "Bad invoice id" }, 400);

    let inv: BtcpayInvoice;
    try { inv = await d.getInvoice(invoiceId); } catch (e) {
      console.error("btcpay-webhook: invoice re-fetch failed:", (e as Error).message);
      return json({ error: "Could not verify the invoice" }, 502); // BTCPay retries
    }
    if (inv.id !== invoiceId || (inv.storeId && inv.storeId !== d.config.storeId)) return json({ error: "Invoice mismatch" }, 400);
    const meta = inv.metadata ?? {};
    const paymentId = typeof meta.cpayPaymentId === "string" && UUID.test(meta.cpayPaymentId) ? meta.cpayPaymentId : null;
    if (!paymentId || meta.orderId !== orderIdFor(paymentId)) return json({ ignored: "not a CPAY invoice" });

    if (type === "InvoiceExpired" || type === "InvoiceInvalid") {
      const want = type === "InvoiceExpired" ? "Expired" : "Invalid";
      if (inv.status !== want) return json({ ignored: `invoice is ${inv.status}` });
      const out = await d.close(invoiceId, want === "Expired" ? "expired" : "invalid");
      if (out === undefined) return json({ error: "Temporarily unavailable" }, 503);
      if (out === "unknown") return json({ error: "Unknown invoice" }, 404);
      return json({ ok: true, outcome: out });
    }

    if (inv.status !== "Settled") return json({ ignored: `invoice is ${inv.status}` });
    let methods: BtcpayPaymentMethod[] = [];
    try { methods = await d.getPaymentMethods(invoiceId); } catch (e) {
      console.error("btcpay-webhook: payment-methods re-fetch failed:", (e as Error).message);
      return json({ error: "Could not verify the payment" }, 502);
    }
    const fig = settledFigures(inv, methods);
    if (!fig.paidUsd) {
      void d.alert(`⚠️ BTCPay invoice ${invoiceId} settled but is not priced in USD (${inv.currency}). Not recorded.`).catch(() => {});
      return json({ ignored: "not USD" });
    }
    const outcome = await d.settle({ invoiceId, paymentId, paidUsd: fig.paidUsd, amountSat: fig.amountSat, method: fig.method });
    if (outcome === undefined) return json({ error: "Temporarily unavailable" }, 503);
    if (outcome === "unknown") return json({ error: "Unknown invoice" }, 404);
    if (outcome === "settled") {
      const where = fig.onchain
        ? "on-chain (lands in the BTCPay on-chain wallet, not the CPAY Lightning balance)"
        : "Lightning";
      void d.alert(`✅ BTCPay payment $${fig.paidUsd} settled via ${where}. Invoice ${invoiceId}, ${fig.amountSat} sats.`).catch(() => {});
    } else if (outcome === "underpaid" || outcome === "mismatch" || outcome === "not_settleable") {
      void d.alert(`⚠️ BTCPay invoice ${invoiceId} settled in BTCPay but CPAY answered "${outcome}". Check it in Admin.`).catch(() => {});
    }
    return json({ ok: true, outcome });
  };
}
