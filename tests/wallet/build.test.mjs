// node --test tests/wallet/build.test.mjs   (needs `npm ci --ignore-scripts` in wallet/)
//
// The wallet build: production builds never ship the fake engine, refuse
// unsafe inputs, publish a hash for every file, and serve a strict CSP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const build = (env) => {
  const out = mkdtempSync(join(tmpdir(), 'cpay-wallet-build-'));
  const r = spawnSync(process.execPath, ['wallet/build.mjs'], {
    env: { PATH: process.env.PATH, WALLET_OUT: out, ...env }, encoding: 'utf8',
  });
  return { ...r, out };
};

test('production build: no fake engine, hashes match, strict CSP, offline precache', () => {
  const r = build({ WALLET_NETWORK: 'mainnet', WALLET_API_KEY: 'test-wallet-key' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(r.out, 'fake-engine.js')), false);
  const cfgText = readFileSync(join(r.out, 'config.js'), 'utf8');
  assert.match(cfgText, /"engine": "sdk"/);
  assert.equal(/service_role|BREEZ_MNEMONIC|PAYMENT_SERVICE_SECRET/.test(cfgText), false);
  const release = JSON.parse(readFileSync(join(r.out, 'version.json'), 'utf8'));
  assert.equal(release.test, false);
  for (const [f, h] of Object.entries(release.files)) {
    if (f === 'version.json') continue;
    assert.equal(createHash('sha256').update(readFileSync(join(r.out, f))).digest('hex'), h, f);
  }
  assert.ok(release.files['vendor/sdk/breez_sdk_spark_wasm_bg.wasm']);
  const headers = readFileSync(join(r.out, '_headers'), 'utf8');
  assert.match(headers, /script-src 'self' 'wasm-unsafe-eval';/);
  assert.match(headers, /default-src 'none'/);
  assert.equal(headers.includes('unsafe-inline'), false);
  assert.match(headers, /connect-src [^;]*https:\/\/riumaeihemgznvgattoc\.supabase\.co/);
  const sw = readFileSync(join(r.out, 'sw.js'), 'utf8');
  assert.match(sw, /const FILES = \["\.\/",/);
  assert.match(sw, /const VERSION = "0\.1\.0-mainnet";/);
  for (const f of ['index.html', 'app.js', 'vendor/sdk/breez_sdk_spark_wasm_bg.wasm', 'vendor/supabase.js']) assert.ok(sw.includes(`"${f}"`), f);
});

test('the fake engine cannot be built without WALLET_TEST=1', () => {
  const r = build({ WALLET_ENGINE: 'fake' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /test builds only/);
});

test('a service-role key is refused', () => {
  const r = build({ CPAY_SUPABASE_URL: 'https://x.supabase.co', CPAY_SUPABASE_ANON_KEY: 'eyJ.service_role.x' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /service-role/);
});

test('without an API key the mainnet build is inert (shows Not available yet)', () => {
  const r = build({ WALLET_NETWORK: 'mainnet' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /api key NOT set/);
  assert.match(readFileSync(join(r.out, 'config.js'), 'utf8'), /"apiKey": null/);
});

test('WALLET_LINK=off removes the CPAY account link and its CSP origin', () => {
  const r = build({ WALLET_NETWORK: 'regtest', WALLET_LINK: 'off' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(join(r.out, 'config.js'), 'utf8'), /"cpaySupabaseUrl": null/);
  assert.equal(readFileSync(join(r.out, '_headers'), 'utf8').includes('supabase.co'), false);
});
