// Admin two-step sign-in enforcement (20261014030000), shared by every admin
// gate in Edge Functions (admin-actions, auth-settings). Same rule as the
// database's is_admin(): when app_settings.admin_mfa_required is on, an
// admin session must be aal2.
import { decodeJwtPayload } from "./step-up.ts";

// A JSON boolean true, or the string "true", turns enforcement on (fail
// closed for a security flag).
export function mfaFlagOn(value: unknown): boolean {
    return value === true || value === "true";
}

// Any supabase-js client (service role). Typed loosely on purpose: matching
// the client's deep generics here makes the type checker give up (TS2589).
// deno-lint-ignore no-explicit-any
type SettingsReader = { from(table: string): any };

// A failed read counts as on: admin work is refused rather than run unchecked.
export async function adminMfaEnforced(supabaseAdmin: SettingsReader): Promise<boolean> {
    const { data, error } = await supabaseAdmin
        .from("app_settings").select("value").eq("key", "admin_mfa_required").maybeSingle();
    if (error) return true;
    return mfaFlagOn(data?.value);
}

// Only after auth.getUser() accepted the same token (claims unverified here).
export function sessionIsAal2(authHeader: string | null): boolean {
    return decodeJwtPayload(String(authHeader ?? "").replace(/^Bearer\s+/i, ""))?.aal === "aal2";
}

// The health check's verdict on admin two-step sign-in. Unsafe: required
// while an active admin has no authenticator (locked out), or expected by
// the owner (ADMIN_MFA_EXPECTED=true after rollout) while not required.
export function adminMfaHealth(status: { enforced?: unknown; admins_without_factor?: unknown } | null, expected: boolean): { ok: boolean; detail: string } {
    const enforced = status?.enforced === true;
    const without = Number(status?.admins_without_factor ?? 0);
    if (enforced) {
        return without === 0
            ? { ok: true, detail: "admin two-step sign-in required; every active admin has an authenticator" }
            : { ok: false, detail: `admin two-step sign-in required but ${without} active admin(s) have no authenticator and cannot sign in` };
    }
    return expected
        ? { ok: false, detail: "ADMIN_MFA_EXPECTED is true but admin two-step sign-in is not required (Admin → Settings)" }
        : { ok: true, detail: "admin two-step sign-in not required yet (owner rollout pending)" };
}
