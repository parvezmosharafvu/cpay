import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { render } from '../../scripts/build-admin-guide.mjs';

const md = readFileSync('docs/SYSTEM-GUIDE-BN.md', 'utf8');
const html = readFileSync('public/admin-guide-bn.html', 'utf8');
const admin = readFileSync('public/admin.html', 'utf8');

test('admin guide HTML is built from the markdown', () => { assert.equal(html, render(md)); });
test('guide is in the admin nav and gated', () => {
  assert.match(admin, /data-tab="guide"/);
  assert.match(admin, /<section id="guide" hidden>/);
  assert.match(admin, /admin-guide\.js/);
  assert.match(admin, /name="robots" content="noindex/);
  const js = readFileSync('public/admin-guide.js', 'utf8');
  assert.match(js, /rpc\('is_admin'\)/);
  assert.match(readFileSync('public/_headers', 'utf8'), /\/admin-guide-bn\.html\n\s+X-Robots-Tag: noindex/);
});
test('guide has no secret-looking values and no script', () => {
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(md, /(sk_live|eyJhbGci|ghp_|github_pat_|re_[A-Za-z0-9]{20})/);
});
