import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { formatCents, parseAmountToCents, toCents } from "../_shared/money.ts";
import { serviceAuthHeaders, serviceAuthMode } from "../_shared/service-auth.ts";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PAYMENT_SERVICE_URL = Deno.env.get("PAYMENT_SERVICE_URL") ?? "";
const PAYMENT_SERVICE_SECRET = Deno.env.get("PAYMENT_SERVICE_SECRET") ?? "";
const PAYMENT_SERVICE_AUTH_MODE = serviceAuthMode(Deno.env.get("PAYMENT_SERVICE_AUTH_MODE"));
const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
// Only browser calls need CORS (server-to-server callers like pg_cron
// ignore these headers entirely). The allowed-origin list is read
// from the site_domains table — the same registry the admin panel manages —
// so adding a domain in the admin panel enables it here within one cache
// window, with no secret change and no redeploy. The optional ALLOWED_ORIGINS
// secret is merged on top (comma-separated; accepts full URLs or bare hosts).
/**
* A CORS host, normalized exactly one way everywhere it is used.
*
* ALLOWED_ORIGINS can hold a full URL ("https://pay.example.com") or a
* bare host ("pay.example.com"); the database's site_domains.hostname is
* always bare. The normal path already reduced everything to bare,
* lowercase hosts before comparing — but the fallback taken when the
* database lookup fails returned STATIC_ORIGINS unnormalized. With a
* full-URL secret, that meant the working path compared "pay.example.com"
* while the fallback compared "https://pay.example.com": never equal, so
* every browser request lost its CORS header for as long as the fallback
* was active. Not an auth bypass — an availability bug that only showed
* up during a database hiccup, which is exactly when a payout or a
* payment matters most.
*/
function normalizeOriginHost(value: string): string {
const trimmed = value.trim().replace(/\/+$/, "");
try {
return new URL(trimmed).host.toLowerCase();
} catch {
return trimmed.toLowerCase();
}
}

const STATIC_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
.split(",").map((s) => s.trim()).filter(Boolean);
const DOMAIN_CACHE_MS = 5 * 60 * 1000;
let domainCache: { hosts: Set<string>; fetchedAt: number } | null = null;

async function allowedHosts(): Promise<Set<string>> {
if (domainCache && Date.now() - domainCache.fetchedAt < DOMAIN_CACHE_MS) {
return domainCache.hosts;
}
const hosts = new Set<string>();
for (const o of STATIC_ORIGINS) hosts.add(normalizeOriginHost(o));
try {
const { data, error } = await supabaseAdmin
.from("site_domains").select("hostname").eq("is_active", true);
if (error) throw error;
for (const d of data ?? []) if (d.hostname) hosts.add(String(d.hostname).toLowerCase());
} catch (e) {
// If the lookup fails, fall back to whatever the last good cache had;
// failing closed here would lock every browser out of payments.
console.error("site_domains lookup failed, using cached/static origins:", e);
return domainCache?.hosts ?? new Set(STATIC_ORIGINS.map(normalizeOriginHost));
}
domainCache = { hosts, fetchedAt: Date.now() };
return hosts;
}

async function corsHeaders(req: Request): Promise<Record<string, string>> {
const h: Record<string, string> = {
"Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
"Access-Control-Allow-Methods": "POST, OPTIONS",
"Vary": "Origin",
};
const origin = req.headers.get("Origin");
if (!origin) return h; // server-to-server call: no CORS needed at all
let originHost = "";
try { originHost = new URL(origin).host.toLowerCase(); } catch { return h; }
if ((await allowedHosts()).has(originHost)) {
h["Access-Control-Allow-Origin"] = origin;
}
return h;
}
function json(body: unknown, status = 200, cors: Record<string, string> = {}) {
return new Response(JSON.stringify(body), {
status,
headers: { "Content-Type": "application/json", ...cors },
});
}
// Manual payout methods (bKash / Nagad / Binance / bank / Lightning payout)
// are closed. The only product path is USDT/USDC via routes/quote/confirm.
// request_withdrawal() in SQL also raises for any method.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Calls the payment service, which holds the platform wallet.
async function paymentService(path: string, init: { method: string; body?: unknown }, timeoutMs: number) {
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  const auth = await serviceAuthHeaders({
    mode: PAYMENT_SERVICE_AUTH_MODE, secret: PAYMENT_SERVICE_SECRET, method: init.method, path, body: body ?? "",
  });
  const res = await fetch(`${PAYMENT_SERVICE_URL}${path}`, {
    method: init.method,
    headers: { "Content-Type": "application/json", ...auth },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await res.json().catch(() => ({}));
  return { status: res.status, payload };
}

// What the browser may see. Freelancers get an allowlisted
// copy of each payment-service answer: no processor name, payment ids, sats,
// rates, provider or admin notes, and the swap plus network fee travels as
// networkFeeUsd. A field the service adds later stays server-side until it
// is added here.
type Json = Record<string, unknown>;
const str = (v: unknown) => (v === undefined || v === null ? null : String(v));
const PROVIDER_WORDS = /breez|spark|sdk|orchestra|boltz|internal error/i;
const GENERIC_ERROR = "Instant withdrawals are temporarily unavailable. Try again later.";

// Service error messages are written for users, but anything that names the
// processor or looks like a raw library error is replaced.
function publicError(payload: Json | null | undefined, fallback = GENERIC_ERROR): string {
  const msg = typeof payload?.error === "string" ? payload.error : "";
  if (!msg || msg.length > 200 || PROVIDER_WORDS.test(msg)) return fallback;
  return msg;
}

function publicRoute(r: Json) {
  return {
    id: str(r.id), asset: str(r.asset), chain: str(r.chain), family: str(r.family),
    minUsd: r.minUsd ?? null, maxUsd: r.maxUsd ?? null,
  };
}

function publicQuote(q: Json) {
  const route = (q.route ?? {}) as Json;
  return {
    quoteId: str(q.quoteId), expiresAt: str(q.expiresAt),
    route: { id: str(route.id), asset: str(route.asset), chain: str(route.chain), family: str(route.family) },
    address: str(q.address), asset: str(q.asset),
    amountUsd: str(q.amountUsd), feePercent: str(q.feePercent), platformFeeUsd: str(q.platformFeeUsd),
    sendUsd: str(q.sendUsd), networkFeeUsd: str(q.networkFeeUsd),
    receive: str(q.receive), receiveMin: str(q.receiveMin), maxSlippageBps: q.maxSlippageBps ?? null,
  };
}

function publicWithdrawal(w: Json) {
  return {
    withdrawalId: str(w.withdrawalId), status: str(w.status),
    amountUsd: str(w.amountUsd), feePercent: str(w.feePercent), sendUsd: str(w.sendUsd),
    asset: str(w.asset), chain: str(w.chain), address: str(w.address), amountOut: str(w.amountOut),
    requestedAt: str(w.requestedAt), processedAt: str(w.processedAt),
  };
}

type Body = {
  action?: unknown; amount?: unknown; method?: unknown; destination?: unknown;
  routeId?: unknown; address?: unknown; quoteId?: unknown;
};

Deno.serve(async (req) => {
  const cors = await corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Unauthorized" }, 401, cors);
  // The caller client carries the user's JWT, so the RPCs below run as that
  // user and every check inside them (auth, balance, fee, row lock) applies.
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userErr } = await callerClient.auth.getUser();
  if (userErr || !user) return json({ error: "Invalid session" }, 401, cors);
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400, cors);
  }
  const action = String(body.action ?? "request");

  if (action === "routes" || action === "quote" || action === "confirm") {
    if (!PAYMENT_SERVICE_URL || !PAYMENT_SERVICE_SECRET) {
      console.error("PAYMENT_SERVICE_URL or PAYMENT_SERVICE_SECRET is not set");
      return json({ error: "Instant withdrawals are temporarily unavailable" }, 503, cors);
    }
    try {
      if (action === "routes") {
        const { status, payload } = await paymentService("/withdraw/routes", { method: "GET" }, 15000);
        const routes = Array.isArray(payload.routes) ? payload.routes.map(publicRoute) : [];
        return json(status === 200 ? { routes } : { error: "Could not load networks" }, status === 200 ? 200 : 502, cors);
      }
      if (action === "quote") {
        const amount = String(body.amount ?? "").trim();
        // Integer cents throughout; at most two decimals as before.
        const amountCents = /^\d+(\.\d{1,2})?$/.test(amount) ? parseAmountToCents(amount) : null;
        if (amountCents === null || amountCents < 500) {
          return json({ error: "Minimum withdrawal is $5" }, 400, cors);
        }
        // Early answer for the common mistake. The payment service checks
        // again, and reserve_stablecoin_withdrawal() decides at confirm.
        const { data: bal, error: balErr } = await callerClient.rpc("get_my_balance");
        if (balErr) return json({ error: balErr.message }, 400, cors);
        const availableCents = toCents((Array.isArray(bal) ? bal[0] : bal)?.available ?? 0, "floor") ?? 0;
        if (amountCents > availableCents) {
          return json({ error: `Insufficient balance. Available: $${formatCents(Math.max(0, availableCents))}` }, 400, cors);
        }
        const { status, payload } = await paymentService("/withdraw/quote", {
          method: "POST",
          body: { userId: user.id, routeId: String(body.routeId ?? ""), address: String(body.address ?? "").trim(), amountUsd: amount },
        }, 30000);
        if (status !== 200) return json({ error: publicError(payload, "Could not get a quote. Try again.") }, status, cors);
        return json(publicQuote(payload), 200, cors);
      }
      const quoteId = String(body.quoteId ?? "");
      if (!UUID.test(quoteId)) return json({ error: "Get a quote first" }, 400, cors);
      const { status, payload } = await paymentService("/withdraw/confirm", {
        method: "POST", body: { userId: user.id, quoteId },
      }, 45000);
      if (status === 200) return json(publicWithdrawal(payload), 200, cors);
      // An expired quote comes back with a fresh one to show.
      const fresh = payload?.quote ? { quote: publicQuote(payload.quote as Json) } : {};
      return json({ error: publicError(payload, "The withdrawal did not go through. Try again."), ...fresh }, status, cors);
    } catch (e) {
      console.error(`payment service ${action} failed:`, e);
      // A confirm that timed out may still have reserved and sent. The row
      // is in the user's withdrawals either way, so say so rather than
      // inviting a second attempt.
      const msg = action === "confirm"
        ? "The withdrawal may still be going through. Check your withdrawals before trying again."
        : "Instant withdrawals are temporarily unavailable";
      return json({ error: msg }, 502, cors);
    }
  }

  // Anything other than routes / quote / confirm is the retired manual path.
  // SQL request_withdrawal() also raises; refuse here so the edge function
  // never names closed payout methods or Lightning payout destinations.
  return json({
    error: "Only USDT to a saved wallet address is supported. Use quote and confirm.",
  }, 410, cors);
});
