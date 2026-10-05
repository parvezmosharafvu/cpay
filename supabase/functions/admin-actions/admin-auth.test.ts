// deno test --allow-net=127.0.0.1 supabase/functions/admin-actions/
//
// The admin-actions gate against a local fake Supabase (auth/v1/user and
// rest/v1/profiles). Nothing here talks to a real project.
//
// Matrix: active admin allowed; suspended, pending and rejected admin
// refused; creator (active or suspended) refused; no header or a bad JWT
// refused. Every admin-actions route (/admin-mark-settled,
// /process-withdrawal, /admin-wallet) goes through this one gate, which
// the last step checks in index.ts.
// @ts-ignore The local TypeScript server cannot resolve URL imports without Deno's resolver.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createAdminVerifier, isActiveAdmin } from "./admin-auth.ts";

function eq<T>(a: T, b: T, msg: string) {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
        throw new Error(`assertion failed: ${msg}\n  got:      ${JSON.stringify(a)}\n  expected: ${JSON.stringify(b)}`);
    }
}

// jwt -> [user id, profile row]
const PEOPLE: Record<string, [string, { role: string; account_status: string } | null]> = {
    "active-admin-jwt": ["00000000-0000-4000-8000-0000000000a1", { role: "admin", account_status: "active" }],
    "suspended-admin-jwt": ["00000000-0000-4000-8000-0000000000a2", { role: "admin", account_status: "suspended" }],
    "pending-admin-jwt": ["00000000-0000-4000-8000-0000000000a3", { role: "admin", account_status: "pending" }],
    "rejected-admin-jwt": ["00000000-0000-4000-8000-0000000000a4", { role: "admin", account_status: "rejected" }],
    "creator-jwt": ["00000000-0000-4000-8000-0000000000c1", { role: "creator", account_status: "active" }],
    "suspended-creator-jwt": ["00000000-0000-4000-8000-0000000000c2", { role: "creator", account_status: "suspended" }],
    "no-profile-jwt": ["00000000-0000-4000-8000-0000000000d1", null],
};
const profileSelects: string[] = [];

const sb = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (req) => {
    const url = new URL(req.url);
    const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
    if (url.pathname === "/auth/v1/user") {
        const p = PEOPLE[bearer];
        if (!p) return Response.json({ code: 401, msg: "invalid JWT" }, { status: 401 });
        return Response.json({ id: p[0], aud: "authenticated", role: "authenticated" });
    }
    if (url.pathname === "/rest/v1/profiles") {
        profileSelects.push(url.searchParams.get("select") ?? "");
        const id = (url.searchParams.get("id") ?? "").replace(/^eq\./, "");
        const row = Object.values(PEOPLE).find(([uid]) => uid === id)?.[1];
        if (!row) return Response.json({ code: "PGRST116", message: "no rows" }, { status: 406 });
        return Response.json(row);
    }
    return Response.json({ message: "not mocked: " + url.pathname }, { status: 404 });
});
const sbUrl = `http://127.0.0.1:${sb.addr.port}`;
const verify = createAdminVerifier({
    supabaseUrl: sbUrl,
    anonKey: "anon-key-test",
    supabaseAdmin: createClient(sbUrl, "service-role-test"),
});
const call = (jwt: string | null) => verify(new Request("http://localhost/functions/v1/admin-actions/admin-wallet", {
    method: "POST", headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
}));

Deno.test({
    name: "admin-actions admin gate",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn(t) {
        await t.step("isActiveAdmin: admin AND active only", () => {
            eq(isActiveAdmin({ role: "admin", account_status: "active" }), true, "active admin");
            for (const s of ["suspended", "pending", "rejected", null, undefined, ""]) {
                eq(isActiveAdmin({ role: "admin", account_status: s as string }), false, `admin ${s}`);
            }
            eq(isActiveAdmin({ role: "creator", account_status: "active" }), false, "creator");
            eq(isActiveAdmin({ role: "moderator", account_status: "active" }), false, "old moderator");
            eq(isActiveAdmin({ role: "admin" }), false, "status not selected");
            eq(isActiveAdmin(null), false, "no profile");
            eq(isActiveAdmin(undefined), false, "undefined");
        });

        await t.step("active admin passes, with its user id and a caller client", async () => {
            const r = await call("active-admin-jwt");
            eq(r.ok, true, "ok");
            eq(r.userId, PEOPLE["active-admin-jwt"][0], "user id");
            eq(typeof r.callerClient?.rpc, "function", "caller client for RPCs that run as the admin");
        });

        await t.step("suspended, pending and rejected admins are refused", async () => {
            for (const jwt of ["suspended-admin-jwt", "pending-admin-jwt", "rejected-admin-jwt"]) {
                const r = await call(jwt);
                eq(r.ok, false, jwt);
                eq(r.userId, undefined, `${jwt}: no user id`);
                eq(r.callerClient, undefined, `${jwt}: no caller client`);
            }
        });

        await t.step("non-admins are refused (unchanged)", async () => {
            for (const jwt of ["creator-jwt", "suspended-creator-jwt", "no-profile-jwt"]) eq((await call(jwt)).ok, false, jwt);
        });

        await t.step("no Authorization header or a bad JWT is refused (unchanged)", async () => {
            eq((await call(null)).ok, false, "no header");
            eq((await call("forged-jwt")).ok, false, "bad jwt");
        });

        await t.step("the profile lookup reads role and account_status", () => {
            eq(profileSelects.length > 0 && profileSelects.every((s) => s === "role,account_status" || s === "role, account_status"), true,
                `selects: ${JSON.stringify([...new Set(profileSelects)])}`);
        });

        await t.step("every admin-actions route goes through the gate before any work", async () => {
            const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
            eq(/async function verifyAdminCaller|\.select\("role"\)/.test(src), false, "no second, role-only gate in index.ts");
            const routes = [...src.matchAll(/if \(url\.pathname\.endsWith\("([^"]+)"\)\) \{\n(.*)\n(.*)\n/g)];
            eq(routes.map((m) => m[1]).sort(), ["/admin-mark-settled", "/admin-wallet", "/process-withdrawal"], "routes");
            for (const m of routes) {
                eq(m[2].trim(), "const auth = await verifyAdminCaller(req);", `${m[1]}: first line is the gate`);
                eq(m[3].trim(), 'if (!auth.ok) return json({ error: "Unauthorized" }, 401, cors);', `${m[1]}: refused before any work`);
            }
        });

        await sb.shutdown();
    },
});
