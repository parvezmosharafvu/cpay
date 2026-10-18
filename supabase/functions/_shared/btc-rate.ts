// BTC/USD price for direct-settlement invoices.
//
// Custodial invoices are priced by the platform wallet engine. A direct
// invoice must not depend on that wallet, so it is priced from public
// exchange tickers: at least two sources that agree within MAX_SPREAD, then
// the median. If they do not agree, no price: the payer sees "try again",
// never an invoice at a doubtful rate.

export type RateSource = { name: string; url: string; read: (body: unknown) => unknown };

export const SOURCES: RateSource[] = [
  // deno-lint-ignore no-explicit-any
  { name: "coinbase", url: "https://api.coinbase.com/v2/prices/BTC-USD/spot", read: (b: any) => b?.data?.amount },
  // deno-lint-ignore no-explicit-any
  { name: "kraken", url: "https://api.kraken.com/0/public/Ticker?pair=XBTUSD", read: (b: any) => b?.result?.XXBTZUSD?.c?.[0] },
  // deno-lint-ignore no-explicit-any
  { name: "bitstamp", url: "https://www.bitstamp.net/api/v2/ticker/btcusd/", read: (b: any) => b?.last },
];

export const MAX_SPREAD = 0.02; // 2 %
const MIN_PLAUSIBLE = 1_000;
const MAX_PLAUSIBLE = 10_000_000;

export type Rate = { usdPerBtc: number; usdPerBtcCents: bigint; sources: string[] };

export class RateError extends Error {}

function parse(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n >= MIN_PLAUSIBLE && n <= MAX_PLAUSIBLE ? n : null;
}

/** Median of the quotes within MAX_SPREAD of the overall median; needs two. */
export function agree(quotes: Array<{ name: string; value: number }>): Rate {
  if (quotes.length < 2) throw new RateError("fewer than two price sources answered");
  const sorted = [...quotes].sort((a, b) => a.value - b.value);
  const mid = (xs: typeof sorted) => xs.length % 2 ? xs[(xs.length - 1) / 2].value : (xs[xs.length / 2 - 1].value + xs[xs.length / 2].value) / 2;
  const m = mid(sorted);
  const close = sorted.filter((q) => Math.abs(q.value - m) / m <= MAX_SPREAD / 2);
  if (close.length < 2) throw new RateError("price sources disagree");
  const lo = close[0].value;
  const hi = close[close.length - 1].value;
  if ((hi - lo) / lo > MAX_SPREAD) throw new RateError("price sources disagree");
  const usdPerBtc = Math.round(mid(close) * 100) / 100;
  return { usdPerBtc, usdPerBtcCents: BigInt(Math.round(usdPerBtc * 100)), sources: close.map((q) => q.name) };
}

export async function fetchRate(fetchImpl: typeof fetch = fetch, sources: RateSource[] = SOURCES): Promise<Rate> {
  const quotes = (await Promise.all(sources.map(async (s) => {
    try {
      const res = await fetchImpl(s.url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(4000) });
      if (!res.ok) {
        await res.body?.cancel();
        return null;
      }
      const value = parse(s.read(await res.json()));
      return value === null ? null : { name: s.name, value };
    } catch {
      return null;
    }
  }))).filter((q): q is { name: string; value: number } => q !== null);
  return agree(quotes);
}

let cached: { rate: Rate; at: number } | null = null;

/** fetchRate with a 60-second cache per function instance. */
export async function currentRate(fetchImpl: typeof fetch = fetch, nowMs = Date.now()): Promise<Rate> {
  if (cached && nowMs - cached.at < 60_000) return cached.rate;
  const rate = await fetchRate(fetchImpl);
  cached = { rate, at: nowMs };
  return rate;
}

export function resetRateCache() {
  cached = null;
}

/**
 * Whole satoshis for `cents` US cents, rounded down (as the custodial
 * invoice is), as millisatoshi. Exact integer arithmetic.
 */
export function centsToMsat(cents: number, rate: Rate): bigint {
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new RateError("bad amount");
  const sats = (BigInt(cents) * 100_000_000n) / rate.usdPerBtcCents;
  if (sats <= 0n) throw new RateError("amount too small");
  return sats * 1000n;
}
