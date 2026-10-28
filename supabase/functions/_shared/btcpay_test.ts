import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { getPaymentDetailsWithRetry, invoiceRequest } from "./btcpay.ts";

const cfg = { url: "https://btcpay.example.test", storeId: "cpay", apiKey: "unit-test-placeholder" };
const url = "https://btcpay.example.test/api/v1/stores/cpay/invoices/inv-1/payment-methods";

function mock(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; auth: string | null }> = [];
  const fetcher = (async (request: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(request),
      method: init?.method ?? "GET",
      auth: new Headers(init?.headers).get("Authorization"),
    });
    const response = responses[Math.min(calls.length - 1, responses.length - 1)];
    return new Response(JSON.stringify(response.body), { status: response.status ?? 200 });
  }) as typeof fetch;
  return { fetcher, calls };
}

Deno.test("Boltpay parity: retries read-only GET until BTC-LN destination appears", async () => {
  const api = mock([
    { body: [] },
    { body: [{ paymentMethodId: "BTC-LN", destination: "lnbc1testinvoice" }] },
  ]);
  const result = await getPaymentDetailsWithRetry(api.fetcher, cfg, "inv-1", 0);
  assertEquals(result.bolt11, "lnbc1testinvoice");
  assertEquals(api.calls.length, 2);
  assertEquals(api.calls.every((c) => c.method === "GET" && c.url === url), true);
  assertEquals(api.calls.every((c) => c.auth === "token unit-test-placeholder"), true);
});

Deno.test("Boltpay parity: recovers from temporary Greenfield 503", async () => {
  const api = mock([
    { status: 503, body: { error: "temporarily unavailable" } },
    { body: [{ paymentMethodId: "BTC-LightningNetwork", destination: "lnbc1retry" }] },
  ]);
  const result = await getPaymentDetailsWithRetry(api.fetcher, cfg, "inv-1", 0);
  assertEquals(result.bolt11, "lnbc1retry");
  assertEquals(api.calls.length, 2);
});

Deno.test("Boltpay parity: stops at three reads; no duplicate invoice created", async () => {
  const api = mock([{ body: [] }]);
  const result = await getPaymentDetailsWithRetry(api.fetcher, cfg, "inv-1", 0);
  assertEquals(result.bolt11, null);
  assertEquals(api.calls.length, 3);
  assertEquals(api.calls.every((c) => c.method === "GET"), true);
});

Deno.test("Boltpay parity: already-ready BOLT11 needs only one GET", async () => {
  const api = mock([{ body: [{ paymentMethodId: "BTC-LN", destination: "lightning:LNBC1READY" }] }]);
  const result = await getPaymentDetailsWithRetry(api.fetcher, cfg, "inv-1", 0);
  assertEquals(result.bolt11, "lnbc1ready");
  assertEquals(api.calls.length, 1);
});

Deno.test("CPAY BTC-LN request preserves the tested Boltpay Greenfield contract", () => {
  const request = invoiceRequest({
    paymentId: "11111111-1111-4111-8111-111111111111",
    linkId: "22222222-2222-4222-8222-222222222222",
    slug: "payment-link",
    amountCents: 515,
    expiresMinutes: 5,
    lightningOnly: true,
  });
  assertEquals(request.amount, "5.15");
  assertEquals(request.currency, "USD");
  assertEquals(request.checkout, {
    expirationMinutes: 5, paymentMethods: ["BTC-LN"], defaultPaymentMethod: "BTC-LN",
  });
  assertEquals(request.metadata.cpayPaymentId, "11111111-1111-4111-8111-111111111111");
});
