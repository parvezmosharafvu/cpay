// Pure helpers for create-invoice: request idempotency, client keys for
// rate limits, and the optional Turnstile check. No Supabase client here,
// so every branch is unit-tested (guards_test.ts).
import { toCents } from "../_shared/money.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The payer page's per-attempt id, or null when absent/invalid (old pages). */
export function parseRequestId(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value.trim()) ? value.trim().toLowerCase() : null;
}

/**
 * The address that connected to the platform edge. Cloudflare's header
 * first (Supabase sits behind Cloudflare), then the first X-Forwarded-For
 * hop. Only used as a rate-limit key, hashed before it is stored.
 */
// Subrequests from any Cloudflare Worker (ours included) arrive from this
// address, so it identifies no payer. For those, our Worker passes the
// payer's address in x-cpay-client-ip. Another Worker could set that header
// too; then only the per-link and per-owner limits apply, as for a payer.
export const CLOUDFLARE_WORKER_EGRESS = "2a06:98c0:3600::103";
const IP_LIKE = /^[0-9a-fA-F:.]{2,45}$/;

export function clientKey(headers: Headers): string {
  const cf = headers.get("cf-connecting-ip")?.trim();
  if (cf === CLOUDFLARE_WORKER_EGRESS) {
    const fwd = headers.get("x-cpay-client-ip")?.trim();
    return fwd && IP_LIKE.test(fwd) ? `proxied:${fwd}` : `worker:${cf}`;
  }
  if (cf) return cf;
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  const xff = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return xff || "unknown";
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type ExistingPayment = {
  id: string;
  status: string;
  amount_requested: number | string;
  expires_at: string;
  lightning_invoice: string | null;
};

export type ReplayDecision =
  | { kind: "reuse"; paymentId: string; bolt11: string | null; expiresAt: string }
  | { kind: "error"; status: number; error: string };

/**
 * What to answer when this link already has a payment for the same request
 * id. Same amount and still open: the same payment (and its invoice, or a
 * fresh idempotent attach when the first request is still in flight).
 * Anything else: refuse, never a second invoice.
 */
export function replayDecision(existing: ExistingPayment, chargedCents: number, nowMs: number): ReplayDecision {
  if (toCents(existing.amount_requested) !== chargedCents) {
    return { kind: "error", status: 409, error: "This payment request was already started for a different amount. Refresh the page and try again." };
  }
  if (existing.status !== "new" || new Date(existing.expires_at).getTime() <= nowMs + 60_000) {
    return { kind: "error", status: 409, error: "This payment request was already used. Refresh the page to start a new one." };
  }
  return { kind: "reuse", paymentId: existing.id, bolt11: existing.lightning_invoice || null, expiresAt: existing.expires_at };
}

export type TurnstileMode = "off" | "monitor" | "enforce";

export function turnstileMode(secret: string, mode: string | undefined): TurnstileMode {
  if (!secret) return "off";
  return mode === "enforce" ? "enforce" : mode === "monitor" ? "monitor" : "off";
}

/**
 * Cloudflare Turnstile siteverify. Off unless TURNSTILE_SECRET_KEY and
 * TURNSTILE_MODE are set. "monitor" verifies and logs but never blocks;
 * "enforce" refuses a missing or failed token. A siteverify outage fails
 * closed only in enforce mode.
 */
export async function checkTurnstile(
  mode: TurnstileMode, secret: string, token: unknown, ip: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; reason?: string }> {
  if (mode === "off") return { ok: true };
  const t = typeof token === "string" ? token.trim() : "";
  let verdict: { ok: boolean; reason?: string };
  if (!t || t.length > 2048) {
    verdict = { ok: false, reason: "missing" };
  } else {
    try {
      const form = new FormData();
      form.append("secret", secret);
      form.append("response", t);
      if (ip && ip !== "unknown") form.append("remoteip", ip);
      const res = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST", body: form, signal: AbortSignal.timeout(5000),
      });
      const body = await res.json().catch(() => ({}));
      verdict = body?.success === true ? { ok: true } : { ok: false, reason: "rejected" };
    } catch {
      verdict = { ok: false, reason: "unavailable" };
    }
  }
  if (mode === "monitor") return { ok: true, reason: verdict.ok ? undefined : `monitor:${verdict.reason}` };
  return verdict;
}

export const PUBLIC_LIMITS = {
  // Per connecting address (hashed). Requests proxied by the site's own
  // worker share Cloudflare egress addresses, so this is generous; the
  // worker applies its own per-client limit before forwarding.
  ip: { bucket: "invoice_ip", limit: 60, windowSeconds: 60 },
  // Per payment link, on top of the existing per-owner limit (30/min).
  link: { bucket: "invoice_link", limit: 20, windowSeconds: 60 },
} as const;
