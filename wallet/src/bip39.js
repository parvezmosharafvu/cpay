// BIP-39 recovery phrases, generated and checked on this device only.
//
// Only the entropy -> words step lives here (and its checksum check for
// restore). Turning the words into keys is done by the wallet engine from
// the same words, so nothing here touches key material beyond the phrase.
// Randomness comes from crypto.getRandomValues; the checksum is SHA-256
// from WebCrypto. tests/wallet/bip39.test.mjs runs the official BIP-39
// English vectors against this file.
import { WORDLIST } from './wordlist-en.js';

const subtle = () => globalThis.crypto.subtle;

async function sha256(bytes) {
  return new Uint8Array(await subtle().digest('SHA-256', bytes));
}

function bitsOf(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(2).padStart(8, '0');
  return out;
}

// 16 bytes -> 12 words, 32 bytes -> 24 words (the two sizes this wallet uses).
export async function entropyToMnemonic(entropy) {
  const bytes = entropy instanceof Uint8Array ? entropy : new Uint8Array(entropy);
  if (![16, 20, 24, 28, 32].includes(bytes.length)) throw new Error('entropy must be 16-32 bytes in steps of 4');
  const checksumBits = bitsOf(await sha256(bytes)).slice(0, bytes.length / 4);
  const bits = bitsOf(bytes) + checksumBits;
  const words = [];
  for (let i = 0; i < bits.length; i += 11) words.push(WORDLIST[parseInt(bits.slice(i, i + 11), 2)]);
  return words.join(' ');
}

export async function generateMnemonic(words = 12) {
  if (words !== 12 && words !== 24) throw new Error('12 or 24 words');
  const entropy = new Uint8Array(words === 12 ? 16 : 32);
  globalThis.crypto.getRandomValues(entropy);
  try {
    return await entropyToMnemonic(entropy);
  } finally {
    entropy.fill(0);
  }
}

// Lower-case, single spaces, no leading or trailing space.
export function normalizeMnemonic(text) {
  return String(text ?? '').normalize('NFKD').trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

// True only for 12 or 24 known words whose checksum matches.
export async function validateMnemonic(text) {
  const words = normalizeMnemonic(text).split(' ');
  if (words.length !== 12 && words.length !== 24) return false;
  let bits = '';
  for (const w of words) {
    const i = WORDLIST.indexOf(w);
    if (i < 0) return false;
    bits += i.toString(2).padStart(11, '0');
  }
  const csLen = words.length / 3; // 4 bits for 12 words, 8 for 24
  const entBits = bits.slice(0, bits.length - csLen);
  const entropy = new Uint8Array(entBits.length / 8);
  for (let i = 0; i < entropy.length; i++) entropy[i] = parseInt(entBits.slice(i * 8, i * 8 + 8), 2);
  const expected = bitsOf(await sha256(entropy)).slice(0, csLen);
  entropy.fill(0);
  return expected === bits.slice(bits.length - csLen);
}
