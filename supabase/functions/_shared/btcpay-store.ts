// BTCPay Server Greenfield: read and change the 'cpay' store's Lightning
// connection, for the BTCPay receive switch (docs/BLINK-SWEEP.md). Only
// blink-sweep uses this file.
//
// A separate key on purpose: BTCPAY_API_KEY (_shared/btcpay.ts) stays
// create + view invoices only. BTCPAY_SWITCH_API_KEY needs
// btcpay.store.canmodifystoresettings on the 'cpay' store; it is sent only to
// BTCPAY_URL and never logged.
import { type BtcpayConfig, btcpayConfig } from "./btcpay.ts";

type Env = { get(name: string): string | undefined };
type Fetch = typeof fetch;

/** BTCPAY_URL + BTCPAY_STORE_ID with BTCPAY_SWITCH_API_KEY; null when any is missing or bad. */
export function btcpaySwitchConfig(env: Env): BtcpayConfig | null {
  const key = (env.get("BTCPAY_SWITCH_API_KEY") ?? "").trim();
  if (!key) return null;
  return btcpayConfig({ get: (n) => (n === "BTCPAY_API_KEY" ? key : env.get(n)) });
}

/** BTCPay 2.x id of the store's Lightning payment method. */
export const LIGHTNING = "BTC-LN";

async function call(f: Fetch, cfg: BtcpayConfig, method: "GET" | "PUT", path: string, body?: unknown) {
  const res = await f(`${cfg.url}/api/v1/stores/${encodeURIComponent(cfg.storeId)}${path}`, {
    method,
    headers: { Authorization: `token ${cfg.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`BTCPay ${method} Lightning settings: HTTP ${res.status}${res.status === 403 ? " (BTCPAY_SWITCH_API_KEY needs Modify store settings)" : ""}`);
  }
  return await res.json().catch(() => null);
}

// deno-lint-ignore no-explicit-any
function connectionOf(body: any): string | null {
  const c = body?.config;
  const s = typeof c === "string" ? c : typeof c?.connectionString === "string" ? c.connectionString : null;
  return s && s.trim() ? s.trim() : null;
}

/** The store's Lightning connection string; null when Lightning is off or not set. */
export async function getLightningConnection(f: Fetch, cfg: BtcpayConfig): Promise<string | null> {
  const body = await call(f, cfg, "GET", `/payment-methods/${LIGHTNING}?includeConfig=true`);
  if (body?.enabled === false) return null;
  return connectionOf(body);
}

/** Point the store's Lightning at a new connection string (and keep it on). */
export async function setLightningConnection(f: Fetch, cfg: BtcpayConfig, connectionString: string): Promise<void> {
  await call(f, cfg, "PUT", `/payment-methods/${LIGHTNING}`, { enabled: true, config: { connectionString } });
}
