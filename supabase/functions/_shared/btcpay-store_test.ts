import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { btcpaySwitchConfig, getLightningConnection, setLightningConnection } from "./btcpay-store.ts";

const env = (o: Record<string, string>) => ({ get: (k: string) => o[k] });
const base = { BTCPAY_URL: "https://pay.example.com", BTCPAY_STORE_ID: "Store1234", BTCPAY_API_KEY: "invoice-key" };
const cfg = { url: "https://pay.example.com", storeId: "Store1234", apiKey: "switch-key" };

function fake(answer: unknown, status = 200) {
  const seen: { url: string; method: string; auth: string | null; body: unknown }[] = [];
  const f = ((url: string, init: RequestInit) => {
    seen.push({ url, method: String(init.method), auth: new Headers(init.headers).get("Authorization"), body: init.body ? JSON.parse(String(init.body)) : null });
    return Promise.resolve(new Response(JSON.stringify(answer), { status }));
  }) as unknown as typeof fetch;
  return { f, seen };
}

Deno.test("btcpaySwitchConfig: BTCPAY_SWITCH_API_KEY when set, else BTCPAY_API_KEY; needs URL and store", () => {
  assertEquals(btcpaySwitchConfig(env(base)), { url: "https://pay.example.com", storeId: "Store1234", apiKey: "invoice-key" });
  assertEquals(btcpaySwitchConfig(env({ ...base, BTCPAY_SWITCH_API_KEY: " sk " })), { url: "https://pay.example.com", storeId: "Store1234", apiKey: "sk" });
  assertEquals(btcpaySwitchConfig(env({ ...base, BTCPAY_API_KEY: "" })), null);
  assertEquals(btcpaySwitchConfig(env({ BTCPAY_SWITCH_API_KEY: "sk" })), null);
  assertEquals(btcpaySwitchConfig(env({ ...base, BTCPAY_URL: "http://pay.example.com", BTCPAY_SWITCH_API_KEY: "sk" })), null);
});

Deno.test("getLightningConnection: reads BTC-LN with its config; off or unset is null", async () => {
  const on = fake({ enabled: true, paymentMethodId: "BTC-LN", config: { connectionString: "type=blink;api-key=k" } });
  assertEquals(await getLightningConnection(on.f, cfg), "type=blink;api-key=k");
  assertEquals(on.seen[0].url, "https://pay.example.com/api/v1/stores/Store1234/payment-methods/BTC-LN?includeConfig=true");
  assertEquals(on.seen[0].auth, "token switch-key");
  assertEquals(await getLightningConnection(fake({ enabled: true, config: "type=blink;api-key=k" }).f, cfg), "type=blink;api-key=k");
  assertEquals(await getLightningConnection(fake({ enabled: false, config: { connectionString: "x" } }).f, cfg), null);
  assertEquals(await getLightningConnection(fake({ enabled: true, config: {} }).f, cfg), null);
  await assertRejects(() => getLightningConnection(fake({}, 403).f, cfg), Error, "Modify store settings");
});

Deno.test("setLightningConnection: PUT keeps Lightning on with the new connection string", async () => {
  const { f, seen } = fake({ enabled: true });
  await setLightningConnection(f, cfg, "type=blink;api-key=k2;wallet-id=w2");
  assertEquals(seen[0].method, "PUT");
  assertEquals(seen[0].url, "https://pay.example.com/api/v1/stores/Store1234/payment-methods/BTC-LN");
  assertEquals(seen[0].body, { enabled: true, config: { connectionString: "type=blink;api-key=k2;wallet-id=w2" } });
  await assertRejects(() => setLightningConnection(fake({}, 422).f, cfg, "x"), Error, "HTTP 422");
});
