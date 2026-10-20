// Admin → Settings: Supabase secrets, Cloudflare Worker secrets and
// "Always Use HTTPS", write-only. See handler.ts.
//
// Secrets (Supabase dashboard → Edge Functions → Secrets), set once by the owner:
//   CPAY_SUPABASE_ACCESS_TOKEN  Supabase personal access token (also used by auth-settings).
//   CPAY_PROJECT_REF            Optional; worked out from SUPABASE_URL.
//   CPAY_CLOUDFLARE_API_TOKEN   Cloudflare API token: Workers Scripts Edit, Zone Settings Edit.
//   CPAY_CLOUDFLARE_ACCOUNT_ID  Cloudflare account id.
//   CPAY_CLOUDFLARE_ZONE_ID     Zone id of the site's domain (for Always Use HTTPS).
//   CPAY_CLOUDFLARE_WORKER      Optional; the Worker name, default "cpay" (wrangler.jsonc).
// @ts-ignore The local TypeScript server cannot resolve URL imports without Deno's resolver.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.3";
import { createHandler, type Caller } from "./handler.ts";
import { projectRefFromUrl } from "../auth-settings/handler.ts";
import { cachedHosts, corsFor } from "../_shared/cors.ts";
import { stepUpWindow } from "../_shared/step-up.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
});
const hosts = cachedHosts(
    (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    async () => {
        const { data, error } = await admin.from("site_domains").select("hostname").eq("is_active", true);
        if (error) throw error;
        return (data ?? []).map((d: { hostname: string }) => String(d.hostname));
    },
);

Deno.serve(createHandler({
    async corsHeaders(req) {
        const h = await corsFor(req, hosts);
        h["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
        return h;
    },
    // Same rule as the database's is_admin(): role admin and an active account.
    async verifyAdmin(req) {
        const authHeader = req.headers.get("Authorization");
        if (!authHeader) return { ok: false, status: 401, error: "Unauthorized" };
        const caller = createClient(SUPABASE_URL, ANON, {
            global: { headers: { Authorization: authHeader } },
            auth: { persistSession: false, autoRefreshToken: false },
        });
        const { data: { user }, error } = await caller.auth.getUser();
        if (error || !user) return { ok: false, status: 401, error: "Unauthorized" };
        const { data: profile } = await admin.from("profiles").select("role, account_status, email").eq("id", user.id).single();
        if (profile?.role !== "admin" || profile?.account_status !== "active") return { ok: false, status: 403, error: "Admins only" };
        return { ok: true, caller: { userId: user.id, email: profile?.email ?? user.email ?? null, authHeader, user } };
    },
    // audit_log (name only, never a value) and a security notice for every
    // active admin, which they cannot hide (20261020060000).
    async record(c: Caller, action: string, subject: string, detail: Record<string, unknown>) {
        const { error } = await admin.from("audit_log").insert({
            actor_id: c.userId, actor_email: c.email, action, subject_type: "settings", subject_id: subject,
            new_value: detail, note: "Changed from Admin → Settings (owner-config). Values are never stored or shown.",
        });
        if (error) console.error("audit_log write failed for", action);
        const { data: admins } = await admin.from("profiles").select("id").eq("role", "admin").eq("account_status", "active");
        const what = action === "settings.cloudflare"
            ? `Cloudflare "Always Use HTTPS" was turned ${detail.on ? "on" : "off"}`
            : `the secret ${subject.replace(":", " ")} was ${detail.action === "delete" ? "deleted" : "set"}`;
        const rows = (admins ?? []).map((a: { id: string }) => ({
            user_id: a.id, sender: "admin", read_by_admin: true, security_notice: true,
            message: `Security notice: ${what} by ${c.email ?? "an admin"} at ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC. If this was not you, sign out everywhere and change your password now.`,
        }));
        if (rows.length) {
            const { error: e2 } = await admin.from("support_messages").insert(rows);
            if (e2) console.error("security notice insert failed for", action);
        }
        return !error;
    },
    stepUpSeconds: stepUpWindow(Deno.env.get("STEP_UP_MAX_AGE_SECONDS")),
    supabase: {
        token: Deno.env.get("CPAY_SUPABASE_ACCESS_TOKEN") || (Deno.env.get("SUPABASE_ACCESS_TOKEN") ?? ""),
        projectRef: (Deno.env.get("CPAY_PROJECT_REF") ?? "").trim() || projectRefFromUrl(SUPABASE_URL),
        // Fixed on purpose: the tokens are only ever sent to their own provider.
        api: "https://api.supabase.com",
    },
    cloudflare: {
        token: Deno.env.get("CPAY_CLOUDFLARE_API_TOKEN") ?? "",
        accountId: (Deno.env.get("CPAY_CLOUDFLARE_ACCOUNT_ID") ?? "").trim(),
        zoneId: (Deno.env.get("CPAY_CLOUDFLARE_ZONE_ID") ?? "").trim(),
        worker: (Deno.env.get("CPAY_CLOUDFLARE_WORKER") ?? "").trim() || "cpay",
        api: "https://api.cloudflare.com/client/v4",
    },
}));
