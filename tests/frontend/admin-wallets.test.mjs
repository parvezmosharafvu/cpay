import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const js = readFileSync('public/admin-wallets.js', 'utf8');
const words = readFileSync('public/admin-bip39-words.js', 'utf8');
const admin = readFileSync('public/admin.html', 'utf8');
// Public BIP39 test vector only.
const V1 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function load() {
  const window = {};
  const ctx = { window, document: { readyState: 'complete', getElementById: () => null }, crypto: webcrypto, Uint8Array, MutationObserver: class {} };
  vm.createContext(ctx);
  vm.runInContext(words, ctx);
  vm.runInContext(js, ctx);
  return window;
}

test('client seed check: words and checksum', async () => {
  const w = load();
  assert.equal(w.CPAY_BIP39_WORDS.length, 2048);
  assert.equal(await w.cpayAdminWallets.checkSeed(V1), null);
  assert.equal(await w.cpayAdminWallets.checkSeed(V1.replace(/about$/, 'abandon')), 'seed_checksum');
  assert.equal(await w.cpayAdminWallets.checkSeed(V1.replace(/about$/, 'qqq')), 'seed_unknown_word');
  assert.equal(await w.cpayAdminWallets.checkSeed('abandon'), 'seed_word_count');
});

test('seed field is masked, cleared on submit, never logged or stored', () => {
  assert.match(js, /seed\.type = 'password'/);
  assert.match(js, /seed\.autocomplete = 'off'/);
  assert.match(js, /seed\.value = ''; \/\/ cleared at once/);
  assert.doesNotMatch(js, /console\./);
  assert.doesNotMatch(js, /localStorage|sessionStorage/);
  assert.match(js, /invoke\('wallet-registry'/);
  assert.doesNotMatch(js, /fetch\(/);
});

test('wired into the admin page after the wallet scripts', () => {
  assert.ok(admin.indexOf('admin-bip39-words.js') > admin.indexOf('admin-wallet-route.js'));
  assert.ok(admin.indexOf('admin-wallets.js') > admin.indexOf('admin-bip39-words.js'));
});

test('wallet-registry requires a JWT', () => {
  assert.match(readFileSync('supabase/config.toml', 'utf8'), /\[functions\.wallet-registry\]\nverify_jwt = true/);
});
