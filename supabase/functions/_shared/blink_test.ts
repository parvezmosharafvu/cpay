import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { BlinkError, payInvoice, usdToSats, usdWallet } from "./blink.ts";

const cfg = { url: "https://api.blink.sv/graphql", apiKey: "secret-key" };
function fake(answer: unknown, status = 200) {
  const seen: { url: string; key: string | null; body: { query: string; variables: Record<string, unknown> } }[] = [];
  const f = ((url: string, init: RequestInit) => {
    seen.push({ url, key: new Headers(init.headers).get("X-API-KEY"), body: JSON.parse(String(init.body)) });
    return Promise.resolve(new Response(JSON.stringify(answer), { status }));
  }) as unknown as typeof fetch;
  return { f, seen };
}

Deno.test("usdWallet: picks the USD wallet, reads WRITE and Blink's withdrawal limit; key goes only to the configured URL", async () => {
  const { f, seen } = fake({ data: { authorization: { scopes: ["READ", "RECEIVE", "WRITE"] }, me: { defaultAccount: {
    wallets: [{ id: "btc1", walletCurrency: "BTC", balance: 5000 }, { id: "usd1", walletCurrency: "USD", balance: 1234 }],
    limits: { withdrawal: [{ remainingLimit: 50000, totalLimit: 99900 }] },
  } } } });
  assertEquals(await usdWallet(f, cfg), { id: "usd1", balanceCents: 1234, canSend: true, withdrawRemainingCents: 50000 });
  assertEquals(seen[0].url, cfg.url);
  assertEquals(seen[0].key, "secret-key");
});

Deno.test("usdWallet: Read + Receive key cannot send; no limit reported is null", async () => {
  const { f } = fake({ data: { authorization: { scopes: ["READ", "RECEIVE"] }, me: { defaultAccount: {
    wallets: [{ id: "usd1", walletCurrency: "USD", balance: 0 }], limits: { withdrawal: [{ remainingLimit: null, totalLimit: 0 }] },
  } } } });
  assertEquals(await usdWallet(f, cfg), { id: "usd1", balanceCents: 0, canSend: false, withdrawRemainingCents: null });
});

Deno.test("usdWallet: no USD wallet, GraphQL errors and HTTP errors throw", async () => {
  await assertRejects(() => usdWallet(fake({ data: { me: { defaultAccount: { wallets: [] } } } }).f, cfg), BlinkError, "no USD wallet");
  await assertRejects(() => usdWallet(fake({ errors: [{ message: "Not authorized" }] }).f, cfg), BlinkError, "Not authorized");
  await assertRejects(() => usdWallet(fake({}, 401).f, cfg), BlinkError, "401");
});

Deno.test("usdToSats: sends dollars, returns whole sats", async () => {
  const { f, seen } = fake({ data: { currencyConversionEstimation: { btcSatAmount: 1500.7 } } });
  assertEquals(await usdToSats(f, cfg, 150), 1500);
  assertEquals(seen[0].body.variables, { amount: 1.5, currency: "USD" });
});

Deno.test("payInvoice: statuses pass through; unknown or missing status is a failure with a reason", async () => {
  const ok = fake({ data: { lnInvoicePaymentSend: { status: "SUCCESS", errors: [] } } });
  assertEquals(await payInvoice(ok.f, cfg, "usd1", "lnbc1x", "memo"), { status: "SUCCESS", error: null });
  assertEquals(ok.seen[0].body.variables, { input: { walletId: "usd1", paymentRequest: "lnbc1x", memo: "memo" } });
  const paid = fake({ data: { lnInvoicePaymentSend: { status: "ALREADY_PAID", errors: [] } } });
  assertEquals((await payInvoice(paid.f, cfg, "usd1", "lnbc1x", "m")).status, "ALREADY_PAID");
  const bad = fake({ data: { lnInvoicePaymentSend: { status: "FAILURE", errors: [{ message: "Insufficient balance" }] } } });
  assertEquals(await payInvoice(bad.f, cfg, "usd1", "lnbc1x", "m"), { status: "FAILURE", error: "Insufficient balance" });
  const odd = fake({ data: { lnInvoicePaymentSend: { status: "WHAT" } } });
  assertEquals(await payInvoice(odd.f, cfg, "usd1", "lnbc1x", "m"), { status: "FAILURE", error: "Blink did not confirm the payment" });
});
