// The admin gate for every admin-actions route.
//
// An admin operation needs role = 'admin' AND account_status = 'active',
// the same rule as the database's is_admin(). A suspended, pending or
// rejected admin is refused here, before any work, including the routes
// that act with the service role (/process-withdrawal) or forward to the
// payment service (/admin-wallet), where no is_admin() check would run.
// @ts-ignore The local TypeScript server cannot resolve URL imports without Deno's resolver.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type AdminProfile = { role?: string | null; account_status?: string | null } | null | undefined;

export function isActiveAdmin(profile: AdminProfile): boolean {
    return profile?.role === "admin" && profile?.account_status === "active";
}

export type AdminCheck = { ok: boolean; userId?: string; callerClient?: SupabaseClient };

export function createAdminVerifier(opts: { supabaseUrl: string; anonKey: string; supabaseAdmin: SupabaseClient }) {
    return async function verifyAdminCaller(req: Request): Promise<AdminCheck> {
        const authHeader = req.headers.get("Authorization");
        if (!authHeader) return { ok: false };
        const callerClient = createClient(opts.supabaseUrl, opts.anonKey, {
            global: { headers: { Authorization: authHeader } },
        });
        const { data: { user }, error } = await callerClient.auth.getUser();
        if (error || !user) return { ok: false };
        const { data: profile } = await opts.supabaseAdmin
            .from("profiles").select("role, account_status").eq("id", user.id).single();
        if (!isActiveAdmin(profile)) return { ok: false };
        return { ok: true, userId: user.id, callerClient };
    };
}
