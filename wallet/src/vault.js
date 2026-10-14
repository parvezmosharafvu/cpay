// The recovery phrase at rest: encrypted on this device with a passphrase
// only the user knows. CPAY never sees the passphrase, the phrase or the
// ciphertext; nothing here makes a network request.
//
//   key  = PBKDF2-HMAC-SHA256(passphrase, 16-byte random salt, 600 000 rounds)
//   blob = AES-256-GCM(key, 12-byte random IV, phrase), version as AAD
//
// A wrong passphrase fails the GCM tag check, so it cannot decrypt to
// garbage. The derived key is non-extractable.
const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const VAULT_VERSION = 1;
export const PBKDF2_ITERATIONS = 600_000;
export const MIN_PASSPHRASE = 10;

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(passphrase, salt, iterations) {
  const base = await subtle().importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

const aad = (v) => enc.encode(`cpay-wallet-vault-v${v}`);

export async function sealPhrase(phrase, passphrase, { iterations = PBKDF2_ITERATIONS } = {}) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) {
    throw new Error(`Use a passphrase of at least ${MIN_PASSPHRASE} characters.`);
  }
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad(VAULT_VERSION) }, key, enc.encode(phrase)));
  return { v: VAULT_VERSION, kdf: 'PBKDF2-SHA256', iterations, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

export async function openPhrase(blob, passphrase) {
  if (!blob || blob.v !== VAULT_VERSION || blob.kdf !== 'PBKDF2-SHA256') throw new Error('Unknown wallet format.');
  const key = await deriveKey(passphrase, unb64(blob.salt), blob.iterations);
  try {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(blob.iv), additionalData: aad(blob.v) }, key, unb64(blob.ct));
    return dec.decode(pt);
  } catch {
    throw new Error('Wrong passphrase.');
  }
}

// Storage is this wallet's own origin (never the CPAY website's origin).
const SLOT = 'cpay-wallet.vault.v1'; // localStorage item name
export const vaultStore = {
  load(storage = globalThis.localStorage) {
    const raw = storage.getItem(SLOT);
    return raw ? JSON.parse(raw) : null;
  },
  save(blob, storage = globalThis.localStorage) {
    storage.setItem(SLOT, JSON.stringify(blob));
  },
  clear(storage = globalThis.localStorage) {
    storage.removeItem(SLOT);
  },
  SLOT,
};
