import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { render } from '../../scripts/build-admin-guide.mjs';

const md = readFileSync('docs/SYSTEM-GUIDE-BN.md', 'utf8');
const admin = readFileSync('public/admin.html', 'utf8');
const js = readFileSync('public/admin-guide.js', 'utf8');

test('embedded guide in owner-guide is built from the markdown', () => {
  assert.equal(readFileSync('supabase/functions/owner-guide/guide.ts', 'utf8'), render(md));
});
test('no static copy of the guide in public/', () => {
  assert.ok(!existsSync('public/admin-guide-bn.html'));
  for (const f of readdirSync('public')) {
    if (!/\.(html|js)$/.test(f) || f === 'admin.html') continue;
    assert.doesNotMatch(readFileSync('public/' + f, 'utf8'), /সূচিপত্র/, f);
  }
  assert.doesNotMatch(readFileSync('public/_headers', 'utf8'), /admin-guide/);
});
test('button is hidden by default and only shown after the owner check', () => {
  assert.match(admin, /data-tab="guide" hidden>/);
  assert.match(admin, /<section id="guide" hidden>/);
  assert.match(admin, /name="robots" content="noindex/);
  assert.match(js, /invoke\('owner-guide'/);
  assert.match(js, /btn\.hidden = !owner/);
  assert.doesNotMatch(js, /fetch\(/);
});
test('owner-guide requires a JWT', () => {
  assert.match(readFileSync('supabase/config.toml', 'utf8'), /\[functions\.owner-guide\]\nverify_jwt = true/);
});
