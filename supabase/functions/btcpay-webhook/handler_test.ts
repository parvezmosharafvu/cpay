import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createHandler, type Deps } from "./handler.ts";
import {
  btcpayConfig, btcToSats, hmacSha256Hex, invoiceRequest, isCpayOrderId, payDetails, settledFigures, verifyBtcpaySig, webhookSecrets,
} from "../_shared/btcpay.ts";

const PID = "11111111-2222-4333-8444-555555555555";
const cfg = { url: "https://btcpay.example.com", storeId: "StoreCpay123", apiKey: "k" };
const env = (o: Record<string, string>) => ({ get: (k: string) => o[k] });
const inv = (over: Record<string, unknown> = {}) => ({
  id: "INV1", storeId: cfg.storeId, status: "Settled", amount: "20.00", currency: "USD",
  metadata: { orderId: "cp" + PID.replace(/-/g, "").slice(0, 8), cpayPaymentId: PID }, ...over,
});

function deps(over: Partial<Deps> = {}) {
  const calls: { settle: unknown[]; close: unknown[]; alerts: string[] } = { settle: [], close: [], alerts: [] };
  const d: Deps = {
    config: cfg, secrets: ["s3cret"],
    getInvoice: () => Promise.resolve(inv()),
    getPaymentMethods: () => Promise.resolve([{ paymentMethodId: "BTC-LN", totalPaid: "0.00020000" }, { paymentMethodId: "BTC-CHAIN", totalPaid: "0" }]),
    settle: (a) => { calls.settle.push(a); return Promise.resolve("settled"); },
    close: (id, s) => { calls.close.push([id, s]); return Promise.resolve(s); },
    alert: (t) => { calls.alerts.push(t); return Promise.resolve(); },
    ...over,
  };
  return { h: createHandler(d), calls };
}

async function post(h: (r: Request) => Promise<Response>, body: unknown, secret = "s3cret", sig?: string) {
  const raw = new TextEncoder().encode(JSON.stringify(body));
  const s = sig ?? `sha256=${await hmacSha256Hex(secret, raw)}`;
  return h(new Request("http://x/btcpay-webhook", { method: "POST", body: raw, headers: { "BTCPay-Sig": s } }));
}
const settledEv = { type: "InvoiceSettled", invoiceId: "INV1", storeId: cfg.storeId, deliveryId: "d1" };

Deno.test("signature: missing, wrong and other-secret signatures are refused; any configured secret works", async () => {
  const { h, calls } = deps({ secrets: ["old", "new"] });
  assertEquals((await post(h, settledEv, "x", "")).status, 401);
  assertEquals((await post(h, settledEv, "wrong")).status, 401);
  assertEquals((await post(h, settledEv, "x", "sha256=" + "0".repeat(64))).status, 401);
  assertEquals(calls.settle.length, 0);
  assertEquals((await post(h, settledEv, "new")).status, 200);
  assertEquals((await post(h, settledEv, "old")).status, 200);
});

Deno.test("not configured: 503 and nothing recorded", async () => {
  const { h, calls } = deps({ config: null });
  assertEquals((await post(h, settledEv)).status, 503);
  assertEquals(calls.settle.length, 0);
});

Deno.test("settled: re-fetched figures are recorded, not the body; Telegram alert", async () => {
  const { h, calls } = deps();
  const r = await post(h, { ...settledEv, amount: "99999" });
  assertEquals(r.status, 200);
  assertEquals(calls.settle, [{ invoiceId: "INV1", paymentId: PID, paidUsd: "20.00", amountSat: 20000, method: "BTC-LN" }]);
  assert(calls.alerts[0].includes("Lightning"));
});

Deno.test("on-chain settle alert says it lands in the BTCPay on-chain wallet", async () => {
  const { h, calls } = deps({ getPaymentMethods: () => Promise.resolve([{ paymentMethodId: "BTC-CHAIN", totalPaid: "0.0003" }]) });
  await post(h, settledEv);
  assert(calls.alerts[0].includes("BTCPay on-chain wallet"));
});

Deno.test("plugin payment methods are not mislabeled as CPAY Lightning reserves", async () => {
  const plugin = deps({
    getPaymentMethods: () => Promise.resolve([{ paymentMethodId: "CUSTOM-ASSET", totalPaid: "0.0003" }]),
  });
  assertEquals((await post(plugin.h, settledEv)).status, 200);
  assertEquals(plugin.calls.settle.length, 1, "operator alert changes must not modify accounting");
  assertEquals((plugin.calls.settle[0] as { method?: string }).method, "CUSTOM-ASSET");
  assert(plugin.calls.alerts[0].includes("plugin/other payment method"));
  assert(!plugin.calls.alerts[0].includes("via Lightning"));

  const missing = deps({ getPaymentMethods: () => Promise.resolve([]) });
  assertEquals((await post(missing.h, settledEv)).status, 200);
  assert(missing.calls.alerts[0].includes("unreported BTCPay payment method"));
  assert(!missing.calls.alerts[0].includes("via Lightning"));

  const existingLightning = settledFigures(inv(), [{ paymentMethodId: "BTC-LN", totalPaid: "0.0002" }]);
  const existingChain = settledFigures(inv(), [{ paymentMethodId: "BTC-CHAIN", totalPaid: "0.0002" }]);
  assertEquals(existingLightning.rail, "lightning");
  assertEquals(existingChain.rail, "onchain");
  assertEquals(settledFigures(inv(), [{ paymentMethodId: "BTC-LNURL", totalPaid: "0.0002" }]).rail, "lightning");
  assertEquals(settledFigures(inv(), [{ paymentMethodId: "BTC-LNURLPAY", totalPaid: "0.0002" }]).rail, "lightning");
  assertEquals(settledFigures(inv(), [{ paymentMethodId: "CUSTOM-ASSET", totalPaid: "0.0002" }]).rail, "plugin");
  assertEquals(settledFigures(inv(), []).rail, "unreported");
});

Deno.test("body says settled but BTCPay says Processing: nothing recorded", async () => {
  const { h, calls } = deps({ getInvoice: () => Promise.resolve(inv({ status: "Processing" })) });
  assertEquals((await post(h, settledEv)).status, 200);
  assertEquals(calls.settle.length, 0);
});

Deno.test("other store, foreign invoice, non-CPAY metadata and other events are ignored", async () => {
  const { h, calls } = deps();
  await post(h, { ...settledEv, storeId: "OtherStore99" });
  await post(h, { ...settledEv, type: "InvoiceReceivedPayment" });
  const d2 = deps({ getInvoice: () => Promise.resolve(inv({ metadata: { orderId: "boltpay:x" } })) });
  await post(d2.h, settledEv);
  const d3 = deps({ getInvoice: () => Promise.resolve(inv({ storeId: "OtherStore99" })) });
  assertEquals((await post(d3.h, settledEv)).status, 400);
  assertEquals(calls.settle.length + d2.calls.settle.length + d3.calls.settle.length, 0);
});

Deno.test("unknown row: 404 so BTCPay retries; database error: 503; re-fetch error: 502", async () => {
  assertEquals((await post(deps({ settle: () => Promise.resolve("unknown") }).h, settledEv)).status, 404);
  assertEquals((await post(deps({ settle: () => Promise.resolve(undefined) }).h, settledEv)).status, 503);
  assertEquals((await post(deps({ getInvoice: () => Promise.reject(new Error("down")) }).h, settledEv)).status, 502);
});

Deno.test("duplicate delivery is a quiet 200 with no second alert", async () => {
  const { h, calls } = deps({ settle: () => Promise.resolve("duplicate") });
  const r = await post(h, settledEv);
  assertEquals(r.status, 200);
  assertEquals(calls.alerts.length, 0);
});

Deno.test("expired / invalid close the row only when BTCPay agrees", async () => {
  const exp = deps({ getInvoice: () => Promise.resolve(inv({ status: "Expired" })) });
  await post(exp.h, { ...settledEv, type: "InvoiceExpired" });
  assertEquals(exp.calls.close, [["INV1", "expired"]]);
  const lie = deps();
  await post(lie.h, { ...settledEv, type: "InvoiceInvalid" });
  assertEquals(lie.calls.close.length, 0);
});

Deno.test("btcpay client helpers", async () => {
  assertEquals(btcToSats("0.00012345"), 12345);
  assertEquals(btcToSats("1"), 100_000_000);
  assertEquals(btcToSats("bad"), 0);
  assertEquals(btcpayConfig(env({ BTCPAY_URL: "http://evil.example", BTCPAY_STORE_ID: "StoreCpay123", BTCPAY_API_KEY: "k" })), null);
  assertEquals(btcpayConfig(env({ BTCPAY_URL: "https://b.example/", BTCPAY_STORE_ID: "StoreCpay123", BTCPAY_API_KEY: "k" }))?.url, "https://b.example");
  assertEquals(webhookSecrets(env({ BTCPAY_WEBHOOK_SECRET: "a", BTCPAY_WEBHOOK_SECRET_3: "c" })), ["a", "c"]);
  const body = invoiceRequest({ paymentId: PID, linkId: "L", slug: "abc", amountCents: 1234, expiresMinutes: 60 });
  assertEquals(body.amount, "12.34");
  assertEquals(body.metadata.orderId, "cp" + PID.replace(/-/g, "").slice(0, 8));
  assert(body.metadata.orderId.length <= 12, "short orderId keeps the BOLT11 description short");
  assertEquals(body, {
    amount: "12.34", currency: "USD",
    checkout: { expirationMinutes: 60, paymentMethods: ["BTC-LN"], defaultPaymentMethod: "BTC-LN" },
    metadata: { orderId: body.metadata.orderId, cpayPaymentId: PID, cpayLinkId: "L" },
  }, "default request mirrors boltpay (BTC-LN only)");
  const open = invoiceRequest({ paymentId: PID, linkId: "L", slug: "abc", amountCents: 1234, expiresMinutes: 60, lightningOnly: false });
  assert(!("paymentMethods" in open.checkout), "on-chain re-enabled when lightningOnly is false");
  assertEquals(open.metadata.itemDesc, "cpay payment");
  assertEquals(payDetails([{ paymentMethodId: "BTC-LN", destination: " lightning:LNBC1XYZ ", activated: true }]).bolt11, "lnbc1xyz");
  assertEquals(body.currency, "USD");
  assertEquals(body.checkout.expirationMinutes, 60);
  assertEquals(body.metadata.cpayPaymentId, PID);
  const pd = payDetails([{ paymentMethodId: "BTC-LN", destination: "LNBC1ABCDEF", activated: true },
    { paymentMethodId: "BTC-CHAIN", destination: "bc1qxyz", paymentLink: "bitcoin:bc1qxyz?amount=0.1", activated: true }]);
  assertEquals(pd, { bolt11: "lnbc1abcdef", onchainAddress: "bc1qxyz", bitcoinUri: "bitcoin:bc1qxyz?amount=0.1" });
  assertEquals(settledFigures({ id: "i", status: "Settled", amount: "5", currency: "EUR" }, []).paidUsd, null);
  assert(!(await verifyBtcpaySig(new Uint8Array(), "sha256=" + "a".repeat(64), [])));
});

Deno.test("the BTCPay client never calls payout, pull-payment, refund or wallet endpoints", async () => {
  const src = await Deno.readTextFile(new URL("../_shared/btcpay.ts", import.meta.url)) + await Deno.readTextFile(new URL("./handler.ts", import.meta.url));
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  for (const bad of ["/payouts", "pull-payments", "/refund", "/wallet", "payment-requests"]) {
    assert(!code.includes(bad), `found ${bad}`);
  }
});

Deno.test("legacy long orderId (pre-fix open invoices) is still accepted", () => {
  assert(isCpayOrderId(`cpay:${PID}`, PID));
  assert(isCpayOrderId("cp" + PID.replace(/-/g, "").slice(0, 8), PID));
  assert(!isCpayOrderId("boltpay:x", PID));
});
