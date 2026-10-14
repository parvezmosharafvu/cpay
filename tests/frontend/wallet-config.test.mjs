// node --test tests/frontend/wallet-config.test.mjs
//
// The standalone wallet refuses to start without a usable configuration
// (so a build missing its API key creates nothing), and its source keeps
// the phrase away from the network and the CPAY link.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = (f) => readFileSync(new URL(`../../wallet/src/${f}`, import.meta.url), 'utf8');

test('configProblem: mainnet needs an API key; unknown networks refused', async () => {
  const { configProblem } = await import('../../wallet/src/engine.js');
  const run = (c) => { globalThis.CPAY_WALLET_CONFIG = c; return configProblem(); };
  assert.equal(run({ network: 'mainnet', apiKey: null }), 'the wallet API key is not set');
  assert.equal(run({ network: 'mainnet', apiKey: 'k' }), null);
  assert.equal(run({ network: 'regtest' }), null);
  assert.equal(run({ network: 'testnet' }), 'network is not set');
  assert.equal(run({}), 'network is not set');
  delete globalThis.CPAY_WALLET_CONFIG;
});

test('the link module never touches the vault, phrase or engine', () => {
  const link = src('link.js');
  for (const s of ['vault', 'mnemonic', 'phrase(', 'engine', 'openPhrase', 'sealPhrase']) assert.equal(link.includes(s), false, s);
});

test('no network call or logging in the key-handling modules', () => {
  for (const f of ['bip39.js', 'vault.js']) {
    const s = src(f);
    for (const bad of ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'console.', 'import(']) assert.equal(s.includes(bad), false, `${f}: ${bad}`);
  }
  const app = src('app.js');
  assert.equal(/console\.|fetch\(|sendBeacon/.test(app), false, 'app.js: no logging or direct requests');
  assert.equal(/innerHTML/.test(app), false, 'app.js: textContent only');
});

test('the phrase reaches the engine only through connect()', () => {
  const engine = src('engine.js');
  const uses = [...engine.matchAll(/mnemonic/g)].length;
  assert.ok(uses > 0);
  assert.match(engine, /seed: \{ type: 'mnemonic', mnemonic \}/);
  assert.equal(/fetch\(|console\./.test(engine), false);
});

test('index.html has no inline script or style (strict CSP)', () => {
  const html = src('index.html') + src('security.html');
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), false, 'inline <script>');
  assert.equal(/\son[a-z]+\s*=/i.test(html), false, 'inline event handler');
  assert.equal(/<style/i.test(html) || /\sstyle=/i.test(html), false, 'inline style');
});

test('test-bitcoin deposit addresses exist only on the test network', async () => {
  const { assertRegtest } = await import('../../wallet/src/engine.js');
  const { createFakeEngine } = await import('../../wallet/src/fake-engine.js');
  globalThis.CPAY_WALLET_CONFIG = { network: 'mainnet', apiKey: 'k' };
  assert.throws(() => assertRegtest(), /only available on the test network/);
  await assert.rejects(() => createFakeEngine().bitcoinAddress(), /only available on the test network/);
  globalThis.CPAY_WALLET_CONFIG = { network: 'regtest' };
  assert.doesNotThrow(() => assertRegtest());
  assert.match(await createFakeEngine().bitcoinAddress(), /^bcrt1/);
  delete globalThis.CPAY_WALLET_CONFIG;
  const engine = src('engine.js');
  assert.match(engine, /async bitcoinAddress\(\) \{\n\s+assertRegtest\(\);/, 'the real engine checks before asking the library');
  assert.match(src('app.js'), /\$\('fundPanel'\)\.hidden = cfg\.network !== 'regtest'/, 'the UI hides it off regtest');
});

test('QR module draws locally from the pinned library only', () => {
  const qr = src('qr.js');
  assert.match(qr, /from '\.\/vendor\/qrcode\.js'/);
  for (const bad of ['fetch(', 'innerHTML', 'import(', 'http']) assert.equal(qr.includes(bad), false, bad);
});
