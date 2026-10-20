// wallet-registry Edge Function: wiring only (logic in handler.ts).
// Secrets: CPAY_OWNER_USER_ID, BREEZ_NETWORK (mainnet|regtest, default
// mainnet). SUPABASE_* are set by Supabase.
// @ts-ignore URL import resolved by the Edge Runtime.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.3";
import { seedFingerprint } from "./fingerprint.ts";
import { createHandler } from "./handler.ts";
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
    network: (Deno.env.get("BREEZ_NETWORK") ?? "").trim() === "regtest" ? "regtest" : "mainnet",
    rpc: async (name, args) => {
        const { data, error } = await service.rpc(name, args);
        return { data, error: error ? { message: String(error.message ?? "") } : null };
    },
    fingerprint: seedFingerprint,
    log: (e) => console.log(JSON.stringify({ at: new Date().toISOString(), fn: "wallet-registry", ...e })),
    async corsHeaders(req) {
        const h = await corsFor(req, hosts);
        h["Access-Control-Allow-Methods"] = "POST, OPTIONS";
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
