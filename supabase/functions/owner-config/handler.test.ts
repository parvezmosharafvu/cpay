// deno test --allow-net=127.0.0.1 supabase/functions/owner-config/
//
// The real handler against a local fake Supabase Management API and a fake
// Cloudflare API. No real token, no call to api.supabase.com or Cloudflare.
import { createHandler, PROTECTED, type Caller, type OwnerConfig } from "./handler.ts";

function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) throw new Error("assertion failed: " + msg);
}

const SB_TOKEN = "fake-sb-token", CF_TOKEN = "fake-cf-token", SECRET_VALUE = "super-secret-value-123";
const sbSecrets = new Map<string, string>([["CRON_SECRET", "x"], ["BREEZ_MNEMONIC", "words"]]);
const cfSecrets = new Map<string, string>();
let https = "off";
const seen: string[] = [];

// Started inside the test (Deno's leak check).
const startApi = () => Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    const url = new URL(req.url);
    const auth = req.headers.get("Authorization");
    const body = req.method === "GET" || req.method === "OPTIONS" ? null : await req.json().catch(() => null);
    seen.push(`${req.method} ${url.pathname} ${JSON.stringify(body)}`);
    if (url.pathname === "/sb/v1/projects/ref123/secrets") {
        if (auth !== `Bearer ${SB_TOKEN}`) return new Response("no", { status: 401 });
        if (req.method === "GET") return Response.json([...sbSecrets].map(([name, v]) => ({ name, value: "sha256:" + v.length })));
        if (req.method === "POST") { for (const s of body) sbSecrets.set(s.name, s.value); return new Response(null, { status: 201 }); }
        if (req.method === "DELETE") { for (const n of body) sbSecrets.delete(n); return Response.json({}); }
    }
    if (url.pathname.startsWith("/cf/accounts/acct1/workers/scripts/cpay/secrets")) {
        if (auth !== `Bearer ${CF_TOKEN}`) return new Response("no", { status: 403 });
        const name = decodeURIComponent(url.pathname.split("/secrets/")[1] ?? "");
        if (req.method === "GET") return Response.json({ success: true, result: [...cfSecrets.keys()].map((n) => ({ name: n, type: "secret_text" })) });
        if (req.method === "PUT") { cfSecrets.set(body.name, body.text); return Response.json({ success: true, result: { name: body.name } }); }
        if (req.method === "DELETE" && name) { cfSecrets.delete(name); return Response.json({ success: true }); }
    }
    if (url.pathname === "/cf/zones/zone1/settings/always_use_https") {
        if (req.method === "GET") return Response.json({ success: true, result: { id: "always_use_https", value: https } });
        if (req.method === "PATCH") { https = body.value; return Response.json({ success: true, result: { value: https } }); }
    }
    return Response.json({ message: "not found" }, { status: 404 });
});
let base = "";

const b64u = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const now = () => Math.floor(Date.now() / 1000);
const jwt = (aal: string, signedInAgo: number) =>
    `${b64u({ alg: "ES256" })}.${b64u({ sub: "admin", aal, amr: [{ method: "password", timestamp: now() - signedInAgo }] })}.sig`;
const FRESH_AAL2 = jwt("aal2", 30), STALE_AAL2 = jwt("aal2", 3600), FRESH_AAL1 = jwt("aal1", 30);

const records: Array<{ action: string; subject: string; detail: Record<string, unknown> }> = [];
function cfg(over: Partial<OwnerConfig> = {}): OwnerConfig {
    return {
        async verifyAdmin(req) {
            const h = req.headers.get("Authorization") ?? "";
            if (h === "Bearer creator") return { ok: false, status: 403, error: "Admins only" };
            if (!h) return { ok: false, status: 401, error: "Unauthorized" };
            return { ok: true, caller: { userId: "u1", email: "owner@example.test", authHeader: h, user: { factors: [{ status: "verified" }] } } as Caller };
        },
        async record(_c, action, subject, detail) { records.push({ action, subject, detail }); return true; },
        async corsHeaders() { return {}; },
        stepUpSeconds: 600,
        supabase: { token: SB_TOKEN, projectRef: "ref123", api: `${base}/sb` },
        cloudflare: { token: CF_TOKEN, accountId: "acct1", zoneId: "zone1", worker: "cpay", api: `${base}/cf` },
        ...over,
    };
}
async function call(h: (r: Request) => Promise<Response>, token: string | null, method = "GET", body?: unknown) {
    const res = await h(new Request("https://fn.test/owner-config", {
        method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    }));
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text || "null") };
}

Deno.test("owner-config: write-only secrets, protected names, step-up, audit", async (t) => {
    const api = startApi();
    base = `http://127.0.0.1:${api.addr.port}`;
    const h = createHandler(cfg());
    await t.step("non-admins and aal1 sessions are refused before any provider call", async () => {
        const before = seen.length;
        assert((await call(h, null)).status === 401, "no token");
        assert((await call(h, "creator")).status === 403, "creator");
        const r = await call(h, FRESH_AAL1);
        assert(r.status === 403 && r.json.code === "aal2_required", "aal1 refused");
        assert(seen.length === before, "no provider call");
    });
    await t.step("status lists names only, never values", async () => {
        const r = await call(h, STALE_AAL2);
        assert(r.status === 200, "status ok for a stale aal2 session (read only)");
        assert(JSON.stringify(r.json.supabase.secrets) === JSON.stringify(["BREEZ_MNEMONIC", "CRON_SECRET"]), "names");
        assert(!r.text.includes("sha256") && !r.text.includes("words"), "no values or digests leave");
        assert(r.json.always_https.on === false && r.json.cloudflare.ready === true, "cloudflare state");
        assert(r.json.protected.includes("BREEZ_MNEMONIC"), "protected list shown");
    });
    await t.step("a change needs a fresh sign-in", async () => {
        const r = await call(h, STALE_AAL2, "POST", { target: "supabase", action: "set", name: "MY_KEY", value: SECRET_VALUE });
        assert(r.status === 403 && r.json.code === "reauth_required", "stale refused");
        assert(!sbSecrets.has("MY_KEY"), "not written");
    });
    await t.step("set and delete a Supabase secret; the value never comes back", async () => {
        const r = await call(h, FRESH_AAL2, "POST", { target: "supabase", action: "set", name: "MY_KEY", value: SECRET_VALUE });
        assert(r.status === 200 && r.json.done && r.json.name === "MY_KEY", "set");
        assert(sbSecrets.get("MY_KEY") === SECRET_VALUE, "stored at the provider");
        assert(!r.text.includes(SECRET_VALUE), "value not echoed");
        const last = records.at(-1)!;
        assert(last.action === "settings.secret" && last.subject === "supabase:MY_KEY" && !JSON.stringify(last).includes(SECRET_VALUE), "audited without the value");
        const d = await call(h, FRESH_AAL2, "POST", { target: "supabase", action: "delete", name: "MY_KEY" });
        assert(d.status === 200 && !sbSecrets.has("MY_KEY"), "deleted");
    });
    await t.step("protected and reserved names cannot be changed", async () => {
        for (const name of ["BREEZ_MNEMONIC", "CPAY_SUPABASE_ACCESS_TOKEN", "CPAY_CLOUDFLARE_API_TOKEN"]) {
            assert(PROTECTED.has(name), `${name} protected`);
            for (const action of ["set", "delete"]) {
                const r = await call(h, FRESH_AAL2, "POST", { target: "supabase", action, name, value: "x" });
                assert(r.status === 403 && r.json.code === "protected", `${action} ${name} refused`);
            }
        }
        assert(sbSecrets.get("BREEZ_MNEMONIC") === "words", "wallet words untouched");
        const res = await call(h, FRESH_AAL2, "POST", { target: "supabase", action: "set", name: "SUPABASE_URL", value: "x" });
        assert(res.status === 400 && res.json.code === "reserved", "SUPABASE_ reserved");
        for (const name of ["lower", "1ABC", "A-B", "A B", ""]) {
            const r = await call(h, FRESH_AAL2, "POST", { target: "supabase", action: "set", name, value: "x" });
            assert(r.status === 400 && r.json.code === "bad_name", `bad name ${name}`);
        }
        for (const value of ["", " padded", "x".repeat(9000), 5]) {
            const r = await call(h, FRESH_AAL2, "POST", { target: "supabase", action: "set", name: "OK_NAME", value });
            assert(r.status === 400 && r.json.code === "bad_value", `bad value ${String(value).slice(0, 10)}`);
        }
    });
    await t.step("Cloudflare Worker secret and Always Use HTTPS", async () => {
        const r = await call(h, FRESH_AAL2, "POST", { target: "cloudflare", action: "set", name: "SITE_KEY", value: SECRET_VALUE });
        assert(r.status === 200 && cfSecrets.get("SITE_KEY") === SECRET_VALUE && !r.text.includes(SECRET_VALUE), "cf set");
        const s = await call(h, FRESH_AAL2);
        assert(JSON.stringify(s.json.cloudflare.secrets) === JSON.stringify(["SITE_KEY"]), "cf names");
        const d = await call(h, FRESH_AAL2, "POST", { target: "cloudflare", action: "delete", name: "SITE_KEY" });
        assert(d.status === 200 && !cfSecrets.has("SITE_KEY"), "cf delete");
        const on = await call(h, FRESH_AAL2, "POST", { target: "cloudflare", action: "always_https", on: true });
        assert(on.status === 200 && https === "on", "https on");
        assert(records.at(-1)!.action === "settings.cloudflare", "https audited");
    });
    await t.step("not set up: clear message, no call", async () => {
        const bare = createHandler(cfg({ supabase: { token: "", projectRef: "ref123", api: `${base}/sb` }, cloudflare: { token: "", accountId: "", zoneId: "", worker: "cpay", api: `${base}/cf` } }));
        const s = await call(bare, FRESH_AAL2);
        assert(s.json.supabase.ready === false && s.json.supabase.missing[0] === "CPAY_SUPABASE_ACCESS_TOKEN", "supabase missing named");
        assert(s.json.cloudflare.ready === false && s.json.always_https.ready === false, "cloudflare not ready");
        const r = await call(bare, FRESH_AAL2, "POST", { target: "supabase", action: "set", name: "A_B", value: "x" });
        assert(r.status === 503 && r.json.code === "not_set_up", "refused when not set up");
    });
    await t.step("a rejected token is reported without echoing it", async () => {
        const bad = createHandler(cfg({ supabase: { token: "wrong", projectRef: "ref123", api: `${base}/sb` } }));
        const r = await call(bad, FRESH_AAL2, "POST", { target: "supabase", action: "set", name: "A_B", value: "x" });
        assert(r.status === 502 && r.json.code === "token_rejected" && !r.text.includes("wrong"), "token rejected, not echoed");
    });
    await api.shutdown();
});
