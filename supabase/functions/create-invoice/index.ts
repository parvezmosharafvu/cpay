import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { invoiceChargeCents } from "./invoice-amount.ts";
import { formatCents, parseAmountToCents, toCents } from "../_shared/money.ts";
import {
  checkTurnstile, clientKey, type ExistingPayment, parseRequestId, PUBLIC_LIMITS, replayDecision, sha256Hex, turnstileMode,
} from "./guards.ts";
import { serviceAuthHeaders, serviceAuthMode } from "../_shared/service-auth.ts";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
// The cpay payment service (payment-service/) holds the Breez wallet and
// makes the Lightning invoice for a payments row this function inserts.
const PAYMENT_SERVICE_URL = Deno.env.get("PAYMENT_SERVICE_URL") ?? "";
const PAYMENT_SERVICE_SECRET = Deno.env.get("PAYMENT_SERVICE_SECRET") ?? "";
const PAYMENT_SERVICE_AUTH_MODE = serviceAuthMode(Deno.env.get("PAYMENT_SERVICE_AUTH_MODE"));
const INVOICE_MINUTES = 60;
// Optional Cloudflare Turnstile (off unless both are set; see guards.ts).
const TURNSTILE_MODE = turnstileMode(Deno.env.get("TURNSTILE_SECRET_KEY") ?? "", Deno.env.get("TURNSTILE_MODE"));
const TURNSTILE_SECRET = Deno.env.get("TURNSTILE_SECRET_KEY") ?? "";
// Wildcard origin is intentional here: payment links are embedded on
// creator-owned custom domains, so any site must be able to POST. The
// endpoint is unauthenticated by design and defends itself with the
// per-link rate limit below, not with CORS.
const CORS_HEADERS = {
"Access-Control-Allow-Origin": "*",
"Access-Control-Allow-Headers": "Content-Type",
"Access-Control-Allow-Methods": "POST, OPTIONS",
};
Deno.serve(async (req) => {
if (req.method === "OPTIONS") {
return new Response(null, { headers: CORS_HEADERS });
}
if (req.method !== "POST") {
return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
}
let body: { slug?: string; amount?: number | string; requestId?: unknown; turnstileToken?: unknown };
try {
body = await req.json();
} catch {
return json({ error: "Invalid JSON body" }, 400);
}
// The operator emergency stop is checked before any public link lookup or
// provider call. A settings read failure fails closed: a payment kill switch
// must never be silently ignored during a database incident.
const { data: paymentStop, error: paymentStopError } = await supabaseAdmin
  .from("app_settings")
  .select("value")
  .eq("key", "emergency_payments_stop")
  .maybeSingle();
if (paymentStopError) {
  console.error("emergency payment-stop read failed:", paymentStopError.message);
  return json({ error: "Payment service temporarily unavailable" }, 503);
}
if (paymentStop?.value === true || String(paymentStop?.value) === "true") {
  return json({ error: "New payments are temporarily paused by the platform operator" }, 503);
}
// Case matters: /taylor-james, /TaylorJames and /taylorjames are three
// different links.
const slug = String(body.slug ?? "").trim();
// Integer cents, parsed from the decimal digits (never Number(x) * 100,
// which turns 4.35 into 434.99999999999994). NaN, Infinity, negatives and
// exponents are refused; a third decimal rounds half-up to the cent.
const amountCents = parseAmountToCents(body.amount);
if (!/^[A-Za-z0-9][A-Za-z0-9-]{2,48}[A-Za-z0-9]$/.test(slug)) {
return json({ error: "Invalid payment link" }, 400);
}
if (amountCents === null || amountCents < 100 || amountCents > 500000) {
return json({ error: "Amount must be between $1 and $5000" }, 400);
}
const requestId = parseRequestId(body.requestId);
const ip = clientKey(req.headers);

// Optional bot check (off by default; TURNSTILE_SECRET_KEY + TURNSTILE_MODE).
const turnstile = await checkTurnstile(TURNSTILE_MODE, TURNSTILE_SECRET, body.turnstileToken, ip);
if (turnstile.reason) console.warn("turnstile:", turnstile.reason);
if (!turnstile.ok) return json({ error: "Please complete the verification and try again." }, 403);

// Per-address brake before any link lookup, so slugs cannot be probed in
// bulk either. Keyed by a SHA-256 of the address; fails closed.
const ipAllowed = await claimPublic(PUBLIC_LIMITS.ip, await sha256Hex(`ip:${ip}`));
if (ipAllowed === null) return json({ error: "Temporarily unavailable. Please try again in a moment." }, 503);
if (!ipAllowed) return json({ error: "Too many payment requests. Please wait a minute and try again." }, 429);
// Look up the payment link — must exist and be active.
const { data: linkRows, error: linkErr } = await supabaseAdmin
.rpc("system_link_for_invoice", { p_slug: slug });
const link = Array.isArray(linkRows) ? linkRows[0] : linkRows;
if (linkErr || !link) return json({ error: "Payment link not found" }, 404);
if (!link.is_active) return json({ error: "This payment link is no longer active" }, 410);

// The owner's own markup, applied by us. It is the only thing separating
// what the payer is charged from the link's face value. Clamped
// defensively: a negative or absurd cost_percent must never be able to
// produce a smaller or wildly larger charge than intended, even if the
// column constraint were somehow bypassed.
const rawCost = Number(link.cost_percent ?? 0);
// Upper bound matches the database's own CHECK constraint (0-1000,
// set by migrations 0060 and 0063), which is a typo guard rather than a
// policy ceiling. This line said 100 from when it was written alongside
// 0059's since-removed 25% ceiling, and was not updated when 0060
// deliberately lifted the limit — so any cost above 100% was silently
// clamped, quietly undoing the exact decision 0060 made. Nothing
// errored; a link set to 300% simply charged as if it were 100%.
const costPercent = Number.isFinite(rawCost) ? Math.min(Math.max(rawCost, 0), 1000) : 0;
// Rounded to cents, because that is what gets both charged and recorded
// — computing one and storing the other would make every reconciliation
// off by fractions.
const chargedAmountCents = invoiceChargeCents(amountCents, costPercent);
const chargedAmount = chargedAmountCents / 100;

// An admin may set a lower per-profile ceiling than the platform-wide
// safety ceiling. Apply it to the final payer charge, including markup.
const { data: profileLimit, error: profileLimitError } = await supabaseAdmin
  .from("profile_limits")
  .select("max_invoice_amount")
  .eq("user_id", link.user_id)
  .maybeSingle();
if (profileLimitError) {
  console.error("profile invoice-limit read failed:", profileLimitError.message);
  return json({ error: "Payment service temporarily unavailable" }, 503);
}
// Compared in integer cents: the limit is numeric in the database.
const profileMaxCents = toCents(profileLimit?.max_invoice_amount ?? 5000, "floor");
if (profileMaxCents !== null && chargedAmountCents > profileMaxCents) {
  return json({
    error: `This profile accepts payments up to $${formatCents(profileMaxCents)} per invoice.`,
  }, 400);
}

// A deliberately generous ceiling on the FINAL amount, separate from the
// markup's own bound. A 900% markup on a $6,000 link is individually
// within every rule above and still produces a $60,000 invoice — more
// than a Lightning channel is likely to carry, and the failure would
// surface as an opaque provider or routing error rather than anything a
// payer could act on. Refusing it here gives a comprehensible message
// instead.
//
// Set well above any real payment so it never interferes with ordinary
// use; this catches the combination of two individually-legal numbers,
// not a normal one.
if (chargedAmountCents > 5_000_000) {
return json({
error: "This link's current price is too high to invoice. Lower the link's cost percentage and try again.",
}, 400);
}

if (!PAYMENT_SERVICE_URL || !PAYMENT_SERVICE_SECRET) {
  console.error("PAYMENT_SERVICE_URL or PAYMENT_SERVICE_SECRET is not set");
  return json({ error: "Payments are temporarily unavailable" }, 503);
}

// Same attempt seen before (double tap, retry after a timeout, proxy then
// direct fallback): answer with that payment, never a second invoice.
if (requestId) {
  const existing = await findByRequest(link.link_id, requestId);
  if (existing === undefined) return json({ error: "Temporarily unavailable. Please try again in a moment." }, 503);
  if (existing) return replay(existing, chargedAmountCents);
}

const linkAllowed = await claimPublic(PUBLIC_LIMITS.link, await sha256Hex(`link:${link.link_id}`));
if (linkAllowed === null) return json({ error: "Temporarily unavailable. Please try again in a moment." }, 503);
if (!linkAllowed) return json({ error: "Too many invoices. Please wait a moment and try again." }, 429);

// This endpoint is unauthenticated by design (customers have no account),
// so it needs its own brake. Scoped by the link's OWNER, not the link:
// create_link_variants() gives one name up to four links.
const { data: rateAllowed, error: rateErr } = await supabaseAdmin.rpc("claim_invoice_rate_limit", {
  p_user_id: link.user_id, p_limit: 30, p_window_seconds: 60,
});
if (rateErr) {
  console.error("rate-limit claim failed, refusing:", rateErr.message);
  return json({ error: "Temporarily unavailable. Please try again in a moment." }, 503);
}
if (rateAllowed !== true) {
  return json({ error: "Too many invoices. Please wait a moment and try again." }, 429);
}
const releaseRateClaim = async () => {
  const { error } = await supabaseAdmin.rpc("release_invoice_rate_limit", { p_user_id: link.user_id });
  if (error) console.error("rate-limit release failed:", error.message);
};

// The row comes first and the invoice second, so a payment can never
// arrive for a row that does not exist yet.
const expiresAt = new Date(Date.now() + INVOICE_MINUTES * 60 * 1000).toISOString();
const { data: payment, error: insertErr } = await supabaseAdmin
  .from("payments")
  .insert({
    payment_link_id: link.link_id,
    user_id: link.user_id,
    method: "lightning",
    // What the payer typed, before markup. Display only.
    // Sent as exact decimal strings so numeric columns never see a float.
    buyer_amount: formatCents(amountCents),
    // What the payer is charged, and what the owner is credited on settle.
    amount_requested: formatCents(chargedAmountCents),
    status: "new",
    expires_at: expiresAt,
    customer_city: req.headers.get("cf-ipcity") || null,
    customer_country: req.headers.get("cf-ipcountry") || null,
    client_request_id: requestId,
  })
  .select("id")
  .single();
if (insertErr?.code === "23505" && requestId) {
  // Lost a race with a concurrent request for the same attempt.
  await releaseRateClaim();
  const existing = await findByRequest(link.link_id, requestId);
  if (existing) return replay(existing, chargedAmountCents);
  return json({ error: "Could not record payment" }, 500);
}
if (insertErr || !payment) {
  console.error("Failed to record payment:", insertErr);
  await releaseRateClaim();
  return json({ error: "Could not record payment" }, 500);
}

const bolt11 = await requestInvoice(payment.id);
if (!bolt11) {
  // No payer ever saw an invoice for this row, so nothing can settle it.
  const { error } = await supabaseAdmin.from("payments").delete().eq("id", payment.id);
  if (error) console.error("Could not delete invoiceless payment", payment.id, error.message);
  await releaseRateClaim();
  return json({ error: "Could not create invoice" }, 502);
}

return invoiceResponse(payment.id, bolt11, chargedAmount, expiresAt);
});

// payment-service attaches (or returns the already attached) invoice for a
// payments row; idempotent per payment id (advisory lock in the service).
async function requestInvoice(paymentId: string): Promise<string> {
  try {
    const invoiceBody = JSON.stringify({ paymentId });
    const auth = await serviceAuthHeaders({
      mode: PAYMENT_SERVICE_AUTH_MODE, secret: PAYMENT_SERVICE_SECRET, method: "POST", path: "/invoices", body: invoiceBody,
    });
    const res = await fetch(`${PAYMENT_SERVICE_URL}/invoices`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: invoiceBody,
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && typeof body.bolt11 === "string") return body.bolt11;
    console.error("payment service refused invoice:", res.status, body);
  } catch (e) {
    console.error("payment service unreachable:", e);
  }
  return "";
}

function invoiceResponse(paymentId: string, bolt11: string, amountRequested: number, expiresAt: string) {
  const lightningUri = `lightning:${bolt11}`;
  const cashAppUrl = `https://cash.app/launch/lightning/${encodeURIComponent(bolt11)}`;
  return json({
    paymentId,
    payCode: bolt11,
    payUrl: lightningUri,
    lightningUri,
    cashAppUrl,
    amountRequested,
    expiresAt,
  });
}

// true = allowed, false = over the limit, null = could not check (fail closed).
async function claimPublic(cfg: { bucket: string; limit: number; windowSeconds: number }, keyHash: string): Promise<boolean | null> {
  const { data, error } = await supabaseAdmin.rpc("claim_public_rate_limit", {
    p_bucket: cfg.bucket, p_key_hash: keyHash, p_limit: cfg.limit, p_window_seconds: cfg.windowSeconds,
  });
  if (error) {
    console.error(`public rate-limit claim (${cfg.bucket}) failed, refusing:`, error.message);
    return null;
  }
  return data === true;
}

// The row for (link, request id); null when none, undefined on a read error.
async function findByRequest(linkId: string, requestId: string): Promise<ExistingPayment | null | undefined> {
  const { data, error } = await supabaseAdmin
    .from("payments")
    .select("id, status, amount_requested, expires_at, lightning_invoice")
    .eq("payment_link_id", linkId)
    .eq("client_request_id", requestId)
    .maybeSingle();
  if (error) {
    console.error("idempotency lookup failed:", error.message);
    return undefined;
  }
  return (data as ExistingPayment | null) ?? null;
}

async function replay(existing: ExistingPayment, chargedCents: number) {
  const decision = replayDecision(existing, chargedCents, Date.now());
  if (decision.kind === "error") return json({ error: decision.error }, decision.status);
  const bolt11 = decision.bolt11 || await requestInvoice(decision.paymentId);
  if (!bolt11) return json({ error: "Could not create invoice" }, 502);
  return invoiceResponse(decision.paymentId, bolt11, chargedCents / 100, new Date(decision.expiresAt).toISOString());
}
function json(body: unknown, status = 200) {
return new Response(JSON.stringify(body), {
status,
headers: { "Content-Type": "application/json", ...CORS_HEADERS },
});
}
