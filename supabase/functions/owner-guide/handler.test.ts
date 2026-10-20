import { createHandler, type GuideCaller } from "./handler.ts";
import { GUIDE_HTML } from "./guide.ts";

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const b64u = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const now = () => Math.floor(Date.now() / 1000);
const jwt = (sub: string, aal: string) => `Bearer ${b64u({ alg: "ES256" })}.${b64u({ sub, aal, amr: [{ method: "password", timestamp: now() - 30 }] })}.sig`;
const OWNER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const users: Record<string, { role: string; status: string }> = {
    [OWNER]: { role: "admin", status: "active" }, [OTHER]: { role: "admin", status: "active" },
};
const handler = (owner = OWNER) => createHandler({
    ownerUserId: owner, html: GUIDE_HTML, corsHeaders: async () => ({}),
    async caller(req): Promise<GuideCaller | null> {
        const h = req.headers.get("Authorization") ?? "";
        const sub = JSON.parse(atob(h.split(".")[1]?.replace(/-/g, "+").replace(/_/g, "/") ?? "e30=") || "{}").sub;
        const u = users[sub]; if (!u) return null;
        return { userId: sub, authHeader: h, role: u.role, status: u.status };
    },
});
const get = async (h: (r: Request) => Promise<Response>, auth?: string) => {
    const r = await h(new Request("http://x/owner-guide", { headers: auth ? { Authorization: auth } : {} }));
    return { status: r.status, json: await r.json() };
};

Deno.test("anon gets 401", async () => {
    assert((await get(handler())).status === 401, "no header");
    assert((await get(handler(), "Bearer junk")).status === 401, "bad token");
});
Deno.test("non-owner admin gets 403 owner_only, no content", async () => {
    const r = await get(handler(), jwt(OTHER, "aal2"));
    assert(r.status === 403 && r.json.code === "owner_only" && !r.json.html, "other admin refused");
});
Deno.test("owner with weak session gets 403 aal2_required", async () => {
    const r = await get(handler(), jwt(OWNER, "aal1"));
    assert(r.status === 403 && r.json.code === "aal2_required" && !r.json.html, "weak session refused");
});
Deno.test("owner with passkey session gets the guide", async () => {
    const r = await get(handler(), jwt(OWNER, "aal2"));
    assert(r.status === 200 && r.json.html === GUIDE_HTML && r.json.html.includes("সিস্টেম গাইড"), "owner gets content");
});
Deno.test("unset owner id fails closed", async () => {
    assert((await get(handler(""), jwt(OWNER, "aal2"))).status === 403, "fail closed");
});
Deno.test("POST is refused", async () => {
    const r = await handler()(new Request("http://x", { method: "POST", headers: { Authorization: jwt(OWNER, "aal2") } }));
    assert(r.status === 405, "405");
});
