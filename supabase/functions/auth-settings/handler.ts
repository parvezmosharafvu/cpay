// auth-settings: the admin panel's switch for sign-up email confirmation.
//
//   GET   -> { email_confirmation_required }
//   POST  { email_confirmation_required: boolean } -> the new state
//
// The setting is not in our database. It is Supabase Auth's own
// "Confirm email" option, read and changed through the Supabase Management
// API (GET/PATCH /v1/projects/{ref}/config/auth). There the field is
// `mailer_autoconfirm`, which is the inverse of what the admin sees:
//
//   mailer_autoconfirm = true   -> no confirmation email, sign-ups can log in
//                                  with email and password straight away
//   mailer_autoconfirm = false  -> Supabase's normal confirm-your-email flow
//
// The Management API needs a personal access token, which is account-wide:
// it can change or delete every project its owner can reach. So:
//   * only an admin (the same check admin-actions uses) gets this far,
//   * the token lives only in the edge-function secret and is never logged,
//     echoed or returned,
//   * the full auth config the Management API returns (it includes SMTP and
//     OAuth secrets) is never passed back. Only the one boolean leaves.
//
// Kept apart from index.ts so the test can run it against local mock
// servers with no real network and no real token.

// The Supabase Edge Runtime resolves this remote Deno import at deployment time.
// @ts-ignore The local TypeScript server cannot resolve URL imports without Deno's resolver.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface AuthSettingsConfig {
    supabaseUrl: string;
    anonKey: string;
    serviceRoleKey: string;
    /** Supabase personal access token. Empty = the switch is not set up. */
    accessToken: string;
    /** Project ref. Empty = the switch is not set up. */
    projectRef: string;
    /** https://api.supabase.com in production; a local mock in tests. */
    managementApiUrl: string;
    /** ALLOWED_ORIGINS, merged on top of site_domains like admin-actions. */
    staticOrigins?: string[];
    /** Name of the token secret, for error messages only. */
    tokenSecretName?: string;
}

/** "https://abcd1234.supabase.co" -> "abcd1234". Empty when it is not that shape. */
export function projectRefFromUrl(url: string): string {
    try {
        const host = new URL(url).hostname.toLowerCase();
        const m = host.match(/^([a-z0-9]{6,40})\.supabase\.(co|in|net)$/);
        return m ? m[1] : "";
    } catch {
        return "";
    }
}

function normalizeOriginHost(value: string): string {
    const trimmed = value.trim().replace(/\/+$/, "");
    try {
        return new URL(trimmed).host.toLowerCase();
    } catch {
        return trimmed.toLowerCase();
    }
}

class MgmtError extends Error {
    constructor(public status: number, public code: string, message: string) {
        super(message);
    }
}

export function createHandler(cfg: AuthSettingsConfig): (req: Request) => Promise<Response> {
    const supabaseAdmin = createClient(cfg.supabaseUrl, cfg.serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    const staticOrigins = (cfg.staticOrigins ?? []).filter(Boolean);
    const tokenName = cfg.tokenSecretName ?? "CPAY_SUPABASE_ACCESS_TOKEN";
    const mgmtBase = cfg.managementApiUrl.replace(/\/+$/, "");

    // CORS: same rule as admin-actions. Active site_domains plus ALLOWED_ORIGINS.
    const DOMAIN_CACHE_MS = 5 * 60 * 1000;
    let domainCache: { hosts: Set<string>; fetchedAt: number } | null = null;
    async function allowedHosts(): Promise<Set<string>> {
        if (domainCache && Date.now() - domainCache.fetchedAt < DOMAIN_CACHE_MS) return domainCache.hosts;
        const hosts = new Set<string>(staticOrigins.map(normalizeOriginHost));
        try {
            const { data, error } = await supabaseAdmin
                .from("site_domains").select("hostname").eq("is_active", true);
            if (error) throw error;
            for (const d of data ?? []) if (d.hostname) hosts.add(String(d.hostname).toLowerCase());
        } catch (e) {
            console.error("site_domains lookup failed, using cached/static origins:", e);
            return domainCache?.hosts ?? new Set(staticOrigins.map(normalizeOriginHost));
        }
        domainCache = { hosts, fetchedAt: Date.now() };
        return hosts;
    }
    async function corsHeaders(req: Request): Promise<Record<string, string>> {
        const h: Record<string, string> = {
            "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Vary": "Origin",
        };
        const origin = req.headers.get("Origin");
        if (!origin) return h;
        let originHost = "";
        try { originHost = new URL(origin).host.toLowerCase(); } catch { return h; }
        if ((await allowedHosts()).has(originHost)) h["Access-Control-Allow-Origin"] = origin;
        return h;
    }
    function json(body: unknown, status: number, cors: Record<string, string>) {
        return new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors },
        });
    }

    // The same admin check as admin-actions' verifyAdminCaller(): the caller's
    // JWT must resolve to a user, and that user's profile role must be admin.
    async function verifyAdminCaller(req: Request): Promise<
        { ok: true; userId: string; email: string | null } | { ok: false; status: number; error: string }
    > {
        const authHeader = req.headers.get("Authorization");
        if (!authHeader) return { ok: false, status: 401, error: "Unauthorized" };
        const callerClient = createClient(cfg.supabaseUrl, cfg.anonKey, {
            global: { headers: { Authorization: authHeader } },
            auth: { persistSession: false, autoRefreshToken: false },
        });
        const { data: { user }, error } = await callerClient.auth.getUser();
        if (error || !user) return { ok: false, status: 401, error: "Unauthorized" };
        const { data: profile } = await supabaseAdmin
            .from("profiles").select("role, email").eq("id", user.id).single();
        if (profile?.role !== "admin") return { ok: false, status: 403, error: "Admins only" };
        return { ok: true, userId: user.id, email: profile?.email ?? user.email ?? null };
    }

    async function mgmt(method: "GET" | "PATCH", body?: unknown): Promise<Record<string, unknown>> {
        let res: Response;
        try {
            res = await fetch(`${mgmtBase}/v1/projects/${encodeURIComponent(cfg.projectRef)}/config/auth`, {
                method,
                headers: {
                    "Authorization": `Bearer ${cfg.accessToken}`,
                    "Accept": "application/json",
                    ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
                },
                body: body !== undefined ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(10000),
            });
        } catch (e) {
            console.error(`Management API ${method} failed to connect:`, (e as Error)?.name ?? "error");
            throw new MgmtError(502, "management_unreachable", "Could not reach the Supabase Management API. Try again in a minute.");
        }
        if (res.status === 401 || res.status === 403) {
            await res.body?.cancel();
            throw new MgmtError(502, "token_rejected",
                `Supabase rejected the access token (HTTP ${res.status}). Check that the ${tokenName} secret is a valid personal access token whose owner can manage this project.`);
        }
        if (res.status === 429) {
            await res.body?.cancel();
            throw new MgmtError(429, "rate_limited", "The Supabase Management API is rate limiting requests. Wait a minute and try again.");
        }
        if (!res.ok) {
            // The error body is Supabase's own message; keep it short and never
            // include request headers.
            let detail = "";
            try { detail = String((await res.json())?.message ?? "").slice(0, 200); } catch { /* ignore */ }
            console.error(`Management API ${method} returned ${res.status}`);
            throw new MgmtError(502, "management_error",
                `The Supabase Management API returned HTTP ${res.status}${detail ? `: ${detail}` : ""}.`);
        }
        const data = await res.json().catch(() => null);
        if (!data || typeof data !== "object") {
            throw new MgmtError(502, "management_error", "The Supabase Management API returned an unreadable response.");
        }
        return data as Record<string, unknown>;
    }

    function stateFrom(config: Record<string, unknown>): boolean {
        const v = config.mailer_autoconfirm;
        if (typeof v !== "boolean") {
            throw new MgmtError(502, "management_error", "The auth config from Supabase has no mailer_autoconfirm value.");
        }
        return !v; // email_confirmation_required
    }

    return async (req: Request): Promise<Response> => {
        const cors = await corsHeaders(req);
        if (req.method === "OPTIONS") return new Response(null, { headers: cors });
        if (req.method !== "GET" && req.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

        const auth = await verifyAdminCaller(req);
        if (!auth.ok) return json({ error: auth.error }, auth.status, cors);

        if (!cfg.accessToken) {
            return json({
                error: `Not set up: add a Supabase personal access token as the edge-function secret ${tokenName}. Until then the email confirmation setting can only be changed in the Supabase dashboard (Authentication > Sign In / Providers > Email > Confirm email).`,
                code: "missing_token",
            }, 503, cors);
        }
        if (!cfg.projectRef) {
            return json({
                error: "Not set up: the project ref could not be worked out from SUPABASE_URL. Add it as the edge-function secret CPAY_PROJECT_REF.",
                code: "missing_project_ref",
            }, 503, cors);
        }

        try {
            if (req.method === "GET") {
                const required = stateFrom(await mgmt("GET"));
                return json({ email_confirmation_required: required }, 200, cors);
            }

            let body: Record<string, unknown>;
            try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400, cors); }
            const wanted = body?.email_confirmation_required;
            if (typeof wanted !== "boolean") {
                return json({ error: "email_confirmation_required must be true or false" }, 400, cors);
            }

            const before = stateFrom(await mgmt("GET"));
            if (before === wanted) {
                return json({ email_confirmation_required: before, changed: false }, 200, cors);
            }
            const after = await mgmt("PATCH", { mailer_autoconfirm: !wanted });
            // PATCH answers with the whole config. If it carries the field, it
            // must now say what was asked for.
            if (typeof after.mailer_autoconfirm === "boolean" && after.mailer_autoconfirm !== !wanted) {
                throw new MgmtError(502, "management_error", "Supabase accepted the change but still reports the old value. Reload and check.");
            }

            // audit_log (0047) is append-only with no client insert policy; the
            // service role writes it here, the way payment-service/wallet.mjs
            // does. A failed audit write is logged but does not undo the change,
            // same rule as record_audit().
            let audited = true;
            const { error: auditError } = await supabaseAdmin.from("audit_log").insert({
                actor_id: auth.userId,
                actor_email: auth.email,
                action: "settings.signup_email_confirmation",
                subject_type: "settings",
                subject_id: "auth.mailer_autoconfirm",
                old_value: { email_confirmation_required: before, mailer_autoconfirm: !before },
                new_value: { email_confirmation_required: wanted, mailer_autoconfirm: !wanted },
                note: "Supabase Auth config changed through the Management API from the admin panel.",
            });
            if (auditError) {
                audited = false;
                console.error("audit_log write failed for settings.signup_email_confirmation:", auditError.message);
            }
            return json({ email_confirmation_required: wanted, changed: true, audited }, 200, cors);
        } catch (e) {
            if (e instanceof MgmtError) return json({ error: e.message, code: e.code }, e.status, cors);
            console.error("auth-settings failed:", (e as Error)?.message ?? e);
            return json({ error: "Could not read or change the email confirmation setting" }, 500, cors);
        }
    };
}
