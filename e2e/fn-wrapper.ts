// Runs one Supabase Edge Function on a chosen port (E2E only).
const port = Number(Deno.env.get("FN_PORT"));
const orig = Deno.serve.bind(Deno);
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (a: any, b?: any) =>
  typeof a === "function" ? orig({ port, onListen() {} }, a) : orig({ ...a, port, onListen() {} }, b);
await import(Deno.env.get("FN_ENTRY")!);
