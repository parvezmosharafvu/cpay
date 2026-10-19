// node --test tests/wallet/verify-release.test.mjs   (needs `npm ci --ignore-scripts` in wallet/)
//
// scripts/wallet-verify-release.mjs (release gate G5): a published wallet
// passes only when every file matches its manifest, the build is a release
// build for the right network, and the strict headers are served. A real
// build is served the way Workers static assets serves it (wallet/serve.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verify } from '../../scripts/wallet-verify-release.mjs';

function build(env) {
  const out = mkdtempSync(join(tmpdir(), 'cpay-wallet-verify-'));
  const r = spawnSync(process.execPath, ['wallet/build.mjs'], { env: { PATH: process.env.PATH, WALLET_OUT: out, ...env }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return { out, sha: createHash('sha256').update(readFileSync(join(out, 'version.json'))).digest('hex') };
}

async function serve(dir, t) {
  const port = 18000 + Math.floor(Math.random() * 2000);
  const p = spawn(process.execPath, ['wallet/serve.mjs', String(port)], { env: { ...process.env, WALLET_DIST: dir }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => p.kill());
  await new Promise((resolve, reject) => {
    p.stdout.on('data', (d) => { if (String(d).includes('wallet: http')) resolve(); });
    p.on('exit', (c) => reject(new Error(`serve exited ${c}`)));
  });
  return `http://127.0.0.1:${port}`;
}

const prod = build({ WALLET_NETWORK: 'mainnet', WALLET_API_KEY: 'test-wallet-key' });

test('a release build served as built matches file by file; its RP ID must be the serving host', async (t) => {
  const url = await serve(prod.out, t);
  const r = await verify({ url, network: 'mainnet', sha256: prod.sha, insecureLocal: true });
  // Every file matches. The one problem: a production build's passkey RP
  // ID is wallet.pay-cashapp.buzz, and this copy is served from 127.0.0.1.
  assert.equal(r.problems.length, 1, r.problems.join('\n'));
  assert.match(r.problems[0], /passkey RP ID wallet\.pay-cashapp\.buzz, but the wallet is served from 127\.0\.0\.1/);
  assert.equal(r.ok, false);
  assert.equal(r.rpId, 'wallet.pay-cashapp.buzz');
  assert.equal(r.passkeys, false, 'production passkeys stay off until G9');
  assert.equal(r.manifestSha, prod.sha);
  const listed = Object.keys(JSON.parse(readFileSync(join(prod.out, 'version.json'), 'utf8')).files).filter((f) => f !== '_headers');
  assert.equal(r.checked, listed.length, 'every served file was downloaded and hashed');
});

test('a changed file, a wrong manifest hash or the wrong network fails', async (t) => {
  const b = build({ WALLET_NETWORK: 'mainnet', WALLET_API_KEY: 'test-wallet-key' });
  appendFileSync(join(b.out, 'app.js'), '\n// changed after the build\n');
  const url = await serve(b.out, t);
  const r = await verify({ url, network: 'regtest', sha256: '0'.repeat(64), insecureLocal: true });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /^app\.js: sha256 /.test(p)), r.problems.join('\n'));
  assert.ok(r.problems.some((p) => /version\.json sha256 .*expected 0{64}/.test(p)));
  assert.ok(r.problems.some((p) => /network mainnet, expected regtest/.test(p)));
});

test('a test build is never accepted', async (t) => {
  const b = build({ WALLET_TEST: '1', WALLET_NETWORK: 'regtest', WALLET_LINK: 'off' });
  const url = await serve(b.out, t);
  const r = await verify({ url, insecureLocal: true });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /TEST build/.test(p)));
});

test('a staging build passes as regtest and is refused as a mainnet release', async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'cpay-wallet-staging-'));
  const r0 = spawnSync('npm', ['run', '--silent', 'build:staging'], { cwd: 'wallet', env: { PATH: process.env.PATH, WALLET_OUT: out }, encoding: 'utf8' });
  assert.equal(r0.status, 0, r0.stderr);
  const url = await serve(out, t);
  assert.equal((await verify({ url, network: 'regtest', insecureLocal: true })).ok, true);
  const asRelease = await verify({ url, network: 'mainnet', insecureLocal: true });
  assert.ok(asRelease.problems.some((p) => /network regtest, expected mainnet/.test(p)));
});

test('served from the RP ID host, the same kind of build passes', async (t) => {
  const b = build({ WALLET_NETWORK: 'regtest', WALLET_LINK: 'off', WALLET_RP_ID: 'localhost' });
  const url = (await serve(b.out, t)).replace('127.0.0.1', 'localhost');
  const r = await verify({ url, network: 'regtest', sha256: b.sha, insecureLocal: true });
  assert.deepEqual(r.problems, []);
  assert.equal(r.rpId, 'localhost');
});

test('only the wallet\'s own https host is checked (wallet.pay-cashapp.buzz is the one subdomain allowed)', async () => {
  for (const [url, why] of [
    ['http://wallet.example.org', /must be https/],
    ['https://pay-cashapp.buzz', /own hostname/],
    ['https://www.pay-cashapp.buzz', /own hostname/],
    ['https://x.wallet.pay-cashapp.buzz', /own hostname/],
    ['http://wallet.pay-cashapp.buzz', /must be https/],
    ['https://wallet.example.org/app', /no path/],
    ['https://user:pw@wallet.example.org', /no credentials/],
  ]) {
    await assert.rejects(verify({ url }), why, url);
  }
});

test('staging builds refuse mainnet, an API key and the CPAY link', () => {
  const run = (env) => spawnSync(process.execPath, ['wallet/build.mjs'], { env: { PATH: process.env.PATH, WALLET_OUT: mkdtempSync(join(tmpdir(), 'w-')), WALLET_STAGE: 'staging', ...env }, encoding: 'utf8' });
  assert.match(run({ WALLET_NETWORK: 'mainnet', WALLET_LINK: 'off' }).stderr, /must be WALLET_NETWORK=regtest/);
  assert.match(run({ WALLET_NETWORK: 'regtest', WALLET_LINK: 'off', WALLET_API_KEY: 'k' }).stderr, /takes no WALLET_API_KEY/);
  assert.match(run({ WALLET_NETWORK: 'regtest' }).stderr, /must set WALLET_LINK=off/);
  assert.match(run({ WALLET_STAGE: 'prod' }).stderr, /WALLET_STAGE must be staging or unset/);
});
