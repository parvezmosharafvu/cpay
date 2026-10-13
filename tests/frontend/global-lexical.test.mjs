// Static guard: no two classic scripts loaded by the same page may declare the
// same top-level const/let/class (that is a SyntaxError in the later file).
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
const dir = new URL('../../public/', import.meta.url);
for (const html of readdirSync(dir).filter((f) => f.endsWith('.html'))) {
  test(`${html}: no duplicate top-level lexical names across scripts`, () => {
    const srcs = [...readFileSync(new URL(html, dir), 'utf8').matchAll(/<script src="([^"?:]+\.js)/g)].map((m) => m[1]);
    const seen = new Map();
    for (const s of srcs) {
      let code; try { code = readFileSync(new URL(s, dir), 'utf8'); } catch { continue; }
      for (const m of code.matchAll(/^(?:const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
        assert.ok(!seen.has(m[1]), `${html}: ${m[1]} declared in ${seen.get(m[1])} and ${s}`);
        seen.set(m[1], s);
      }
    }
  });
}
