// Runs one Supabase Edge Function on a chosen port (E2E only).
const port = Number(Deno.env.get("FN_PORT"));
const runId = Deno.env.get("E2E_RUN_ID") ?? "";
const orig = Deno.serve.bind(Deno);
// Tag every response with this run's id: e2e/stack.mjs only treats the
// function as ready when the answer carries it, so a stale process that
// holds the port can't pass for this run's function.
// deno-lint-ignore no-explicit-any
const tag = (h: any) => async (req: Request, info: unknown) => {
  const r: Response = await h(req, info);
  const out = new Response(r.body, r);
  out.headers.set("x-e2e-run", runId);
  return out;
};
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (a: any, b?: any) =>
  typeof a === "function" ? orig({ port, onListen() {} }, tag(a)) : orig({ ...a, port, onListen() {} }, tag(b ?? a.handler));
await import(Deno.env.get("FN_ENTRY")!);
