// Blink (blink.sv) GraphQL client for the Blink sweep (docs/BLINK-SWEEP.md).
// Only what the sweep needs: read the USD wallet, estimate USD → sats, pay
// one Lightning invoice from the USD wallet, check whether an invoice was paid, and build or read
// BTCPay's Blink connection string (receive switch). API keys are sent only
// to the fixed Blink host below (and, in a connection string, to BTCPay).
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

/** Up to 10 Blink accounts: BLINK_API_KEY is "1", BLINK_API_KEY_2 … _10 are "2" … "10". */
export const MAX_ACCOUNTS = 10;
/** receiveKey: optional BLINK_RECEIVE_KEY / _N (Read + Receive) of the same account, for BTCPay. */
export type BlinkAccount = BlinkConfig & { label: string; receiveKey: string | null };

function blinkUrl(env: Env): string | null {
  const raw = (env.get("BLINK_API_URL") ?? "").trim() || BLINK_URL;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !HOSTS.has(u.hostname) || u.pathname !== "/graphql") return null;
  return u.toString();
}

/** BLINK_API_KEY (needed) and BLINK_API_URL (optional, Blink hosts only). */
export function blinkConfig(env: Env): BlinkConfig | null {
  return blinkAccounts(env)[0] ?? null;
}

/** Every configured Blink account, in order. Empty when no key or a bad BLINK_API_URL. */
export function blinkAccounts(env: Env): BlinkAccount[] {
  const url = blinkUrl(env);
  if (!url) return [];
  const out: BlinkAccount[] = [];
  for (let i = 1; i <= MAX_ACCOUNTS; i++) {
    const apiKey = (env.get(i === 1 ? "BLINK_API_KEY" : `BLINK_API_KEY_${i}`) ?? "").trim();
    const receiveKey = (env.get(i === 1 ? "BLINK_RECEIVE_KEY" : `BLINK_RECEIVE_KEY_${i}`) ?? "").trim() || null;
    if (apiKey) out.push({ label: String(i), url, apiKey, receiveKey });
  }
  return out;
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

export type UsdWallet = {
  id: string;
  balanceCents: number;
  /** The key has WRITE (needed to send). */
  canSend: boolean;
  /** Cents Blink still lets this account withdraw in the rolling 24 hours; null = no limit reported. */
  withdrawRemainingCents: number | null;
};

// deno-lint-ignore no-explicit-any
function remaining(list: any): number | null {
  const values = (Array.isArray(list) ? list : []).map((l: { remainingLimit?: unknown }) => l?.remainingLimit)
    .filter((v: unknown) => v !== null && v !== undefined && Number.isFinite(Number(v)))
    .map((v: unknown) => Math.max(0, Math.floor(Number(v))));
  return values.length ? Math.min(...values) : null;
}

/** The account's USD wallet, the key's send permission and Blink's limits left. */
export async function usdWallet(f: Fetch, cfg: BlinkConfig): Promise<UsdWallet> {
  const data = await gql(
    f, cfg,
    "query { authorization { scopes } me { defaultAccount { wallets { id walletCurrency balance } limits { withdrawal { remainingLimit } } } } }",
  );
  // deno-lint-ignore no-explicit-any
  const d = data as any;
  const wallets = d?.me?.defaultAccount?.wallets;
  if (!Array.isArray(wallets)) throw new BlinkError("no_wallets", "Blink sent no wallets (check the API key has Read)");
  const usd = wallets.find((w) => w?.walletCurrency === "USD");
  if (!usd || typeof usd.id !== "string") throw new BlinkError("no_usd_wallet", "This Blink account has no USD wallet");
  const cents = Number(usd.balance);
  if (!Number.isSafeInteger(cents)) throw new BlinkError("bad_balance", "Blink sent an invalid USD balance");
  const scopes = Array.isArray(d?.authorization?.scopes) ? d.authorization.scopes : [];
  const limits = d?.me?.defaultAccount?.limits;
  return {
    id: usd.id, balanceCents: cents, canSend: scopes.includes("WRITE"),
    withdrawRemainingCents: remaining(limits?.withdrawal),
  };
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

/** True when one of this account's wallets received this payment hash (account-scoped, not a public lookup). */
export async function invoicePaid(f: Fetch, cfg: BlinkConfig, paymentHash: string): Promise<boolean> {
  const data = await gql(
    f, cfg,
    "query Paid($h: PaymentHash!) { me { defaultAccount { wallets { transactionsByPaymentHash(paymentHash: $h) { direction status } } } } }",
    { h: paymentHash },
  );
  // deno-lint-ignore no-explicit-any
  const wallets = (data as any)?.me?.defaultAccount?.wallets;
  if (!Array.isArray(wallets)) throw new BlinkError("no_wallets", "Blink sent no wallets (check the API key has Read)");
  return wallets.some((w) =>
    (Array.isArray(w?.transactionsByPaymentHash) ? w.transactionsByPaymentHash : [])
      .some((t: { direction?: unknown; status?: unknown }) => t?.direction === "RECEIVE" && t?.status === "SUCCESS")
  );
}

/** "type=blink;server=…;api-key=…" → lower-case keys and their values. */
export function parseConnectionString(s: string | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of String(s ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim());
  }
  return out;
}

/**
 * BTCPay's Blink connection for this account's USD wallet. Uses the
 * account's receive-only key when set ('receive'), else its API key ('api',
 * which can also spend).
 */
export function connectionString(a: BlinkAccount, usdWalletId: string): { value: string; keyKind: "receive" | "api" } {
  const key = a.receiveKey ?? a.apiKey;
  return { value: `type=blink;server=${a.url};api-key=${key};wallet-id=${usdWalletId}`, keyKind: a.receiveKey ? "receive" : "api" };
}

/**
 * Which configured Blink account a BTCPay connection string pays into: by its
 * wallet-id (each account's USD wallet id) first, else by its api-key.
 * null = not a Blink connection, or not one of CPAY's accounts.
 */
export function receivingAccount(conn: string | null, accounts: BlinkAccount[], usdWalletIds: Map<string, string>): { account: string; keyKind: "receive" | "api" | null } | null {
  const kv = parseConnectionString(conn);
  if (kv.get("type")?.toLowerCase() !== "blink") return null;
  const key = kv.get("api-key") ?? "";
  const kind = (a: BlinkAccount) => (key && a.receiveKey === key ? "receive" : key && a.apiKey === key ? "api" : null);
  const wallet = kv.get("wallet-id");
  if (wallet) {
    for (const a of accounts) if (usdWalletIds.get(a.label) === wallet) return { account: a.label, keyKind: kind(a) };
  }
  for (const a of accounts) if (kind(a)) return { account: a.label, keyKind: kind(a) };
  return null;
}
