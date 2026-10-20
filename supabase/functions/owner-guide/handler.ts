// owner-guide: Admin → System guide. Returns the Bangla system guide
// (docs/SYSTEM-GUIDE-BN.md, built into guide.ts by
// scripts/build-admin-guide.mjs) to the platform owner only.
//
//   GET -> { html }   owner (CPAY_OWNER_USER_ID), active admin, passkey session
//   no / bad JWT          -> 401
//   not the owner         -> 403 owner_only   (other admins too; the page hides the button)
//   owner, weak session   -> 403 aal2_required
//   CPAY_OWNER_USER_ID unset -> 403 owner_only for everyone (fail closed)
//
// The guide holds no secret values; it is still never served as a static file.
import { sessionIsStrong } from "../_shared/step-up.ts";

export interface GuideCaller { userId: string; authHeader: string; role: string | null; status: string | null }
export interface GuideConfig {
    /** Resolves the signed-in user from the Authorization header, or null. */
    caller(req: Request): Promise<GuideCaller | null>;
    ownerUserId: string;
    html: string;
    corsHeaders(req: Request): Promise<Record<string, string>>;
}

export function createHandler(cfg: GuideConfig): (req: Request) => Promise<Response> {
    const owner = cfg.ownerUserId.trim().toLowerCase();
    return async (req) => {
        const cors = await cfg.corsHeaders(req);
        const json = (b: unknown, s: number) => new Response(JSON.stringify(b), {
            status: s, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
        });
        if (req.method === "OPTIONS") return new Response(null, { headers: cors });
        if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
        if (!req.headers.get("Authorization")) return json({ error: "Unauthorized" }, 401);
        let c: GuideCaller | null = null;
        try { c = await cfg.caller(req); } catch { c = null; }
        if (!c) return json({ error: "Unauthorized" }, 401);
        const isOwner = owner !== "" && c.userId.toLowerCase() === owner && c.role === "admin" && c.status === "active";
        if (!isOwner) return json({ error: "Owner only", code: "owner_only" }, 403);
        if (!sessionIsStrong(c.authHeader)) return json({ error: "Sign in again with your passkey, then open the guide.", code: "aal2_required" }, 403);
        return json({ html: cfg.html }, 200);
    };
}
