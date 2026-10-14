// node --test tests/frontend/wallet-release.test.mjs
//
// public/wallet-release.js drives the website's Download wallet page. It
// must name the same version as the wallet, and may only point at a
// separate https hostname once published (never this website, never a
// placeholder).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('release data matches the wallet and is either unpublished or a real https host', () => {
  const ctx = { window: {} };
  vm.runInNewContext(read('public/wallet-release.js'), ctx);
  const r = ctx.window.CPAY_WALLET_RELEASE;
  assert.equal(r.version, JSON.parse(read('wallet/package.json')).version);
  if (r.url === null) {
    assert.equal(r.publishedAt, null, 'publishedAt only together with url');
    return;
  }
  const u = new URL(r.url);
  assert.equal(u.protocol, 'https:');
  assert.equal(u.username + u.password, '');
  assert.doesNotMatch(u.hostname, /example|localhost|127\.0\.0\.1|pay-cashapp\.buzz$/, 'a real, separate hostname');
  assert.match(String(r.publishedAt), /^\d{4}-\d{2}-\d{2}/);
  assert.match(String(r.versionJsonSha256), /^[0-9a-f]{64}$/);
});

test('download page script parses and links nothing it should not', () => {
  const html = read('public/assets/wallet.html');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1);
  new vm.Script(scripts[0]); // syntax
  for (const legal of ['terms', 'privacy', 'refund', 'contact']) assert.equal(html.includes(`${legal}.html`), false, legal);
  assert.equal(/breez/i.test(html), false);
});
