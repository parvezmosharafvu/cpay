// Edge Functions called from the browser must allow, in their CORS
// preflight answer, every header the page sends. supabase-js
// functions.invoke() adds X-Client-Info to Authorization, apikey and
// Content-Type; user-withdraw did not list it, so the browser blocked every
// Freelancer withdraw call after the preflight and the desk showed "Networks
// did not load" (production, 2026-10-15). The E2E stack now serves pages and
// the API from different origins, so the browser enforces this too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const allowed = (path) => {
  const m = readFileSync(path, 'utf8').match(/"Access-Control-Allow-Headers":\s*"([^"]+)"/);
  assert.ok(m, `${path}: no Access-Control-Allow-Headers`);
  return m[1].split(',').map((h) => h.trim().toLowerCase());
};

// The SDK's own list (@supabase/supabase-js/cors) when installed; the four
// headers it always sends otherwise.
async function sdkHeaders() {
  const f = 'node_modules/@supabase/supabase-js/dist/cors.mjs';
  if (!existsSync(f)) return ['authorization', 'apikey', 'content-type', 'x-client-info'];
  const m = readFileSync(f, 'utf8').match(/const SUPABASE_HEADERS = \[([^\]]+)\]/);
  assert.ok(m, 'SUPABASE_HEADERS not found in supabase-js/cors');
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1].toLowerCase());
}

test('functions the desks call allow every header supabase-js sends', async () => {
  const sent = await sdkHeaders();
  assert.ok(sent.includes('x-client-info'));
  for (const fn of ['supabase/functions/user-withdraw/index.ts', 'supabase/functions/admin-actions/index.ts', 'supabase/functions/auth-settings/handler.ts']) {
    const got = allowed(fn);
    for (const h of sent) assert.ok(got.includes(h), `${fn} must allow ${h}`);
  }
});

test('supabase-js really sends X-Client-Info with functions.invoke', () => {
  const dist = 'node_modules/@supabase/supabase-js/dist/index.mjs';
  if (!existsSync(dist)) return; // dev dependency not installed: nothing to compare against
  const s = readFileSync(dist, 'utf8');
  assert.match(s, /DEFAULT_HEADERS = \{ "X-Client-Info"/);
  assert.match(s, /get functions\(\) \{\s*return new FunctionsClient\(this\.functionsUrl\.href, \{\s*headers: this\.headers/);
});

test('the Freelancer desk calls user-withdraw through functions.invoke', () => {
  const app = readFileSync('public/app.js', 'utf8');
  assert.match(app, /supabaseClient\.functions\.invoke\(name/);
  assert.match(app, /callFunction\('user-withdraw', \{ action: 'routes' \}\)/);
});
