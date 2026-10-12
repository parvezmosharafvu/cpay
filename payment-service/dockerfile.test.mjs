// The image copies an explicit file list. Every local module that server.mjs
// reaches must be in it, or the container dies at boot (ERR_MODULE_NOT_FOUND).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const here = new URL('./', import.meta.url);
const copied = new Set(
  readFileSync(new URL('Dockerfile', here), 'utf8')
    .split('\n')
    .filter((l) => /^COPY\s+package\.json\s+\S+\.mjs/.test(l))
    .flatMap((l) => l.trim().split(/\s+/).slice(1, -1)),
);

test('Dockerfile copies every module server.mjs imports', () => {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(new URL(file, here), 'utf8');
    for (const m of src.matchAll(/from\s+'\.\/([A-Za-z0-9_-]+\.mjs)'/g)) walk(m[1]);
  };
  walk('server.mjs');
  const missing = [...seen].filter((f) => !copied.has(f));
  assert.deepEqual(missing, []);
});
