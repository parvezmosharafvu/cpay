// Lightning address (LUD-16) client for direct settlement: CPAY asks the
// MERCHANT'S own wallet provider for an invoice (LUD-06 payRequest), so the
// payer pays the merchant directly and CPAY never holds the money. Payment
// is confirmed only by proof: the provider's LUD-21 "verify" URL returns the
// preimage, and sha256(preimage) must equal the invoice's payment hash.
//
// Every request goes to a host the merchant chose, so each one is treated
// as untrusted: https only, no IP literals or internal names, no redirects,
// a short timeout, a small body cap, JSON only, and a strict shape check.
// Provider error text is never echoed to a payer.
//
// Specs: https://github.com/lnurl/luds (06, 16, 21).

import { type Bolt11, type Bolt11Network, decodeBolt11, preimageMatches, sha256HexBytes } from "./bolt11.ts";

export class LnurlError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export type Fetch = typeof fetch;

export type LightningAddress = { user: string; domain: string; address: string; wellKnown: string };

export type PayRequest = {
  callback: string;
  minSendableMsat: bigint;
  maxSendableMsat: bigint;
  metadata: string;
  description: string;
};

export type ProviderInvoice = { invoice: Bolt11; verifyUrl: string | null };

export type Verification =
  | { state: "paid"; preimage: string }
  | { state: "not_paid" }
  // The provider says "settled" but gave no preimage that hashes to the
  // payment hash. Never treated as paid.
  | { state: "unproven"; reason: string };

const MAX_BODY_BYTES = 64 * 1024;
const TIMEOUT_MS = 8000;
const BLOCKED_SUFFIXES = [".local", ".localhost", ".internal", ".onion", ".lan", ".home", ".arpa", ".test", ".invalid", ".example"];
const ADDRESS = /^([a-z0-9._+-]{1,64})@((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})$/;

/** A LUD-16 address in canonical (lower-case) form, or null. */
export function parseLightningAddress(input: unknown): LightningAddress | null {
  const s = String(input ?? "").trim().toLowerCase().replace(/^lightning:/, "");
  if (s.length > 320) return null;
  const m = ADDRESS.exec(s);
  if (!m) return null;
  const [, user, domain] = m;
  if (!hostAllowed(domain)) return null;
  return { user, domain, address: `${user}@${domain}`, wellKnown: `https://${domain}/.well-known/lnurlp/${user}` };
}

/** No IP literals, single labels or internal names. */
export function hostAllowed(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (!h.includes(".")) return false;
  if (/^[0-9.]+$/.test(h) || h.includes(":") || h.startsWith("[")) return false;
  if (h === "localhost" || BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) return false;
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h);
}

/** An https URL on an allowed host and the default port, or null. */
export function safeUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return null;
  if (!hostAllowed(u.hostname)) return null;
  return u;
}

/**
 * GET JSON from a merchant-chosen host. `fetchImpl` is injected so tests (and
 * the local E2E stack) can answer without the network.
 */
export async function getJson(url: URL, fetchImpl: Fetch): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(url.toString(), {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new LnurlError("unreachable", "The wallet provider did not answer.");
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    throw new LnurlError("redirect", "The wallet provider answered with a redirect, which is not allowed.");
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new LnurlError("http_error", `The wallet provider answered ${res.status}.`);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new LnurlError("bad_response", "The wallet provider sent an empty answer.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new LnurlError("too_large", "The wallet provider sent too much data.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new LnurlError("bad_response", "The wallet provider did not send JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new LnurlError("bad_response", "Unexpected answer from the wallet provider.");
  const obj = body as Record<string, unknown>;
  if (String(obj.status ?? "").toUpperCase() === "ERROR") {
    // The reason is logged by the caller, never shown to a payer as is.
    throw new LnurlError("provider_error", String(obj.reason ?? "error").slice(0, 200));
  }
  return obj;
}

function msat(v: unknown): bigint | null {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^[0-9]{1,18}$/.test(v)) return BigInt(v);
  return null;
}

/** LUD-06 payRequest for a LUD-16 address. */
export async function fetchPayRequest(addr: LightningAddress, fetchImpl: Fetch): Promise<PayRequest> {
  const url = safeUrl(addr.wellKnown);
  if (!url) throw new LnurlError("bad_address", "That Lightning address cannot be used.");
  const body = await getJson(url, fetchImpl);
  if (body.tag !== "payRequest") throw new LnurlError("not_pay_request", "That address does not accept Lightning payments.");
  const callback = safeUrl(body.callback);
  if (!callback) throw new LnurlError("bad_callback", "The wallet provider's payment address is not a safe https address.");
  const min = msat(body.minSendable);
  const max = msat(body.maxSendable);
  if (min === null || max === null || min < 1n || max < min) throw new LnurlError("bad_limits", "The wallet provider sent invalid amount limits.");
  if (typeof body.metadata !== "string" || body.metadata.length > 8192) throw new LnurlError("bad_metadata", "The wallet provider sent invalid details.");
  let entries: unknown;
  try {
    entries = JSON.parse(body.metadata);
  } catch {
    throw new LnurlError("bad_metadata", "The wallet provider sent invalid details.");
  }
  if (!Array.isArray(entries)) throw new LnurlError("bad_metadata", "The wallet provider sent invalid details.");
  let description: string | null = null;
  for (const e of entries) {
    if (!Array.isArray(e) || typeof e[0] !== "string") continue;
    if (e[0] === "text/plain" && typeof e[1] === "string" && description === null) description = e[1];
    // LUD-16: when the provider names the address, it must be this one.
    if ((e[0] === "text/identifier" || e[0] === "text/email") && typeof e[1] === "string" && e[1].toLowerCase() !== addr.address) {
      throw new LnurlError("identifier_mismatch", "The wallet provider's details name a different address.");
    }
  }
  if (description === null) throw new LnurlError("bad_metadata", "The wallet provider sent invalid details.");
  return { callback: callback.toString(), minSendableMsat: min, maxSendableMsat: max, metadata: body.metadata, description };
}

export type InvoiceRules = { network: Bolt11Network; nowMs: number; minRemainingMs?: number };

/**
 * Ask the provider for an invoice of exactly `amountMsat` and check it
 * against the payRequest: amount, description hash (LUD-06), network and
 * expiry. Returns the verify URL when the provider offers LUD-21.
 */
export async function requestInvoice(pay: PayRequest, amountMsat: bigint, rules: InvoiceRules, fetchImpl: Fetch): Promise<ProviderInvoice> {
  if (amountMsat < pay.minSendableMsat || amountMsat > pay.maxSendableMsat) {
    throw new LnurlError("out_of_range", "This amount is outside what the merchant's wallet accepts.");
  }
  const url = safeUrl(pay.callback);
  if (!url) throw new LnurlError("bad_callback", "The wallet provider's payment address is not a safe https address.");
  url.searchParams.set("amount", amountMsat.toString());
  const body = await getJson(url, fetchImpl);
  if (typeof body.pr !== "string") throw new LnurlError("no_invoice", "The wallet provider did not send an invoice.");
  let invoice: Bolt11;
  try {
    invoice = decodeBolt11(body.pr);
  } catch {
    throw new LnurlError("bad_invoice", "The wallet provider sent an invalid invoice.");
  }
  if (invoice.network !== rules.network) throw new LnurlError("wrong_network", "The wallet provider's invoice is for another Bitcoin network.");
  if (invoice.amountMsat !== amountMsat) throw new LnurlError("wrong_amount", "The wallet provider's invoice is for a different amount.");
  const expectedHash = await sha256HexBytes(new TextEncoder().encode(pay.metadata));
  if (invoice.descriptionHash !== expectedHash) throw new LnurlError("wrong_description", "The wallet provider's invoice does not match its own details.");
  if (invoice.expiresAtMs - rules.nowMs < (rules.minRemainingMs ?? 5 * 60_000)) {
    throw new LnurlError("expires_too_soon", "The wallet provider's invoice expires too soon.");
  }
  let verifyUrl: string | null = null;
  if (body.verify !== undefined && body.verify !== null) {
    const v = safeUrl(body.verify);
    if (!v) throw new LnurlError("bad_verify", "The wallet provider's confirmation address is not a safe https address.");
    verifyUrl = v.toString();
  }
  return { invoice, verifyUrl };
}

/**
 * LUD-21: ask the provider whether the invoice was paid. "paid" only with a
 * preimage that hashes to the payment hash; a provider claiming settlement
 * without that proof is "unproven", which callers treat as not paid.
 */
export async function verifyPayment(verifyUrl: string, expected: { paymentHash: string; invoice: string }, fetchImpl: Fetch): Promise<Verification> {
  const url = safeUrl(verifyUrl);
  if (!url) throw new LnurlError("bad_verify", "The confirmation address is not a safe https address.");
  const body = await getJson(url, fetchImpl);
  if (typeof body.pr === "string" && body.pr.trim().toLowerCase().replace(/^lightning:/, "") !== expected.invoice.toLowerCase()) {
    return { state: "unproven", reason: "the provider answered for a different invoice" };
  }
  if (body.settled !== true) return { state: "not_paid" };
  const preimage = typeof body.preimage === "string" ? body.preimage.trim().toLowerCase() : "";
  if (!(await preimageMatches(preimage, expected.paymentHash))) {
    return { state: "unproven", reason: "settled without a valid preimage" };
  }
  return { state: "paid", preimage };
}

// ---- addresses a merchant-chosen host must never resolve to -------------

function v4Private(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
}

function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0];
  // A trailing dotted quad (::ffff:127.0.0.1) becomes two hex groups.
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const p = v4.slice(1).map(Number);
    if (p.some((n) => n > 255)) return null;
    s = s.slice(0, v4.index) + ((p[0] << 8) | p[1]).toString(16) + ":" + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const parts = [...head, ...new Array(fill).fill("0"), ...rest];
  if (parts.length !== 8 || parts.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return parts.map((g) => parseInt(g, 16));
}

/** True for loopback, private, link-local, reserved and documentation ranges. */
export function ipNotPublic(ip: string): boolean {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return v4Private(ip);
  const g = v6Groups(ip);
  if (!g) return true;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d): judge the IPv4 part.
  const embedded = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4Private(embedded);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4Private(embedded);
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  return false;
}

export type Resolver = (host: string) => Promise<string[]>;

/**
 * Wrap fetch so a merchant-chosen host that resolves to a private or
 * reserved address is refused before any request is sent. A resolver that
 * is not available (some runtimes) is skipped; the URL checks above still
 * apply. Re-resolution between this check and the request (DNS rebinding)
 * remains possible; the requests are GET-only, carry no credentials, and
 * nothing from a refused or odd answer is shown to anyone.
 */
export function guardedFetch(base: Fetch, resolve: Resolver | null): Fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    if (!hostAllowed(u.hostname)) throw new LnurlError("blocked_host", "That host is not allowed.");
    if (resolve) {
      let ips: string[] | null = null;
      try {
        ips = await resolve(u.hostname);
      } catch {
        ips = null; // resolver unavailable; fetch fails by itself on NXDOMAIN
      }
      if (ips && ips.some(ipNotPublic)) throw new LnurlError("blocked_host", "That host is not allowed.");
    }
    return base(input, init);
  };
}

/** Deno's resolver (A and AAAA), or null when the runtime has none. */
export function denoResolver(): Resolver | null {
  // deno-lint-ignore no-explicit-any
  const d = (globalThis as any).Deno;
  if (!d || typeof d.resolveDns !== "function") return null;
  return async (host: string) => {
    const out: string[] = [];
    for (const type of ["A", "AAAA"]) {
      try {
        out.push(...(await d.resolveDns(host, type)) as string[]);
      } catch (e) {
        if (!(e instanceof Error) || !/no records|not found|NXDOMAIN|NotFound/i.test(e.message + e.name)) throw e;
      }
    }
    return out;
  };
}

/**
 * Local test hook (E2E only): send merchant-provider requests for any host
 * to one local fake provider, keeping the original host in a header. The
 * caller enables it only when SUPABASE_URL is a loopback address, so it can
 * never be active on the hosted project.
 */
export function e2eGatewayFetch(gateway: string, base: Fetch = fetch): Fetch {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    const target = new URL(gateway);
    target.pathname = u.pathname;
    target.search = u.search;
    const headers = new Headers(init?.headers);
    headers.set("x-e2e-host", u.host);
    return base(target.toString(), { ...init, headers });
  };
}
