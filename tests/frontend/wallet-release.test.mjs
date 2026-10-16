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

// docs/WALLET-RELEASE-GATES.md: the link stays off until every gate passes.
function gates() {
  const doc = read('docs/WALLET-RELEASE-GATES.md');
  const rows = [...doc.matchAll(/^\| (G\d+) \| (.+?) \| (.+?) \| (OPEN|PASS) \|(.*?)\|$/gm)]
    .map((m) => ({ id: m[1], status: m[4], evidence: m[5].trim() }));
  const record = (label) => ((doc.match(new RegExp(`^- ${label}: (.+)$`, 'm')) || [])[1] || '').trim().replace(/^`|`$/g, '');
  return { rows, host: record('Production hostname'), sha: record('version.json sha256') };
}

test('the release gates are all listed, and a PASS always carries a dated note', () => {
  const { rows } = gates();
  assert.deepEqual(rows.map((r) => r.id), ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8']);
  for (const r of rows.filter((x) => x.status === 'PASS')) {
    assert.match(r.evidence, /\b\d{4}-\d{2}-\d{2}\b/, `${r.id} PASS needs a date and what was seen`);
  }
  for (const r of rows) assert.doesNotMatch(r.evidence, /eyJ[\w-]{10,}|service_role|sk_live|-----BEGIN/i, `${r.id}: no keys in the evidence`);
});

test('the download link stays off until every release gate passes and the record matches', () => {
  const ctx = { window: {} };
  vm.runInNewContext(read('public/wallet-release.js'), ctx);
  const r = ctx.window.CPAY_WALLET_RELEASE;
  const g = gates();
  const open = g.rows.filter((x) => x.status !== 'PASS').map((x) => x.id);
  if (r.url === null) return;
  assert.deepEqual(open, [], `wallet-release.js has a url while gates are open: ${open.join(', ')}`);
  assert.equal(g.host, new URL(r.url).hostname, 'release record names the published hostname');
  assert.equal(g.sha, r.versionJsonSha256, 'release record names the published version.json sha256');
});

test('download page script parses and links nothing it should not', () => {
  const html = read('public/assets/wallet.html');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1);
  new vm.Script(scripts[0]); // syntax
  for (const legal of ['terms', 'privacy', 'refund', 'contact']) assert.equal(html.includes(`${legal}.html`), false, legal);
  assert.equal(/breez/i.test(html), false);
});
