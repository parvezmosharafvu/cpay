// The Supabase Edge Runtime resolves this remote Deno import at deployment time.
// @ts-ignore The local TypeScript server cannot resolve URL imports without Deno's resolver.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createAdminVerifier } from "./admin-auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const PAYMENT_SERVICE_URL = Deno.env.get("PAYMENT_SERVICE_URL") ?? "";
const PAYMENT_SERVICE_SECRET = Deno.env.get("PAYMENT_SERVICE_SECRET") ?? "";
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

// Admin Wallet actions and the body fields each one passes on.
const WALLET_ACTIONS: Record<string, string[]> = {
    "info": [],
    "payments": ["offset", "limit"],
    "receive": ["amountSat", "memo"],
    "addresses": [],
    "send-prepare": ["destination", "amountSat"],
    "send-confirm": ["prepareId"],
    "stable-routes": [],
    "stable-quote": ["routeId", "address", "amountUsd"],
    "stable-confirm": ["quoteId"],
    "fiat": [],
};

// role = 'admin' AND account_status = 'active'; see admin-auth.ts.
const verifyAdminCaller = createAdminVerifier({
    supabaseUrl: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY, supabaseAdmin,
});
Deno.serve(async (req) => {
    const cors = await corsHeaders(req);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);
    const url = new URL(req.url);
    // ==========================================
    // ROUTE: /admin-mark-settled
    // ==========================================
    if (url.pathname.endsWith("/admin-mark-settled")) {
        const auth = await verifyAdminCaller(req);
        if (!auth.ok) return json({ error: "Unauthorized" }, 401, cors);
        try {
            const { paymentId, amountSettled } = await req.json();
            if (!paymentId) return json({ error: "paymentId required" }, 400, cors);
            // Called with the ADMIN's client, not supabaseAdmin. A service-role
            // JWT carries no `sub` claim, so auth.uid() inside admin_mark_payment()
            // is null and its is_admin() check would reject the call outright.
            const { error } = await auth.callerClient!.rpc("admin_mark_payment", {
                p_payment_id: paymentId,
                p_status: "settled",
                p_amount_settled: amountSettled ?? null,
            });
            if (error) return json({ error: error.message }, 400, cors);
            const { data: payment } = await supabaseAdmin
                .from("payments").select("user_id").eq("id", paymentId).single();
            // The Telegram message is queued by the database on the move to
            // settled (0106), the same as for a received payment.
            if (payment) await maybeQueueAutoWithdrawal(payment.user_id);
            return json({ status: "settled" }, 200, cors);
        } catch (e) {
            console.error("admin-mark-settled failed:", e);
            return json({ error: "Could not mark payment settled" }, 500, cors);
        }
    }
    // ==========================================
    // ROUTE: /process-withdrawal
    // ==========================================
    if (url.pathname.endsWith("/process-withdrawal")) {
        const auth = await verifyAdminCaller(req);
        if (!auth.ok) return json({ error: "Unauthorized" }, 401, cors);
        try {
            const { withdrawalId, action } = await req.json();
            if (!withdrawalId) return json({ error: "withdrawalId required" }, 400, cors);
            const { data: withdrawal } = await supabaseAdmin
                .from("withdrawals").select("*").eq("id", withdrawalId).single();
            if (!withdrawal) return json({ error: "Not found" }, 404, cors);
            if (action === "reject") {
                const { data: claimed } = await supabaseAdmin.rpc("system_claim_withdrawal", {
                    p_withdrawal_id: withdrawalId, p_next_status: "rejected",
                });
                if (claimed !== true) return json({ error: "Already processed" }, 409, cors);
                return json({ status: "rejected" }, 200, cors);
            }
            if (action === "mark_paid_manual") {
                const { data: claimed } = await supabaseAdmin.rpc("system_claim_withdrawal", {
                    p_withdrawal_id: withdrawalId, p_next_status: "paid",
                });
                if (claimed !== true) return json({ error: "Already processed" }, 409, cors);
                await supabaseAdmin.from("withdrawals").update({
                    admin_note: `Manually paid via ${withdrawal.method}`,
                }).eq("id", withdrawalId);
                return json({ status: "paid" }, 200, cors);
            }
            if (action === "approve") {
                // TODO(breez): pay the withdrawal through Breez SDK Spark
                // (USDT send with a prepared fee quote). Until then an admin
                // pays it outside CPAY and records it with mark_paid_manual.
                return json({ error: "Automatic payout is not available yet. Pay it manually, then mark it paid." }, 501, cors);
            }
            return json({ error: "Invalid action" }, 400, cors);
        } catch (e) {
            console.error("process-withdrawal failed:", e);
            return json({ error: "Could not process withdrawal" }, 500, cors);
        }
    }
    // ==========================================
    // ROUTE: /admin-wallet
    // The platform's own Breez wallet (admin Wallet tab). Forwards one of a
    // fixed set of actions to the payment service with the admin's id; the
    // service checks that id is an admin again before touching the wallet.
    // ==========================================
    if (url.pathname.endsWith("/admin-wallet")) {
        const auth = await verifyAdminCaller(req);
        if (!auth.ok) return json({ error: "Unauthorized" }, 401, cors);
        let body: Record<string, unknown>;
        try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400, cors); }
        const action = String(body.action ?? "");
        const fields = WALLET_ACTIONS[action];
        if (!fields) return json({ error: "Invalid action" }, 400, cors);
        if (!PAYMENT_SERVICE_URL || !PAYMENT_SERVICE_SECRET) {
            return json({ error: "The payment service is not configured" }, 503, cors);
        }
        const forward: Record<string, unknown> = { adminId: auth.userId };
        for (const f of fields) if (body[f] !== undefined) forward[f] = body[f];
        const sends = action === "send-confirm" || action === "stable-confirm";
        try {
            const res = await fetch(`${PAYMENT_SERVICE_URL}/admin/wallet/${action}`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${PAYMENT_SERVICE_SECRET}` },
                body: JSON.stringify(forward),
                signal: AbortSignal.timeout(sends ? 45000 : 20000),
            });
            return json(await res.json().catch(() => ({ error: "Bad response from the payment service" })), res.status, cors);
        } catch (e) {
            console.error(`admin-wallet ${action} failed:`, e);
            // A timed-out send may still have gone out. The wallet history
            // and the audit log show it, so say so instead of inviting a retry.
            return json({ error: sends ? "The send may still be going through. Check the history before trying again." : "The payment service did not answer" }, 502, cors);
        }
    }
    return json({ error: "Not found" }, 404, cors);
});
/**
* Auto-queue is now a thin wrapper over system_queue_withdrawal(), which
* shares the balance definition, the row lock and the fee maths with
* request_withdrawal(). The old TypeScript version computed its own
* balance from untagged payments — a different number than the dashboard
* showed, and one that double-counted money already in a manual request.
*/
async function maybeQueueAutoWithdrawal(userId: string) {
    // cspell:ignore supabase
    const { error } = await supabaseAdmin.rpc("system_queue_withdrawal", {
        p_user_id: userId,
    });
    if (error) console.error("Auto-queue failed for", userId, error.message);
}
