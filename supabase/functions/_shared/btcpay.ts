// BTCPay Server Greenfield client for CPAY (docs/BTCPAY.md).
//
// RECEIVE ONLY. This file can create and read invoices on the 'cpay' store
// and nothing else: no payouts, pull payments, refunds or wallet sends.
// Every send stays in the CPAY wallet / payment-service.
//
// Secrets (names only, set by the owner):
//   BTCPAY_URL              e.g. https://btcpay.example.com (https only)
//   BTCPAY_STORE_ID         the 'cpay' store id
//   BTCPAY_API_KEY          Greenfield key with ONLY btcpay.store.cancreateinvoice
//                           + btcpay.store.canviewinvoices on that store
//   BTCPAY_WEBHOOK_SECRET   the store webhook's secret (+ _2 … _5 while rotating)

export type BtcpayConfig = { url: string; storeId: string; apiKey: string };

type Env = { get(name: string): string | undefined };

export function btcpayConfig(env: Env): BtcpayConfig | null {
  const raw = (env.get("BTCPAY_URL") ?? "").trim().replace(/\/+$/, "");
  const storeId = (env.get("BTCPAY_STORE_ID") ?? "").trim();
  const apiKey = (env.get("BTCPAY_API_KEY") ?? "").trim();
  if (!raw || !storeId || !apiKey) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return null;
  if (u.username || u.password || u.search || u.hash) return null;
  if (!/^[A-Za-z0-9]{8,64}$/.test(storeId)) return null;
  return { url: u.origin + u.pathname.replace(/\/+$/, ""), storeId, apiKey };
}

/** Every configured webhook secret: BTCPAY_WEBHOOK_SECRET, then _2 … _5. */
export function webhookSecrets(env: Env): string[] {
  return ["", "_2", "_3", "_4", "_5"]
    .map((s) => (env.get(`BTCPAY_WEBHOOK_SECRET${s}`) ?? "").trim())
    .filter((s) => s.length > 0);
}

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");

export async function hmacSha256Hex(secret: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new Uint8Array(body)));
}

function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/**
 * BTCPay-Sig is "sha256=<hex HMAC of the raw body>". Accept a match with any
 * configured secret (so a secret can be rotated without downtime). No secret
 * configured = refuse everything.
 */
export async function verifyBtcpaySig(rawBody: Uint8Array, header: string | null, secrets: string[]): Promise<boolean> {
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec(String(header ?? "").trim());
  if (!m || secrets.length === 0) return false;
  const got = m[1].toLowerCase();
  let ok = false;
  for (const s of secrets) if (sameHex(await hmacSha256Hex(s, rawBody), got)) ok = true;
  return ok;
}

export type BtcpayInvoice = {
  id: string;
  storeId?: string;
  status: string; // New | Processing | Settled | Expired | Invalid
  additionalStatus?: string;
  amount: string;
  currency: string;
  checkoutLink?: string;
  metadata?: Record<string, unknown>;
};

export type BtcpayPaymentMethod = {
  paymentMethodId?: string; // "BTC-LN", "BTC-CHAIN" (2.x); "BTC-LightningNetwork", "BTC" (1.x)
  paymentMethod?: string;
  destination?: string;
  paymentLink?: string;
  amount?: string; // due, in BTC
  totalPaid?: string; // in BTC
  activated?: boolean;
};

export class BtcpayError extends Error {
  constructor(public status: number, what: string) { super(`BTCPay ${what}: HTTP ${status}`); }
}

type Fetch = typeof fetch;

async function call<T>(f: Fetch, cfg: BtcpayConfig, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await f(`${cfg.url}/api/v1/stores/${encodeURIComponent(cfg.storeId)}${path}`, {
    method,
    headers: { Authorization: `token ${cfg.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) { await res.body?.cancel(); throw new BtcpayError(res.status, `${method} ${path.split("/")[1] ?? ""}`); }
  return await res.json() as T;
}

// Short on purpose: BTCPay's default Lightning description template is
// "Paid to {StoreName} (Order ID: {OrderId})", so a long orderId (the old
// "cpay:<uuid>") made the BOLT11 ~506 chars and some exchanges rejected it.
// The full payment id travels in metadata.cpayPaymentId instead.
export const orderIdFor = (paymentId: string) => `cp${paymentId.replace(/-/g, "").slice(0, 8)}`;
/** Pre-fix invoices (still open at deploy time) carried the long form. */
export const legacyOrderIdFor = (paymentId: string) => `cpay:${paymentId}`;
export const isCpayOrderId = (orderId: unknown, paymentId: string) =>
  orderId === orderIdFor(paymentId) || orderId === legacyOrderIdFor(paymentId);

/**
 * The Greenfield create-invoice body.
 * lightningOnly (Admin setting btcpay_lightning_only, default true) mirrors
 * boltpay's request exactly: amount, currency, checkout {expirationMinutes,
 * paymentMethods ["BTC-LN"], defaultPaymentMethod "BTC-LN"}, metadata
 * {orderId, <link id>}, plus cpayPaymentId which the webhook needs. No
 * itemDesc, no redirectURL. Otherwise every store method is offered.
 */
export function invoiceRequest(p: { paymentId: string; linkId: string; slug: string; amountCents: number; expiresMinutes: number; redirectUrl?: string; lightningOnly?: boolean }) {
  const lnOnly = p.lightningOnly !== false;
  const metadata: Record<string, string> = { orderId: orderIdFor(p.paymentId), cpayPaymentId: p.paymentId, cpayLinkId: p.linkId };
  if (!lnOnly) metadata.itemDesc = "cpay payment";
  const checkout: Record<string, unknown> = lnOnly
    ? { expirationMinutes: p.expiresMinutes, paymentMethods: ["BTC-LN"], defaultPaymentMethod: "BTC-LN" }
    : { expirationMinutes: p.expiresMinutes, ...(p.redirectUrl ? { redirectURL: p.redirectUrl, redirectAutomatically: false } : {}) };
  return { amount: (p.amountCents / 100).toFixed(2), currency: "USD", checkout, metadata };
}

export const createInvoice = (f: Fetch, cfg: BtcpayConfig, body: ReturnType<typeof invoiceRequest>) =>
  call<BtcpayInvoice>(f, cfg, "POST", "/invoices", body);
export const getInvoice = (f: Fetch, cfg: BtcpayConfig, id: string) =>
  call<BtcpayInvoice>(f, cfg, "GET", `/invoices/${encodeURIComponent(id)}`);
export const getPaymentMethods = (f: Fetch, cfg: BtcpayConfig, id: string) =>
  call<BtcpayPaymentMethod[]>(f, cfg, "GET", `/invoices/${encodeURIComponent(id)}/payment-methods`);

const methodId = (m: BtcpayPaymentMethod) => String(m.paymentMethodId ?? m.paymentMethod ?? "");
const isLightning = (m: BtcpayPaymentMethod) => /^BTC-(LN|LightningNetwork)$/i.test(methodId(m));
const isOnchain = (m: BtcpayPaymentMethod) => /^(BTC|BTC-CHAIN|BTC-OnChain)$/i.test(methodId(m));

/** What the pay page shows: the Lightning invoice and the on-chain address, when the store offers them. */
export function payDetails(methods: BtcpayPaymentMethod[]) {
  const ln = methods.find((m) => isLightning(m) && m.activated !== false && typeof m.destination === "string");
  const oc = methods.find((m) => isOnchain(m) && m.activated !== false && typeof m.destination === "string");
  const lnDest = ln ? ln.destination!.trim().replace(/^lightning:/i, "") : "";
  const bolt11 = /^ln[a-z0-9]+$/i.test(lnDest) ? lnDest.toLowerCase() : null;
  return {
    bolt11,
    onchainAddress: oc?.destination ?? null,
    bitcoinUri: oc?.paymentLink && /^bitcoin:/i.test(oc.paymentLink) ? oc.paymentLink : null,
  };
}

/** BTC decimal string -> integer sats, exact (no float). */
export function btcToSats(v: unknown): number {
  const m = /^(\d+)(?:\.(\d{0,8})\d*)?$/.exec(String(v ?? "").trim());
  if (!m) return 0;
  return Number(BigInt(m[1]) * 100_000_000n + BigInt((m[2] ?? "").padEnd(8, "0") || "0"));
}

/** Paid USD (the invoice's own USD price), sats received, and the method used. */
export function settledFigures(inv: BtcpayInvoice, methods: BtcpayPaymentMethod[]) {
  let sats = 0;
  let best = { id: "", sats: 0 };
  for (const m of methods) {
    const s = btcToSats(m.totalPaid);
    sats += s;
    if (s > best.sats) best = { id: methodId(m), sats: s };
  }
  const usd = inv.currency?.toUpperCase() === "USD" && /^\d+(\.\d+)?$/.test(String(inv.amount)) ? String(inv.amount) : null;
  // A BTCPay plugin may add payment methods other than BTC Lightning or
  // BTC on-chain. Do not describe an unknown method as Lightning or assume
  // the funds reached the CPAY wallet. Reporting only: settlement unchanged.
  const rail = !best.id ? "unreported"
    : /^BTC-(LN|LightningNetwork)$/i.test(best.id) ? "lightning"
    : /^(BTC|BTC-CHAIN|BTC-OnChain)$/i.test(best.id) ? "onchain"
    : "plugin";
  return { paidUsd: usd, amountSat: sats, method: best.id || null, onchain: rail === "onchain", rail };

}
