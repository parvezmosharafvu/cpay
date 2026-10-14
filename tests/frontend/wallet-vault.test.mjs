// node --test tests/frontend/wallet-vault.test.mjs
//
// The standalone wallet keeps its recovery phrase only as an encrypted
// blob on the device. Round trip, wrong passphrase, tampering, no
// plaintext in what is stored, and a minimum passphrase length.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_PASSPHRASE, PBKDF2_ITERATIONS, openPhrase, sealPhrase, vaultStore } from '../../wallet/src/vault.js';

const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const FAST = { iterations: 1000 }; // the real default is checked separately

test('seal then open returns the phrase', async () => {
  const blob = await sealPhrase(PHRASE, 'correct horse battery', FAST);
  assert.equal(await openPhrase(blob, 'correct horse battery'), PHRASE);
});

test('a wrong passphrase is refused, not decrypted to garbage', async () => {
  const blob = await sealPhrase(PHRASE, 'correct horse battery', FAST);
  await assert.rejects(() => openPhrase(blob, 'correct horse batterz'), /Wrong passphrase/);
});

test('a tampered blob is refused', async () => {
  const blob = await sealPhrase(PHRASE, 'correct horse battery', FAST);
  const ct = Buffer.from(blob.ct, 'base64');
  ct[0] ^= 1;
  await assert.rejects(() => openPhrase({ ...blob, ct: ct.toString('base64') }, 'correct horse battery'), /Wrong passphrase/);
  await assert.rejects(() => openPhrase({ ...blob, v: 2 }, 'correct horse battery'), /Unknown wallet format/);
});

test('the stored blob contains no word of the phrase', async () => {
  const blob = await sealPhrase(PHRASE, 'correct horse battery', FAST);
  const stored = JSON.stringify(blob).toLowerCase();
  for (const w of new Set(PHRASE.split(' '))) assert.equal(stored.includes(w), false, w);
  assert.equal(stored.includes('correct horse'), false, 'passphrase not stored');
});

test('every seal uses a fresh salt and IV', async () => {
  const a = await sealPhrase(PHRASE, 'correct horse battery', FAST);
  const b = await sealPhrase(PHRASE, 'correct horse battery', FAST);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
});

test('short passphrases are refused; default is 600 000 PBKDF2 rounds', async () => {
  await assert.rejects(() => sealPhrase(PHRASE, 'x'.repeat(MIN_PASSPHRASE - 1), FAST));
  assert.equal(PBKDF2_ITERATIONS, 600_000);
  const blob = await sealPhrase(PHRASE, 'correct horse battery');
  assert.equal(blob.iterations, 600_000);
});

test('vaultStore round trip uses one key and clears it', () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  assert.equal(vaultStore.load(storage), null);
  vaultStore.save({ v: 1 }, storage);
  assert.deepEqual([...mem.keys()], [vaultStore.SLOT]);
  assert.deepEqual(vaultStore.load(storage), { v: 1 });
  vaultStore.clear(storage);
  assert.equal(vaultStore.load(storage), null);
});
