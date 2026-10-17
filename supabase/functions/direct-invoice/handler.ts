// direct-invoice: invoices that pay the MERCHANT'S OWN wallet (direct
// settlement, docs/NON-CUSTODIAL-ARCHITECTURE.md). CPAY asks the merchant's
// wallet provider for the invoice, shows it to the payer and records it;
// the money never passes through CPAY, so nothing here credits a balance.
//
// Public and unauthenticated like create-invoice (payers have no account),
// with the same brakes: operator stop, optional Turnstile, per-address,
// per-link and per-owner limits, request-id idempotency. Off unless the
// owner turns direct_settlement_enabled on.
//
// Actions (POST JSON, "action"):
//   create     { slug, amount, requestId?, turnstileToken? } -> the invoice
//   status     { id } -> status for the payer's page; asks the provider
//              (LUD-21) at most once every CHECK_INTERVAL_SECONDS per payment
//   reconcile  header x-direct-reconcile-secret -> checks open payments
//
// Pure: everything outside is injected (Deps), so handler_test.ts covers
// every branch without a network or a database.

import { formatCents, parseAmountToCents, toCents } from "../_shared/money.ts";
import { invoiceChargeCents } from "../create-invoice/invoice-amount.ts";
import { clientKey, parseRequestId, sha256Hex } from "../create-invoice/guards.ts";
import { centsToMsat, type Rate } from "../_shared/btc-rate.ts";
import {
  CHECK_INTERVAL_SECONDS, EXPIRY_GRACE_MS, nextAction, providerMessage, publicStatus, type DirectStatus, type SettlementProvider,
} from "../_shared/direct-settlement.ts";
import type { Verification } from "../_shared/lnurl.ts";
import { secretMatches } from "../_shared/secret-compare.ts";

export type Link = { link_id: string; user_id: string; is_active: boolean; cost_percent: number | string | null; settlement_mode: string };

export type DirectRow = {
  id: string;
  status: DirectStatus;
  amount_usd: number | string;
  buyer_amount?: number | string;
  expires_at: string;
  bolt11: string;
  payment_hash: string;
  verify_url: string;
  destination_address: string;
};

export type PublicRow = {
  id: string;
  status: DirectStatus;
  bolt11: string;
  amount_usd: number | string;
  amount_sats: number | string;
  expires_at: string;
  merchant_name: string | null;
  link_slug: string | null;
  destination_address: string;
  paid_at: string | null;
  preimage: string | null;
  payment_hash: string;
};

export type NewRow = {
  payment_link_id: string;
  user_id: string;
  destination_id: string;
  destination_address: string;
  client_request_id: string | null;
  buyer_amount: string;
  amount_usd: string;
  amount_msat: string;
  btc_usd_rate: string;
  rate_sources: string[];
  bolt11: string;
  payment_hash: string;
  verify_url: string;
  expires_at: string;
  customer_country: string | null;
  customer_city: string | null;
};

/** undefined = could not read (fail closed); null = nothing there. */
export interface Db {
  paymentsStopped(): Promise<boolean | undefined>;
  directEnabled(): Promise<boolean | undefined>;
  claimPublic(bucket: string, keyHash: string, limit: number, windowSeconds: number): Promise<boolean | undefined>;
  linkForSlug(slug: string): Promise<Link | null | undefined>;
  profileMaxCents(userId: string): Promise<number | undefined>;
  claimOwnerRate(userId: string): Promise<boolean | undefined>;
  releaseOwnerRate(userId: string): Promise<void>;
  destinationFor(userId: string): Promise<{ id: string; address: string } | null | undefined>;
  findByRequest(linkId: string, requestId: string): Promise<DirectRow | null | undefined>;
  insert(row: NewRow): Promise<{ id: string } | "request_conflict" | undefined>;
  publicRow(id: string): Promise<PublicRow | null | undefined>;
  claimCheck(id: string, intervalSeconds: number): Promise<DirectRow | null | undefined>;
  claimChecks(limit: number, intervalSeconds: number): Promise<DirectRow[] | undefined>;
  recordProof(id: string, preimage: string): Promise<string | undefined>;
  expire(id: string, graceSeconds: number): Promise<string | undefined>;
}

export type Deps = {
  db: Db;
  provider: SettlementProvider;
  rate: () => Promise<Rate>;
  turnstile: (token: unknown, ip: string) => Promise<{ ok: boolean; reason?: string }>;
  reconcileSecret: string;
  now?: () => number;
  log?: (msg: string, extra?: unknown) => void;
};

export const LIMITS = {
  ip: { bucket: "direct_ip", limit: 30, windowSeconds: 60 },
  link: { bucket: "direct_link", limit: 20, windowSeconds: 60 },
  status: { bucket: "direct_status", limit: 120, windowSeconds: 60 },
} as const;

const CORS = {
  // Same reason as create-invoice: links are shared and embedded anywhere.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9-]{2,48}[A-Za-z0-9]$/;
const BUSY = "Temporarily unavailable. Please try again in a moment.";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

export function invoiceAnswer(id: string, bolt11: string, amountUsd: number | string, expiresAt: string, destination: string) {
  return {
    paymentId: id,
    settlement: "direct",
    payCode: bolt11,
    payUrl: `lightning:${bolt11}`,
    lightningUri: `lightning:${bolt11}`,
    cashAppUrl: `https://cash.app/launch/lightning/${encodeURIComponent(bolt11)}`,
    amountRequested: Number(amountUsd),
    expiresAt: new Date(expiresAt).toISOString(),
    destination,
  };
}

export function statusAnswer(r: PublicRow) {
  return {
    paymentId: r.id,
    settlement: "direct",
    status: publicStatus(r.status),
    payCode: r.bolt11,
    amountRequested: Number(r.amount_usd),
    amountSats: Number(r.amount_sats),
    expiresAt: new Date(r.expires_at).toISOString(),
    merchantName: r.merchant_name,
    linkSlug: r.link_slug,
    destination: r.destination_address,
    paidAt: r.paid_at,
    // Proof of payment: sha256(proof) is paymentHash, the hash in the
    // invoice the payer paid. Anyone can check it.
    proof: r.status === "paid" ? r.preimage : null,
    paymentHash: r.payment_hash,
  };
}

export function createHandler(deps: Deps): (req: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string, e?: unknown) => console.error(m, e ?? ""));
  const { db } = deps;

  async function limited(cfg: { bucket: string; limit: number; windowSeconds: number }, key: string): Promise<Response | null> {
    const ok = await db.claimPublic(cfg.bucket, await sha256Hex(key), cfg.limit, cfg.windowSeconds);
    if (ok === undefined) return json({ error: BUSY }, 503);
    if (!ok) return json({ error: "Too many requests. Please wait a minute and try again." }, 429);
    return null;
  }

  /** One provider check of one claimed payment, applied. Never throws. */
  async function checkOne(row: DirectRow): Promise<string> {
    let v: Verification | null = null;
    try {
      v = await deps.provider.check({ verifyUrl: row.verify_url, paymentHash: row.payment_hash, invoice: row.bolt11 });
    } catch (e) {
      log("direct payment check failed", { id: row.id, error: String((e as Error)?.message ?? e) });
    }
    if (v?.state === "unproven") log("provider claims settlement without proof", { id: row.id, reason: v.reason });
    const next = nextAction(row.status, new Date(row.expires_at).getTime(), v, now());
    if (next.kind === "record_proof") return (await db.recordProof(row.id, next.preimage)) ?? row.status;
    if (next.kind === "expire") return (await db.expire(row.id, EXPIRY_GRACE_MS / 1000)) ?? row.status;
    return row.status;
  }

  async function create(req: Request, body: Record<string, unknown>): Promise<Response> {
    const stopped = await db.paymentsStopped();
    if (stopped === undefined) return json({ error: "Payment service temporarily unavailable" }, 503);
    if (stopped) return json({ error: "New payments are temporarily paused by the platform operator" }, 503);
    const enabled = await db.directEnabled();
    if (enabled === undefined) return json({ error: "Payment service temporarily unavailable" }, 503);
    if (!enabled) return json({ error: "Direct payments are not available." }, 503);

    const slug = String(body.slug ?? "").trim();
    const amountCents = parseAmountToCents(body.amount as number | string | undefined);
    if (!SLUG.test(slug)) return json({ error: "Invalid payment link" }, 400);
    if (amountCents === null || amountCents < 100 || amountCents > 500000) return json({ error: "Amount must be between $1 and $5000" }, 400);
    const requestId = parseRequestId(body.requestId);
    const ip = clientKey(req.headers);

    const ts = await deps.turnstile(body.turnstileToken, ip);
    if (ts.reason) log("turnstile", ts.reason);
    if (!ts.ok) return json({ error: "Please complete the verification and try again." }, 403);
    const ipLimit = await limited(LIMITS.ip, `ip:${ip}`);
    if (ipLimit) return ipLimit;

    const link = await db.linkForSlug(slug);
    if (link === undefined) return json({ error: BUSY }, 503);
    if (!link) return json({ error: "Payment link not found" }, 404);
    if (!link.is_active) return json({ error: "This payment link is no longer active" }, 410);
    if (link.settlement_mode !== "direct") return json({ error: "This link does not take direct payments." }, 409);

    const rawCost = Number(link.cost_percent ?? 0);
    const costPercent = Number.isFinite(rawCost) ? Math.min(Math.max(rawCost, 0), 1000) : 0;
    const chargedCents = invoiceChargeCents(amountCents, costPercent);
    const maxCents = await db.profileMaxCents(link.user_id);
    if (maxCents === undefined) return json({ error: "Payment service temporarily unavailable" }, 503);
    if (chargedCents > maxCents) return json({ error: `This profile accepts payments up to $${formatCents(maxCents)} per invoice.` }, 400);
    if (chargedCents > 5_000_000) return json({ error: "This link's current price is too high to invoice." }, 400);

    if (requestId) {
      const existing = await db.findByRequest(link.link_id, requestId);
      if (existing === undefined) return json({ error: BUSY }, 503);
      if (existing) return replay(existing, chargedCents);
    }

    const linkLimit = await limited(LIMITS.link, `link:${link.link_id}`);
    if (linkLimit) return linkLimit;
    const owner = await db.claimOwnerRate(link.user_id);
    if (owner === undefined) return json({ error: BUSY }, 503);
    if (!owner) return json({ error: "Too many invoices. Please wait a moment and try again." }, 429);
    const release = () => db.releaseOwnerRate(link.user_id).catch(() => {});

    const dest = await db.destinationFor(link.user_id);
    if (dest === undefined) { await release(); return json({ error: BUSY }, 503); }
    if (!dest) { await release(); return json({ error: "This merchant is not taking payments right now." }, 409); }

    let rate: Rate;
    try {
      rate = await deps.rate();
    } catch (e) {
      log("no BTC price", String((e as Error)?.message ?? e));
      await release();
      return json({ error: "Prices are unavailable right now. Please try again in a minute." }, 503);
    }
    const amountMsat = centsToMsat(chargedCents, rate);

    let created;
    try {
      created = await deps.provider.createInvoice(dest.address, amountMsat);
    } catch (e) {
      log("merchant provider refused an invoice", { link: link.link_id, error: String((e as Error)?.message ?? e) });
      await release();
      return json({ error: providerMessage(e) }, 502);
    }

    const row: NewRow = {
      payment_link_id: link.link_id,
      user_id: link.user_id,
      destination_id: dest.id,
      destination_address: dest.address,
      client_request_id: requestId,
      buyer_amount: formatCents(amountCents),
      amount_usd: formatCents(chargedCents),
      amount_msat: amountMsat.toString(),
      btc_usd_rate: rate.usdPerBtc.toFixed(2),
      rate_sources: rate.sources,
      bolt11: created.invoice.invoice,
      payment_hash: created.invoice.paymentHash,
      verify_url: created.verifyUrl,
      expires_at: new Date(created.invoice.expiresAtMs).toISOString(),
      customer_country: req.headers.get("cf-ipcountry") || null,
      customer_city: req.headers.get("cf-ipcity") || null,
    };
    const ins = await db.insert(row);
    if (ins === "request_conflict" && requestId) {
      // A concurrent request with the same id won. Its invoice is the one
      // the payer sees; this one is never shown and expires unpaid.
      await release();
      const existing = await db.findByRequest(link.link_id, requestId);
      if (existing) return replay(existing, chargedCents);
      return json({ error: "Could not record payment" }, 500);
    }
    if (!ins || ins === "request_conflict") {
      await release();
      return json({ error: "Could not record payment" }, 500);
    }
    return json(invoiceAnswer(ins.id, row.bolt11, row.amount_usd, row.expires_at, dest.address));
  }

  function replay(existing: DirectRow, chargedCents: number): Response {
    if (toCents(existing.amount_usd) !== chargedCents) {
      return json({ error: "This payment request was already started for a different amount. Refresh the page and try again." }, 409);
    }
    if (existing.status !== "pending" || new Date(existing.expires_at).getTime() <= now() + 60_000) {
      return json({ error: "This payment request was already used. Refresh the page to start a new one." }, 409);
    }
    return json(invoiceAnswer(existing.id, existing.bolt11, existing.amount_usd, existing.expires_at, existing.destination_address));
  }

  async function status(req: Request, body: Record<string, unknown>): Promise<Response> {
    const id = String(body.id ?? "").trim();
    if (!UUID.test(id)) return json({ error: "Payment not found" }, 404);
    const limit = await limited(LIMITS.status, `status:${clientKey(req.headers)}`);
    if (limit) return limit;
    let row = await db.publicRow(id);
    if (row === undefined) return json({ error: BUSY }, 503);
    if (!row) return json({ error: "Payment not found" }, 404);
    if (row.status !== "paid") {
      const claimed = await db.claimCheck(id, CHECK_INTERVAL_SECONDS);
      if (claimed) {
        await checkOne(claimed);
        row = (await db.publicRow(id)) ?? row;
      }
    }
    return json(statusAnswer(row));
  }

  async function reconcile(req: Request): Promise<Response> {
    if (!deps.reconcileSecret) return json({ error: "Not configured" }, 503);
    if (!secretMatches(req.headers.get("x-direct-reconcile-secret"), deps.reconcileSecret)) return json({ error: "Forbidden" }, 403);
    const rows = await db.claimChecks(25, 60);
    if (rows === undefined) return json({ error: BUSY }, 503);
    const out: Record<string, number> = { checked: rows.length, paid: 0, expired: 0 };
    for (const r of rows) {
      const s = await checkOne(r);
      if (s === "paid" && r.status !== "paid") out.paid++;
      if (s === "expired" && r.status !== "expired") out.expired++;
    }
    return json(out);
  }

  return async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    let body: Record<string, unknown>;
    try {
      const parsed = await req.json();
      body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    const action = String(body.action ?? "create");
    try {
      if (action === "create") return await create(req, body);
      if (action === "status") return await status(req, body);
      if (action === "reconcile") return await reconcile(req);
      return json({ error: "Unknown action" }, 400);
    } catch (e) {
      log("direct-invoice failed", String((e as Error)?.stack ?? e));
      return json({ error: "Something went wrong. Please try again." }, 500);
    }
  };
}
