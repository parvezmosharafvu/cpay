// owner-config: Admin → Settings → "Secrets & keys" and "Cloudflare".
//
//   GET                         -> names of the Supabase Edge Function secrets
//                                  and the Cloudflare Worker secrets, and the
//                                  Cloudflare "Always Use HTTPS" state.
//                                  Never a value.
//   POST {target, action, ...}  -> one change:
//        target "supabase" | "cloudflare", action "set" {name, value}
//        target "supabase" | "cloudflare", action "delete" {name}
//        target "cloudflare", action "always_https" {on: boolean}
//
// Write-only on purpose: a value goes in once and is never shown, logged,
// echoed or returned again, so a stolen admin session cannot read a key.
// Every call needs an active admin at aal2; a change also needs a fresh
// sign-in (STEP_UP_MAX_AGE_SECONDS, default 10 minutes). Each change is
// written to audit_log (name only) and every active admin gets a security
// notice in their inbox.
//
// PROTECTED names cannot be set or deleted here: the wallet's recovery
// words and storage (changing them loses access to the wallet), and the
// access tokens this function itself runs on (a stolen session must not be
// able to swap them). Those change only in the Supabase dashboard.
//
// Kept apart from index.ts so the test runs it against local mock servers.

import { checkStepUp, decodeJwtPayload, sessionIsStrong } from "../_shared/step-up.ts";

export const PROTECTED: ReadonlySet<string> = new Set([
    "BREEZ_MNEMONIC", "BREEZ_DB_URL", "BREEZ_API_KEY", "BREEZ_NETWORK",
    "CPAY_SUPABASE_ACCESS_TOKEN", "SUPABASE_ACCESS_TOKEN", "CPAY_PROJECT_REF",
    "CPAY_CLOUDFLARE_API_TOKEN", "CPAY_CLOUDFLARE_ACCOUNT_ID", "CPAY_CLOUDFLARE_ZONE_ID", "CPAY_CLOUDFLARE_WORKER",
    "STEP_UP_MAX_AGE_SECONDS",
]);
const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_VALUE = 8192;

export interface Caller { userId: string; email: string | null; authHeader: string; user: { factors?: Array<{ status?: string }> | null } }

export interface OwnerConfig {
    /** Resolves the caller: an active admin, or a refusal. */
    verifyAdmin(req: Request): Promise<{ ok: true; caller: Caller } | { ok: false; status: number; error: string }>;
    /** audit_log row + admin notices; returns false when the audit write failed. */
    record(caller: Caller, action: string, subject: string, detail: Record<string, unknown>): Promise<boolean>;
    corsHeaders(req: Request): Promise<Record<string, string>>;
    stepUpSeconds: number;
    supabase: { token: string; projectRef: string; api: string };
    cloudflare: { token: string; accountId: string; zoneId: string; worker: string; api: string };
}

class ApiError extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
}

export function validName(target: string, name: unknown): string {
    const n = String(name ?? "").trim();
    if (!NAME_RE.test(n)) throw new ApiError(400, "bad_name", "Use capital letters, digits and _ only, starting with a letter (for example MY_KEY).");
    if (target === "supabase" && n.startsWith("SUPABASE_")) throw new ApiError(400, "reserved", "Names starting with SUPABASE_ are set by Supabase itself.");
    if (PROTECTED.has(n)) throw new ApiError(403, "protected", `${n} is protected: change it only in the Supabase dashboard (Edge Functions → Secrets).`);
    return n;
}

export function validValue(value: unknown): string {
    if (typeof value !== "string" || value.length === 0) throw new ApiError(400, "bad_value", "Enter a value.");
    if (value.length > MAX_VALUE) throw new ApiError(400, "bad_value", `The value is too long (max ${MAX_VALUE} characters).`);
    if (value !== value.trim()) throw new ApiError(400, "bad_value", "The value starts or ends with a space or a new line. Remove it and try again.");
    return value;
}

export function createHandler(cfg: OwnerConfig): (req: Request) => Promise<Response> {
    const sbBase = cfg.supabase.api.replace(/\/+$/, "");
    const cfBase = cfg.cloudflare.api.replace(/\/+$/, "");
    const sbReady = !!(cfg.supabase.token && cfg.supabase.projectRef);
    const cfReady = !!(cfg.cloudflare.token && cfg.cloudflare.accountId && cfg.cloudflare.worker);
    const httpsReady = !!(cfg.cloudflare.token && cfg.cloudflare.zoneId);

    function json(body: unknown, status: number, cors: Record<string, string>) {
        return new Response(JSON.stringify(body), {
            status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors },
        });
    }

    async function call(kind: "supabase" | "cloudflare", url: string, method: string, body?: unknown): Promise<unknown> {
        const token = kind === "supabase" ? cfg.supabase.token : cfg.cloudflare.token;
        let res: Response;
        try {
            res = await fetch(url, {
                method,
                headers: {
                    "Authorization": `Bearer ${token}`, "Accept": "application/json",
                    ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
                },
                body: body !== undefined ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(10000),
            });
        } catch {
            throw new ApiError(502, "unreachable", `Could not reach ${kind === "supabase" ? "Supabase" : "Cloudflare"}. Try again in a minute.`);
        }
        if (res.status === 401 || res.status === 403) {
            await res.body?.cancel();
            const secret = kind === "supabase" ? "CPAY_SUPABASE_ACCESS_TOKEN" : "CPAY_CLOUDFLARE_API_TOKEN";
            throw new ApiError(502, "token_rejected", `${kind === "supabase" ? "Supabase" : "Cloudflare"} refused the access token (HTTP ${res.status}). Check the ${secret} secret and its permissions.`);
        }
        if (res.status === 429) { await res.body?.cancel(); throw new ApiError(429, "rate_limited", "Too many requests. Wait a minute and try again."); }
        const text = await res.text();
        let data: unknown = null;
        try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
        if (!res.ok) {
            // The provider's own message, short; never the request.
            const d = data as { message?: unknown; errors?: Array<{ message?: unknown }> } | null;
            const detail = String(d?.message ?? d?.errors?.[0]?.message ?? "").slice(0, 200);
            throw new ApiError(502, "provider_error", `${kind === "supabase" ? "Supabase" : "Cloudflare"} returned HTTP ${res.status}${detail ? `: ${detail}` : ""}.`);
        }
        return data;
    }

    const sbSecrets = () => `${sbBase}/v1/projects/${encodeURIComponent(cfg.supabase.projectRef)}/secrets`;
    const cfSecrets = () => `${cfBase}/accounts/${encodeURIComponent(cfg.cloudflare.accountId)}/workers/scripts/${encodeURIComponent(cfg.cloudflare.worker)}/secrets`;
    const cfHttps = () => `${cfBase}/zones/${encodeURIComponent(cfg.cloudflare.zoneId)}/settings/always_use_https`;

    async function status() {
        const out: Record<string, unknown> = { protected: [...PROTECTED] };
        const errMsg = (e: unknown) => e instanceof ApiError ? e.message : "Could not read";
        if (sbReady) {
            try {
                const list = await call("supabase", sbSecrets(), "GET") as Array<{ name?: unknown }>;
                out.supabase = { ready: true, secrets: (Array.isArray(list) ? list : []).map((s) => String(s?.name ?? "")).filter(Boolean).sort() };
            } catch (e) { out.supabase = { ready: true, error: errMsg(e) }; }
        } else out.supabase = { ready: false, missing: ["CPAY_SUPABASE_ACCESS_TOKEN"] };
        if (cfReady) {
            try {
                const r = await call("cloudflare", cfSecrets(), "GET") as { result?: Array<{ name?: unknown }> };
                out.cloudflare = { ready: true, worker: cfg.cloudflare.worker, secrets: (r?.result ?? []).map((s) => String(s?.name ?? "")).filter(Boolean).sort() };
            } catch (e) { out.cloudflare = { ready: true, worker: cfg.cloudflare.worker, error: errMsg(e) }; }
        } else out.cloudflare = { ready: false, missing: ["CPAY_CLOUDFLARE_API_TOKEN", "CPAY_CLOUDFLARE_ACCOUNT_ID"].filter((n) => n === "CPAY_CLOUDFLARE_API_TOKEN" ? !cfg.cloudflare.token : !cfg.cloudflare.accountId) };
        if (httpsReady) {
            try {
                const r = await call("cloudflare", cfHttps(), "GET") as { result?: { value?: unknown } };
                out.always_https = { ready: true, on: r?.result?.value === "on" };
            } catch (e) { out.always_https = { ready: true, error: errMsg(e) }; }
        } else out.always_https = { ready: false, missing: ["CPAY_CLOUDFLARE_API_TOKEN", "CPAY_CLOUDFLARE_ZONE_ID"].filter((n) => n === "CPAY_CLOUDFLARE_API_TOKEN" ? !cfg.cloudflare.token : !cfg.cloudflare.zoneId) };
        return out;
    }

    async function change(caller: Caller, body: Record<string, unknown>) {
        const target = body.target, action = body.action;
        if (target !== "supabase" && target !== "cloudflare") throw new ApiError(400, "bad_target", "target must be supabase or cloudflare");
        if (target === "supabase" && !sbReady) throw new ApiError(503, "not_set_up", "Not set up: add the CPAY_SUPABASE_ACCESS_TOKEN secret in the Supabase dashboard first.");
        if (target === "cloudflare" && action === "always_https") {
            if (!httpsReady) throw new ApiError(503, "not_set_up", "Not set up: add the CPAY_CLOUDFLARE_API_TOKEN and CPAY_CLOUDFLARE_ZONE_ID secrets first.");
            if (typeof body.on !== "boolean") throw new ApiError(400, "bad_value", "on must be true or false");
            await call("cloudflare", cfHttps(), "PATCH", { value: body.on ? "on" : "off" });
            const audited = await cfg.record(caller, "settings.cloudflare", "always_use_https", { on: body.on });
            return { done: true, audited };
        }
        if (target === "cloudflare" && !cfReady) throw new ApiError(503, "not_set_up", "Not set up: add the CPAY_CLOUDFLARE_API_TOKEN and CPAY_CLOUDFLARE_ACCOUNT_ID secrets first.");
        if (action !== "set" && action !== "delete") throw new ApiError(400, "bad_action", "action must be set or delete");
        const name = validName(target, body.name);
        if (action === "set") {
            const value = validValue(body.value);
            if (target === "supabase") await call("supabase", sbSecrets(), "POST", [{ name, value }]);
            else await call("cloudflare", cfSecrets(), "PUT", { name, text: value, type: "secret_text" });
        } else {
            if (target === "supabase") await call("supabase", sbSecrets(), "DELETE", [name]);
            else await call("cloudflare", `${cfSecrets()}/${encodeURIComponent(name)}`, "DELETE");
        }
        const audited = await cfg.record(caller, "settings.secret", `${target}:${name}`, { action });
        return { done: true, name, audited };
    }

    return async (req: Request): Promise<Response> => {
        const cors = await cfg.corsHeaders(req);
        if (req.method === "OPTIONS") return new Response(null, { headers: cors });
        if (req.method !== "GET" && req.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);
        const auth = await cfg.verifyAdmin(req);
        if (!auth.ok) return json({ error: auth.error }, auth.status, cors);
        const caller = auth.caller;
        // Two-step sign-in is required here for every admin, always.
        if (!sessionIsStrong(caller.authHeader)) {
            return json({ error: "Sign in again with your passkey, then repeat this.", code: "aal2_required" }, 403, cors);
        }
        try {
            if (req.method === "GET") return json(await status(), 200, cors);
            const step = checkStepUp(caller.authHeader.replace(/^Bearer\s+/i, ""), caller.user, cfg.stepUpSeconds > 0 ? cfg.stepUpSeconds : 600);
            if (!step.ok) return json({ error: "For your security, sign in again with your passkey, then repeat the change.", code: "reauth_required" }, 403, cors);
            let body: Record<string, unknown>;
            try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400, cors); }
            return json(await change(caller, body ?? {}), 200, cors);
        } catch (e) {
            if (e instanceof ApiError) return json({ error: e.message, code: e.code }, e.status, cors);
            console.error("owner-config failed:", (e as Error)?.name ?? "error");
            return json({ error: "Could not complete the request" }, 500, cors);
        }
    };
}
