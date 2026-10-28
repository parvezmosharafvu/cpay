import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { probeProvider, providerFailure } from "./provider.ts";

function fake(answers: (number | Error)[]) {
  const calls: string[] = [];
  const f = ((url: string) => {
    calls.push(url);
    const a = answers.shift()!;
    if (a instanceof Error) return Promise.reject(a);
    return Promise.resolve(new Response(JSON.stringify(a === 200 ? { ok: true, enabled: true, holder: null } : { ok: false, enabled: false, holder: null }), { status: a }));
  }) as unknown as typeof fetch;
  return { f, calls };
}
const noWait = { sleep: () => Promise.resolve() };

Deno.test("healthy on the first answer: asked once", async () => {
  const { f, calls } = fake([200]);
  const p = await probeProvider(f, "https://svc", noWait);
  assertEquals([p.ok, p.attempts, calls], [true, 1, ["https://svc/health"]]);
});

Deno.test("one 503 then healthy: not down", async () => {
  const { f, calls } = fake([503, 200]);
  const p = await probeProvider(f, "https://svc", noWait);
  assertEquals([p.ok, p.attempts, calls.length], [true, 2, 2]);
});

Deno.test("down twice: down, with the fields it sent and never undefined", async () => {
  const { f } = fake([503, 503]);
  const p = await probeProvider(f, "https://svc", noWait);
  assertEquals(p.ok, false);
  assertEquals(providerFailure(p), "payment service answered 503: ok=false enabled=false holder=null (asked 2×)");
});

Deno.test("unreachable twice: says so", async () => {
  const { f } = fake([new Error("timeout"), new Error("timeout")]);
  const p = await probeProvider(f, "https://svc", noWait);
  assertEquals(p.ok, false);
  assertEquals(providerFailure(p), 'payment service unreachable: error="Error: timeout" (asked 2×)');
});

Deno.test("200 without ok:true is not healthy", async () => {
  const f = (() => Promise.resolve(new Response("{}", { status: 200 }))) as unknown as typeof fetch;
  const p = await probeProvider(f, "https://svc", noWait);
  assertEquals([p.ok, p.attempts], [false, 2]);
  assertEquals(providerFailure(p), "payment service answered 200 (asked 2×)");
});
