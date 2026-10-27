// Blink (blink.sv) GraphQL client for the Blink sweep (docs/BLINK-SWEEP.md).
// Only what the sweep needs: read the USD wallet, estimate USD → sats, and
// pay one Lightning invoice from the USD wallet. The API key is sent only to
// the fixed Blink host below.
export type Fetch = typeof fetch;
export type BlinkConfig = { url: string; apiKey: string };
export type PayStatus = "SUCCESS" | "ALREADY_PAID" | "PENDING" | "FAILURE";

const HOSTS = new Set(["api.blink.sv", "api.staging.blink.sv"]);
export const BLINK_URL = "https://api.blink.sv/graphql";

export class BlinkError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

type Env = { get(name: string): string | undefined };

/** BLINK_API_KEY (needed) and BLINK_API_URL (optional, Blink hosts only). */
export function blinkConfig(env: Env): BlinkConfig | null {
  const apiKey = (env.get("BLINK_API_KEY") ?? "").trim();
  if (!apiKey) return null;
  const raw = (env.get("BLINK_API_URL") ?? "").trim() || BLINK_URL;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !HOSTS.has(u.hostname) || u.pathname !== "/graphql") return null;
  return { url: u.toString(), apiKey };
}

async function gql(f: Fetch, cfg: BlinkConfig, query: string, variables: Record<string, unknown> = {}) {
  const res = await f(cfg.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": cfg.apiKey },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => null) as { data?: Record<string, unknown>; errors?: { message?: string }[] } | null;
  if (!res.ok || !body) throw new BlinkError("http", `Blink answered ${res.status}`);
  if (Array.isArray(body.errors) && body.errors.length) {
    throw new BlinkError("graphql", String(body.errors[0]?.message ?? "Blink error").slice(0, 200));
  }
  if (!body.data) throw new BlinkError("no_data", "Blink sent no data");
  return body.data;
}

/** The account's USD wallet: its id and balance in cents. */
export async function usdWallet(f: Fetch, cfg: BlinkConfig): Promise<{ id: string; balanceCents: number }> {
  const data = await gql(f, cfg, "query { me { defaultAccount { wallets { id walletCurrency balance } } } }");
  // deno-lint-ignore no-explicit-any
  const wallets = (data as any)?.me?.defaultAccount?.wallets;
  if (!Array.isArray(wallets)) throw new BlinkError("no_wallets", "Blink sent no wallets (check the API key has Read)");
  const usd = wallets.find((w) => w?.walletCurrency === "USD");
  if (!usd || typeof usd.id !== "string") throw new BlinkError("no_usd_wallet", "This Blink account has no USD wallet");
  const cents = Number(usd.balance);
  if (!Number.isSafeInteger(cents)) throw new BlinkError("bad_balance", "Blink sent an invalid USD balance");
  return { id: usd.id, balanceCents: cents };
}

/** Blink's own USD → sats estimate for an amount in cents. */
export async function usdToSats(f: Fetch, cfg: BlinkConfig, cents: number): Promise<number> {
  const data = await gql(
    f, cfg,
    "query Est($amount: Float!, $currency: DisplayCurrency!) { currencyConversionEstimation(amount: $amount, currency: $currency) { btcSatAmount } }",
    { amount: cents / 100, currency: "USD" },
  );
  // deno-lint-ignore no-explicit-any
  const sats = Number((data as any)?.currencyConversionEstimation?.btcSatAmount);
  if (!Number.isFinite(sats) || sats <= 0) throw new BlinkError("bad_estimate", "Blink sent an invalid price estimate");
  return Math.floor(sats);
}

/** Pay one invoice from the given wallet. Paying an invoice twice returns ALREADY_PAID. */
export async function payInvoice(f: Fetch, cfg: BlinkConfig, walletId: string, bolt11: string, memo: string): Promise<{ status: PayStatus; error: string | null }> {
  const data = await gql(
    f, cfg,
    "mutation Pay($input: LnInvoicePaymentInput!) { lnInvoicePaymentSend(input: $input) { status errors { message } } }",
    { input: { walletId, paymentRequest: bolt11, memo } },
  );
  // deno-lint-ignore no-explicit-any
  const out = (data as any)?.lnInvoicePaymentSend;
  const error = Array.isArray(out?.errors) && out.errors.length ? String(out.errors[0]?.message ?? "Blink error").slice(0, 200) : null;
  const status: PayStatus = ["SUCCESS", "ALREADY_PAID", "PENDING", "FAILURE"].includes(out?.status) ? out.status : "FAILURE";
  return { status, error: status === "FAILURE" ? (error ?? "Blink did not confirm the payment") : error };
}
