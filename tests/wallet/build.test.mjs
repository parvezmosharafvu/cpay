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
  assert.equal(release.files['vendor/qrcode.js'], createHash('sha256').update(readFileSync('wallet/node_modules/qrcode-generator/dist/qrcode.mjs')).digest('hex'), 'QR library copied byte for byte');
  assert.ok(release.files['qr.js']);
  assert.equal(Object.keys(release.files).some((f) => /jsqr/i.test(f)), false, 'test-only decoder not shipped');
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

test('vendor real-time sync is off by default and only on when asked', () => {
  const off = build({ WALLET_NETWORK: 'regtest', WALLET_LINK: 'off' });
  assert.equal(off.status, 0, off.stderr);
  assert.match(readFileSync(join(off.out, 'config.js'), 'utf8'), /"sync": false/);
  assert.equal(readFileSync(join(off.out, '_headers'), 'utf8').includes('datasync.breez.technology'), false, 'CSP blocks the sync host');
  const on = build({ WALLET_NETWORK: 'regtest', WALLET_LINK: 'off', WALLET_SYNC: 'on' });
  assert.equal(on.status, 0, on.stderr);
  assert.match(readFileSync(join(on.out, 'config.js'), 'utf8'), /"sync": true/);
  assert.match(readFileSync(join(on.out, '_headers'), 'utf8'), /datasync\.breez\.technology:442/);
});

test('passkeys: production pinned to wallet.pay-cashapp.buzz, switch off by default', () => {
  const cfgOf = (r) => readFileSync(join(r.out, 'config.js'), 'utf8');
  // Production with nothing set: the pinned RP ID, passkeys off.
  const prod = build({ WALLET_NETWORK: 'mainnet', WALLET_API_KEY: 'test-wallet-key' });
  assert.equal(prod.status, 0, prod.stderr);
  assert.match(cfgOf(prod), /"rpId": "wallet\.pay-cashapp\.buzz"/);
  assert.match(cfgOf(prod), /"passkeys": false/);
  assert.match(prod.stdout, /passkeys off, rp id wallet\.pay-cashapp\.buzz/);
  // The same value given explicitly (any case) is accepted; the switch turns them on.
  const on = build({ WALLET_NETWORK: 'mainnet', WALLET_API_KEY: 'test-wallet-key', WALLET_RP_ID: 'Wallet.Pay-Cashapp.Buzz', WALLET_PASSKEYS: 'on' });
  assert.equal(on.status, 0, on.stderr);
  assert.match(cfgOf(on), /"rpId": "wallet\.pay-cashapp\.buzz"/);
  assert.match(cfgOf(on), /"passkeys": true/);
  const release = JSON.parse(readFileSync(join(on.out, 'version.json'), 'utf8'));
  assert.ok(release.files['passkey.js']);
  assert.ok(release.files['vendor/sdk/passkey-prf-provider/index.js'], 'the browser passkey provider ships');
  const headers = readFileSync(join(on.out, '_headers'), 'utf8');
  assert.match(headers, /publickey-credentials-get=\(self\), publickey-credentials-create=\(self\)/);
  // Any other RP ID on production is refused: it would strand every passkey wallet.
  for (const other of ['pay-cashapp.buzz', 'mycpaywallet.com', 'x.wallet.pay-cashapp.buzz', 'localhost']) {
    const r = build({ WALLET_NETWORK: 'mainnet', WALLET_API_KEY: 'test-wallet-key', WALLET_RP_ID: other });
    assert.notEqual(r.status, 0, other);
    assert.match(r.stderr, /must be wallet\.pay-cashapp\.buzz/, other);
  }
  for (const bad of ['https://wallet.example.com', '127.0.0.1', 'wallet', 'a b.com']) {
    const r = build({ WALLET_NETWORK: 'mainnet', WALLET_API_KEY: 'test-wallet-key', WALLET_RP_ID: bad });
    assert.notEqual(r.status, 0, bad);
    assert.match(r.stderr + r.stdout, /WALLET_RP_ID must be a host name/, bad);
  }
  assert.match(build({ WALLET_NETWORK: 'mainnet', WALLET_API_KEY: 'test-wallet-key', WALLET_PASSKEYS: 'yes' }).stderr, /WALLET_PASSKEYS must be on or off/);
  // Non-production builds: no RP ID unless given; the switch needs one.
  const reg = build({ WALLET_NETWORK: 'regtest', WALLET_LINK: 'off' });
  assert.match(cfgOf(reg), /"rpId": null/);
  assert.match(build({ WALLET_NETWORK: 'regtest', WALLET_LINK: 'off', WALLET_PASSKEYS: 'on' }).stderr, /WALLET_PASSKEYS=on needs WALLET_RP_ID/);
});

test('lightning address: off unless a domain is named; the domain is the only new connection', () => {
  const off = build({ WALLET_NETWORK: 'mainnet', WALLET_API_KEY: 'test-wallet-key' });
  assert.equal(off.status, 0, off.stderr);
  assert.match(readFileSync(join(off.out, 'config.js'), 'utf8'), /"lnAddressDomain": null/);
  assert.doesNotMatch(readFileSync(join(off.out, '_headers'), 'utf8'), /breez\.tips|pay-cashapp\.buzz/);
  const on = build({ WALLET_NETWORK: 'mainnet', WALLET_API_KEY: 'test-wallet-key', LIGHTNING_ADDRESS_DOMAIN: 'Pay-Cashapp.Buzz' });
  assert.equal(on.status, 0, on.stderr);
  assert.match(readFileSync(join(on.out, 'config.js'), 'utf8'), /"lnAddressDomain": "pay-cashapp\.buzz"/);
  const csp = readFileSync(join(on.out, '_headers'), 'utf8').match(/connect-src ([^;]+)/)[1];
  assert.ok(csp.split(' ').includes('https://pay-cashapp.buzz'), csp);
  assert.doesNotMatch(csp, /breez\.tips/, 'the library default domain is never contacted');
  assert.match(on.stdout, /lightning address @pay-cashapp\.buzz/);
  assert.ok(JSON.parse(readFileSync(join(on.out, 'version.json'), 'utf8')).files['lnaddress.js']);
  for (const bad of ['https://pay-cashapp.buzz', 'pay-cashapp.buzz/x', 'localhost', '1.2.3.4', "a.com'; script-src *"]) {
    const r = build({ WALLET_NETWORK: 'mainnet', WALLET_API_KEY: 'test-wallet-key', LIGHTNING_ADDRESS_DOMAIN: bad });
    assert.notEqual(r.status, 0, bad);
    assert.match(r.stderr, /LIGHTNING_ADDRESS_DOMAIN must be a host name/, bad);
  }
});

test('CPAY_SITE_URL: the website origin by default, off with the link, only an origin accepted', () => {
  const cfgOf = (r) => readFileSync(join(r.out, 'config.js'), 'utf8');
  const def = build({ WALLET_NETWORK: 'mainnet', WALLET_API_KEY: 'test-wallet-key' });
  assert.match(cfgOf(def), /"cpaySiteUrl": "https:\/\/pay-cashapp\.buzz"/);
  assert.match(cfgOf(build({ WALLET_NETWORK: 'regtest', WALLET_LINK: 'off' })), /"cpaySiteUrl": null/);
  for (const bad of ['http://pay-cashapp.buzz', 'https://pay-cashapp.buzz/dashboard.html', 'https://u:p@pay-cashapp.buzz', 'javascript:alert(1)', 'pay-cashapp.buzz']) {
    const r = build({ WALLET_NETWORK: 'mainnet', WALLET_API_KEY: 'test-wallet-key', CPAY_SITE_URL: bad });
    assert.notEqual(r.status, 0, bad);
    assert.match(r.stderr, /CPAY_SITE_URL must be the website origin/, bad);
  }
});
