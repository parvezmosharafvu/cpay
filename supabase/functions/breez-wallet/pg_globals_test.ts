import { assertEquals } from "jsr:@std/assert@1";
import { endPostgresPools, trackPools } from "./pg-globals.ts";

Deno.test("endPostgresPools ends each tracked SDK pool once", async () => {
  const ended: number[] = [];
  const make = trackPools((n: number) => ({ end: async () => { ended.push(n); } }));
  make(1); make(2);
  assertEquals(await endPostgresPools(), 2);
  assertEquals(ended.sort(), [1, 2]);
  assertEquals(await endPostgresPools(), 0); // already cleared
});

Deno.test("endPostgresPools never waits past its cap for a stuck pool", async () => {
  const make = trackPools((_: number) => ({ end: () => new Promise<void>(() => {}) }));
  make(1);
  const t0 = Date.now();
  assertEquals(await endPostgresPools(50), 1);
  assertEquals(Date.now() - t0 < 1_000, true);
});

Deno.test("endPostgresPools tolerates a pool whose end() throws", async () => {
  const make = trackPools((_: number) => ({ end: () => { throw new Error("Called end on pool more than once"); } }));
  make(1);
  assertEquals(await endPostgresPools(), 1);
});
