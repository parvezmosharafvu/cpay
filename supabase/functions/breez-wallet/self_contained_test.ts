import { assertEquals } from "jsr:@std/assert@1";

// scripts/deploy-breez-wallet.sh copies only this folder before deploying,
// so no file here may import from outside it (for example ../_shared).
Deno.test("breez-wallet imports nothing from outside its own folder", async () => {
  const bad: string[] = [];
  for await (const e of Deno.readDir(new URL(".", import.meta.url))) {
    if (!e.isFile || !/\.(ts|mjs|js)$/.test(e.name) || e.name.endsWith("_test.ts")) continue;
    const src = await Deno.readTextFile(new URL(e.name, import.meta.url));
    for (const m of src.matchAll(/from\s+["'](\.\.\/[^"']+)["']/g)) bad.push(`${e.name}: ${m[1]}`);
  }
  assertEquals(bad, []);
});
