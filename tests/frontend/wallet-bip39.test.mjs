// node --test tests/frontend/wallet-bip39.test.mjs
//
// The standalone wallet's recovery phrases: official BIP-39 English
// vectors (entropy -> words), checksum validation for restore, and the
// wordlist matching the specification's published hash.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { WORDLIST } from '../../wallet/src/wordlist-en.js';
import { entropyToMnemonic, generateMnemonic, normalizeMnemonic, validateMnemonic } from '../../wallet/src/bip39.js';

// From the BIP-39 reference vectors (trezor/python-mnemonic vectors.json).
const VECTORS = [
  ['00000000000000000000000000000000', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'],
  ['7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f', 'legal winner thank year wave sausage worth useful legal winner thank yellow'],
  ['80808080808080808080808080808080', 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above'],
  ['ffffffffffffffffffffffffffffffff', 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'],
  ['9e885d952ad362caeb4efe34a8e91bd2', 'ozone drill grab fiber curtain grace pudding thank cruise elder eight picnic'],
  ['0460ef47585604c5660618db2e6a7e7f', 'afford alter spike radar gate glance object seek swamp infant panel yellow'],
  ['0000000000000000000000000000000000000000000000000000000000000000', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'],
  ['ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote'],
  ['68a79eaca2324873eacc50cb9c6eca8cc68ea5d936f98787c60c7ebc74e6ce7c', 'hamster diagram private dutch cause delay private meat slide toddler razor book happy fancy gospel tennis maple dilemma loan word shrug inflict delay length'],
];

test('wordlist is the BIP-39 English list', () => {
  assert.equal(WORDLIST.length, 2048);
  const hash = createHash('sha256').update(WORDLIST.join('\n') + '\n').digest('hex');
  assert.equal(hash, '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda');
});

test('entropy -> mnemonic matches the official vectors', async () => {
  for (const [hex, words] of VECTORS) {
    assert.equal(await entropyToMnemonic(Buffer.from(hex, 'hex')), words, hex);
    assert.equal(await validateMnemonic(words), true, `valid: ${hex}`);
  }
});

test('generated phrases are 12 or 24 valid words and differ each time', async () => {
  const a = await generateMnemonic(12);
  const b = await generateMnemonic(12);
  const c = await generateMnemonic(24);
  assert.equal(a.split(' ').length, 12);
  assert.equal(c.split(' ').length, 24);
  assert.notEqual(a, b);
  for (const m of [a, b, c]) assert.equal(await validateMnemonic(m), true);
  await assert.rejects(() => generateMnemonic(15));
});

test('restore rejects a bad checksum, unknown words and wrong lengths', async () => {
  const good = VECTORS[0][1];
  assert.equal(await validateMnemonic(good.replace(/about$/, 'abandon')), false, 'checksum');
  assert.equal(await validateMnemonic(good.replace(/^abandon/, 'notaword')), false, 'unknown word');
  assert.equal(await validateMnemonic('abandon abandon abandon'), false, 'too short');
  assert.equal(await validateMnemonic(''), false, 'empty');
});

test('restore tolerates case and extra spaces', async () => {
  const messy = `  ${VECTORS[1][1].toUpperCase().split(' ').join('   ')}\n`;
  assert.equal(normalizeMnemonic(messy), VECTORS[1][1]);
  assert.equal(await validateMnemonic(messy), true);
});
