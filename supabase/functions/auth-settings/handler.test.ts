// deno test --allow-net --allow-env supabase/functions/auth-settings/
//
// Runs the real handler against two local mock servers:
//   * a fake Supabase (auth/v1/user, rest/v1/profiles, site_domains, audit_log)
//   * a fake Management API (GET/PATCH /v1/projects/{ref}/config/auth)
// Nothing here talks to api.supabase.com or uses a real token.
import { createHandler, projectRefFromUrl, type AuthSettingsConfig } from "./handler.ts";

const ADMIN = { id: "00000000-0000-4000-8000-00000000000a", email: "admin@example.test" };
const CREATOR = { id: "00000000-0000-4000-8000-00000000000c", email: "creator@example.test" };
const FAKE_PAT = "fake-pat-for-tests-only";
const REF = "abcdefghijklmnopqrst";
const ALLOWED = "https://admin.example.test";

function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) throw new Error("assertion failed: " + msg);
}
function eq<T>(a: T, b: T, msg: string) {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
        throw new Error(`assertion failed: ${msg}\n  got:      ${JSON.stringify(a)}\n  expected: ${JSON.stringify(b)}`);
    }
}

// ---------- fake Supabase ----------
const auditRows: Record<string, unknown>[] = [];
let auditFails = false;
const sb = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    const url = new URL(req.url);
    const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
    if (url.pathname === "/auth/v1/user") {
        const user = bearer === "admin-jwt" ? ADMIN : bearer === "creator-jwt" ? CREATOR : null;
        if (!user) return Response.json({ code: 401, msg: "invalid JWT" }, { status: 401 });
        return Response.json({ ...user, aud: "authenticated", role: "authenticated" });
    }
    if (url.pathname === "/rest/v1/profiles") {
        const id = (url.searchParams.get("id") ?? "").replace(/^eq\./, "");
        const row = id === ADMIN.id ? { role: "admin", email: ADMIN.email }
            : id === CREATOR.id ? { role: "creator", email: CREATOR.email } : null;
        if (!row) return Response.json({ code: "PGRST116", message: "no rows" }, { status: 406 });
        return Response.json(row);
    }
    if (url.pathname === "/rest/v1/site_domains") {
        return Response.json([{ hostname: new URL(ALLOWED).host }]);
    }
    if (url.pathname === "/rest/v1/audit_log" && req.method === "POST") {
        if (auditFails) return Response.json({ message: "audit down" }, { status: 500 });
        const body = await req.json();
        auditRows.push(...(Array.isArray(body) ? body : [body]));
        return new Response(null, { status: 201 });
    }
    return Response.json({ message: "not mocked: " + url.pathname }, { status: 404 });
});

// ---------- fake Management API ----------
type MgmtCall = { method: string; path: string; auth: string | null; body: unknown };
const mgmtCalls: MgmtCall[] = [];
let mgmtState: Record<string, unknown> = {};
let mgmtForceStatus = 0;
function resetMgmt(autoconfirm: boolean) {
    mgmtCalls.length = 0;
    mgmtForceStatus = 0;
    // A real auth config carries secrets. None of them may reach the browser.
    mgmtState = {
        mailer_autoconfirm: autoconfirm,
        site_url: "https://cpay.example.test",
        smtp_pass: "SMTP-SECRET-SHOULD-NEVER-LEAK",
        external_google_secret: "GOOGLE-SECRET-SHOULD-NEVER-LEAK",
    };
}
const mgmt = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    const url = new URL(req.url);
    const body = req.method === "PATCH" ? await req.json() : null;
    mgmtCalls.push({ method: req.method, path: url.pathname, auth: req.headers.get("Authorization"), body });
    if (mgmtForceStatus) return Response.json({ message: "forced failure" }, { status: mgmtForceStatus });
    if (req.headers.get("Authorization") !== `Bearer ${FAKE_PAT}`) {
        return Response.json({ message: "Unauthorized" }, { status: 401 });
    }
    if (url.pathname !== `/v1/projects/${REF}/config/auth`) return Response.json({ message: "no project" }, { status: 404 });
    if (req.method === "GET") return Response.json(mgmtState);
    if (req.method === "PATCH") {
        mgmtState = { ...mgmtState, ...(body as Record<string, unknown>) };
        return Response.json(mgmtState);
    }
    return Response.json({ message: "method" }, { status: 405 });
});

const sbUrl = `http://127.0.0.1:${sb.addr.port}`;
const mgmtUrl = `http://127.0.0.1:${mgmt.addr.port}`;
const baseCfg: AuthSettingsConfig = {
    supabaseUrl: sbUrl,
    anonKey: "anon-key-test",
    serviceRoleKey: "service-role-test",
    accessToken: FAKE_PAT,
    projectRef: REF,
    managementApiUrl: mgmtUrl,
    tokenSecretName: "CPAY_SUPABASE_ACCESS_TOKEN",
};
const handler = createHandler(baseCfg);

const seenBodies: string[] = [];
async function call(h: (r: Request) => Promise<Response>, method: string, jwt: string | null, body?: unknown, origin?: string) {
    const headers: Record<string, string> = {};
    if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (origin) headers["Origin"] = origin;
    const res = await h(new Request("http://localhost/functions/v1/auth-settings", {
        method, headers, body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
    }));
    const text = await res.text();
    seenBodies.push(text);
    return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}

Deno.test({
    name: "auth-settings edge function",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn(t) {
        await t.step("projectRefFromUrl derives the ref from SUPABASE_URL", () => {
            eq(projectRefFromUrl("https://riumaeihemgznvgattoc.supabase.co"), "riumaeihemgznvgattoc", "hosted url");
            eq(projectRefFromUrl("https://riumaeihemgznvgattoc.supabase.co/"), "riumaeihemgznvgattoc", "trailing slash");
            eq(projectRefFromUrl("http://127.0.0.1:54321"), "", "local url");
            eq(projectRefFromUrl("https://api.cpay.example"), "", "custom domain");
            eq(projectRefFromUrl("not a url"), "", "garbage");
        });

        await t.step("GET as admin reads mailer_autoconfirm=false as confirmation ON", async () => {
            resetMgmt(false);
            const r = await call(handler, "GET", "admin-jwt");
            eq(r.status, 200, "status");
            eq(r.json, { email_confirmation_required: true }, "body is only the boolean");
            eq(mgmtCalls.length, 1, "one management call");
            eq(mgmtCalls[0].method, "GET", "method");
            eq(mgmtCalls[0].path, `/v1/projects/${REF}/config/auth`, "path");
            eq(mgmtCalls[0].auth, `Bearer ${FAKE_PAT}`, "token sent as bearer to the management API");
        });

        await t.step("GET as admin reads mailer_autoconfirm=true as confirmation OFF", async () => {
            resetMgmt(true);
            const r = await call(handler, "GET", "admin-jwt");
            eq(r.status, 200, "status");
            eq(r.json.email_confirmation_required, false, "off");
        });

        await t.step("POST false turns confirmation off (PATCH mailer_autoconfirm=true) and audits", async () => {
            resetMgmt(false);
            auditRows.length = 0;
            const r = await call(handler, "POST", "admin-jwt", { email_confirmation_required: false });
            eq(r.status, 200, "status");
            eq(r.json, { email_confirmation_required: false, changed: true, audited: true }, "body");
            eq(mgmtCalls.map((c) => c.method), ["GET", "PATCH"], "reads old value, then patches");
            eq(mgmtCalls[1].body, { mailer_autoconfirm: true }, "patch body is exactly the one field");
            eq(mgmtState.mailer_autoconfirm, true, "mock state changed");
            eq(auditRows.length, 1, "one audit row");
            const a = auditRows[0];
            eq(a.actor_id, ADMIN.id, "actor id");
            eq(a.actor_email, ADMIN.email, "actor email");
            eq(a.action, "settings.signup_email_confirmation", "action");
            eq(a.subject_type, "settings", "subject type (matches the ops panel's Settings filter)");
            eq(a.old_value, { email_confirmation_required: true, mailer_autoconfirm: false }, "old value");
            eq(a.new_value, { email_confirmation_required: false, mailer_autoconfirm: true }, "new value");
        });

        await t.step("POST true turns confirmation back on (PATCH mailer_autoconfirm=false)", async () => {
            auditRows.length = 0;
            mgmtCalls.length = 0;
            const r = await call(handler, "POST", "admin-jwt", { email_confirmation_required: true });
            eq(r.status, 200, "status");
            eq(r.json.email_confirmation_required, true, "on");
            eq(mgmtCalls[1].body, { mailer_autoconfirm: false }, "patch body");
            eq(mgmtState.mailer_autoconfirm, false, "mock state");
            eq(auditRows.length, 1, "audited");
        });

        await t.step("POST with the current value is a no-op: no PATCH, no audit row", async () => {
            resetMgmt(false);
            auditRows.length = 0;
            const r = await call(handler, "POST", "admin-jwt", { email_confirmation_required: true });
            eq(r.status, 200, "status");
            eq(r.json, { email_confirmation_required: true, changed: false }, "body");
            eq(mgmtCalls.map((c) => c.method), ["GET"], "no patch");
            eq(auditRows.length, 0, "no audit");
        });

        await t.step("non-admin (creator) is refused for GET and POST before any management call", async () => {
            resetMgmt(false);
            auditRows.length = 0;
            const g = await call(handler, "GET", "creator-jwt");
            eq(g.status, 403, "GET status");
            eq(g.json, { error: "Admins only" }, "GET body");
            const p = await call(handler, "POST", "creator-jwt", { email_confirmation_required: false });
            eq(p.status, 403, "POST status");
            eq(mgmtCalls.length, 0, "management API never called");
            eq(mgmtState.mailer_autoconfirm, false, "setting unchanged");
            eq(auditRows.length, 0, "nothing audited");
        });

        await t.step("no Authorization header or a bad JWT is 401", async () => {
            resetMgmt(false);
            eq((await call(handler, "GET", null)).status, 401, "no header");
            eq((await call(handler, "POST", "forged-jwt", { email_confirmation_required: false })).status, 401, "bad jwt");
            eq(mgmtCalls.length, 0, "management API never called");
        });

        await t.step("missing token: clear 503 naming the secret, no management call", async () => {
            resetMgmt(false);
            const h = createHandler({ ...baseCfg, accessToken: "" });
            const r = await call(h, "GET", "admin-jwt");
            eq(r.status, 503, "status");
            eq(r.json.code, "missing_token", "code");
            assert(String(r.json.error).includes("CPAY_SUPABASE_ACCESS_TOKEN"), "message names the secret");
            eq(mgmtCalls.length, 0, "no management call");
            // Still admin-only: a creator learns nothing about the setup.
            eq((await call(h, "GET", "creator-jwt")).status, 403, "creator still 403");
        });

        await t.step("missing project ref: clear 503", async () => {
            const h = createHandler({ ...baseCfg, projectRef: "" });
            const r = await call(h, "GET", "admin-jwt");
            eq(r.status, 503, "status");
            eq(r.json.code, "missing_project_ref", "code");
        });

        await t.step("management API rejects the token: 502 token_rejected", async () => {
            resetMgmt(false);
            const h = createHandler({ ...baseCfg, accessToken: "fake-wrong-pat-for-tests" });
            const r = await call(h, "POST", "admin-jwt", { email_confirmation_required: false });
            eq(r.status, 502, "status");
            eq(r.json.code, "token_rejected", "code");
            eq(mgmtState.mailer_autoconfirm, false, "unchanged");
        });

        await t.step("management API 429 and 500 are reported, nothing changes", async () => {
            resetMgmt(false);
            mgmtForceStatus = 429;
            const a = await call(handler, "GET", "admin-jwt");
            eq(a.status, 429, "rate limit status");
            eq(a.json.code, "rate_limited", "rate limit code");
            mgmtForceStatus = 500;
            const b = await call(handler, "POST", "admin-jwt", { email_confirmation_required: false });
            eq(b.status, 502, "server error status");
            eq(b.json.code, "management_error", "server error code");
            assert(String(b.json.error).includes("500"), "mentions the upstream status");
            mgmtForceStatus = 0;
            eq(mgmtState.mailer_autoconfirm, false, "unchanged");
        });

        await t.step("management API unreachable: 502 management_unreachable", async () => {
            const h = createHandler({ ...baseCfg, managementApiUrl: "http://127.0.0.1:9" });
            const r = await call(h, "GET", "admin-jwt");
            eq(r.status, 502, "status");
            eq(r.json.code, "management_unreachable", "code");
        });

        await t.step("bad POST bodies are 400 and never reach the management API", async () => {
            resetMgmt(false);
            eq((await call(handler, "POST", "admin-jwt", { email_confirmation_required: "no" })).status, 400, "string");
            eq((await call(handler, "POST", "admin-jwt", {})).status, 400, "missing");
            eq((await call(handler, "POST", "admin-jwt", "{not json")).status, 400, "invalid json");
            eq(mgmtCalls.length, 0, "no management call");
        });

        await t.step("audit write failure does not undo the change and is reported", async () => {
            resetMgmt(false);
            auditFails = true;
            const r = await call(handler, "POST", "admin-jwt", { email_confirmation_required: false });
            auditFails = false;
            eq(r.status, 200, "status");
            eq(r.json.audited, false, "audited:false");
            eq(mgmtState.mailer_autoconfirm, true, "change kept");
        });

        await t.step("CORS follows site_domains; other methods are 405", async () => {
            const ok = await call(handler, "OPTIONS", null, undefined, ALLOWED);
            eq(ok.status, 200, "preflight status");
            eq(ok.headers.get("Access-Control-Allow-Origin"), ALLOWED, "allowed origin echoed");
            assert((ok.headers.get("Access-Control-Allow-Methods") ?? "").includes("GET"), "GET allowed");
            const bad = await call(handler, "OPTIONS", null, undefined, "https://evil.example");
            eq(bad.headers.get("Access-Control-Allow-Origin"), null, "other origin not allowed");
            eq((await call(handler, "PUT", "admin-jwt", {})).status, 405, "PUT");
        });

        await t.step("no response ever contains the token or other auth-config secrets", () => {
            const all = seenBodies.join("\n");
            for (const s of [FAKE_PAT, "fake-wrong-pat-for-tests", "SMTP-SECRET", "GOOGLE-SECRET", "site_url"]) {
                assert(!all.includes(s), `response bodies leak ${s}`);
            }
        });

        await sb.shutdown();
        await mgmt.shutdown();
    },
});
