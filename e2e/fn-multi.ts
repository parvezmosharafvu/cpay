// Runs several Supabase Edge Functions on one port (E2E only): a request
// for /<name>/... goes to the function <name>. Each function calls
// Deno.serve once when imported; that handler is kept instead of listening.
const port = Number(Deno.env.get("FN_PORT"));
const runId = Deno.env.get("E2E_RUN_ID") ?? "";
const names = (Deno.env.get("FN_NAMES") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
type Handler = (req: Request, info: unknown) => Response | Promise<Response>;
const handlers = new Map<string, Handler>();
const orig = Deno.serve.bind(Deno);
let current = "";
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (a: any, b?: any) => {
  handlers.set(current, typeof a === "function" ? a : (b ?? a.handler));
  return { finished: Promise.resolve(), shutdown: () => Promise.resolve(), ref() {}, unref() {} };
};
for (const n of names) {
  current = n;
  await import(`../supabase/functions/${n}/index.ts`);
}
orig({ port, onListen() {} }, async (req, info) => {
  const name = new URL(req.url).pathname.split("/")[1] ?? "";
  const h = handlers.get(name);
  const r = h ? await h(req, info) : new Response(JSON.stringify({ error: `no function ${name}` }), { status: 404 });
  // Tagged like e2e/fn-wrapper.ts, so readiness knows this run's process.
  const out = new Response(r.body, r);
  out.headers.set("x-e2e-run", runId);
  return out;
});
