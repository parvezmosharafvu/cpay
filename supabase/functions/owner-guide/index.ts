// owner-guide Edge Function: wiring only (logic in handler.ts).
// Secrets: CPAY_OWNER_USER_ID (the owner's auth user id; not a secret value,
// but set it only as an Edge secret). SUPABASE_* are set by Supabase.
// @ts-ignore URL import resolved by the Edge Runtime.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.3";
import { createHandler } from "./handler.ts";
import { GUIDE_HTML } from "./guide.ts";
import { cachedHosts, corsFor } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const service = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
});
const hosts = cachedHosts(
    (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    async () => {
        const { data, error } = await service.from("site_domains").select("hostname").eq("is_active", true);
        if (error) throw error;
        return (data ?? []).map((d: { hostname: string }) => String(d.hostname));
    },
);

Deno.serve(createHandler({
    ownerUserId: Deno.env.get("CPAY_OWNER_USER_ID") ?? "",
    html: GUIDE_HTML,
    async corsHeaders(req) {
        const h = await corsFor(req, hosts);
        h["Access-Control-Allow-Methods"] = "GET, OPTIONS";
        return h;
    },
    async caller(req) {
        const authHeader = req.headers.get("Authorization") ?? "";
        const client = createClient(SUPABASE_URL, ANON, {
            global: { headers: { Authorization: authHeader } },
            auth: { persistSession: false, autoRefreshToken: false },
        });
        const { data: { user }, error } = await client.auth.getUser();
        if (error || !user) return null;
        const { data: p } = await service.from("profiles").select("role, account_status").eq("id", user.id).single();
        return { userId: user.id, authHeader, role: p?.role ?? null, status: p?.account_status ?? null };
    },
}));
