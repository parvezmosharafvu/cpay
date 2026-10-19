// Passkey login: the wallet's 12-word recovery phrase is derived from a
// passkey on this device (WebAuthn PRF extension) instead of being kept
// here encrypted. The library turns the passkey's PRF output into a
// standard 12-word BIP39 phrase, so a passkey wallet IS a 12-word wallet:
// its words, written down at creation, restore it anywhere without the
// passkey.
//
// Nothing secret is stored for a passkey wallet. vault.js keeps only the
// credential id (to ask for that passkey again) and the label. The phrase
// is derived on each unlock, handed to the engine and dropped.
//
// The Relying Party is the wallet's own hostname (WALLET_RP_ID at build
// time; production is pinned to wallet.pay-cashapp.buzz). Every passkey is
// bound to it for good: changing it strands existing passkeys, so their
// owners would restore with the 12 words. The wallet uses a passkey only
// when the page is served from exactly that host, over https.
//
// Creating or signing in with a passkey also needs the build's passkey
// switch (WALLET_PASSKEYS=on). Unlocking a passkey wallet this phone
// already has needs only the RP ID and the origin check.
//
// Test builds (engine 'fake') use the fake in fake-engine.js; production
// builds do not ship that file.

const cfg = () => globalThis.CPAY_WALLET_CONFIG || {};

// One wallet per passkey for now. Changing this derives a different wallet.
export const PASSKEY_LABEL = 'Default';

/** Whether this page is on the RP ID's own host (https, or localhost in tests). */
export function passkeyOriginOk(loc = globalThis.location) {
  const rp = cfg().rpId;
  if (!rp || !loc) return false;
  const secure = loc.protocol === 'https:' || (loc.hostname === 'localhost' && loc.protocol === 'http:');
  return secure && String(loc.hostname).toLowerCase() === rp;
}

/** Whether a passkey wallet this phone already has can be unlocked here. */
export const passkeyUsable = () => cfg().engine === 'fake' || passkeyOriginOk();

/** Whether this build offers creating or signing in with a passkey. */
export const passkeyConfigured = () => cfg().passkeys === true && passkeyUsable();

let client = null;
async function getClient() {
  if (client) return client;
  if (cfg().engine === 'fake') {
    const { createFakePasskey } = await import('./fake-engine.js');
    client = createFakePasskey();
    return client;
  }
  const sdk = await import('./vendor/sdk/index.js');
  await sdk.default();
  const { PasskeyProvider } = await import('./vendor/sdk/passkey-prf-provider/index.js');
  const name = 'CPAY Wallet';
  const provider = new PasskeyProvider(
    { rpId: cfg().rpId, rpName: name, userName: name, userDisplayName: name },
    // Under the ~60 s platform cap, so a timeout is reported as one.
    { defaultTimeoutMs: 50_000 },
  );
  client = new sdk.PasskeyClient(provider, cfg().apiKey || null, { defaultLabel: PASSKEY_LABEL });
  return client;
}

/**
 * 'available', or why not: 'unconfigured' (passkeys off in this build),
 * 'unsupported' (no PRF on this device or browser), 'misconfigured' (this
 * page is not on the RP ID's host).
 */
export async function passkeyAvailability() {
  if (cfg().passkeys !== true) return 'unconfigured';
  if (!passkeyUsable()) return 'misconfigured';
  try {
    const a = await (await getClient()).checkAvailability();
    if (a.type === 'available' || a.type === 'skipped') return 'available';
    return a.type === 'prfUnsupported' ? 'unsupported' : 'misconfigured';
  } catch {
    return 'unsupported';
  }
}

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function phraseOf(wallet) {
  const seed = wallet?.seed;
  if (seed?.type !== 'mnemonic' || typeof seed.mnemonic !== 'string') throw new Error('The passkey did not give a recovery phrase.');
  return seed.mnemonic;
}

/** First-time setup: create a passkey and derive its wallet. */
export async function registerPasskey() {
  if (!passkeyConfigured()) throw new Error('Passkey configuration: not offered on this copy of the wallet');
  const res = await (await getClient()).register({ label: PASSKEY_LABEL });
  const id = res.credential?.credentialId;
  return { phrase: phraseOf(res.wallet), credentialId: id ? b64(Uint8Array.from(id)) : null };
}

/**
 * Sign in with a passkey. With a credential id (this phone's wallet), the
 * browser asks for that passkey only; without, it shows its picker.
 * `existing` marks this phone's own passkey wallet (unlock, reveal).
 */
export async function signInPasskey(credentialId, { existing = false } = {}) {
  // A new sign-in needs the switch; this phone's own wallet (unlock,
  // reveal) does not.
  if (!(existing ? passkeyUsable() : passkeyConfigured())) throw new Error('Passkey configuration: not offered on this copy of the wallet');
  const req = { label: PASSKEY_LABEL };
  if (credentialId) req.allowCredentials = [unb64(credentialId)];
  const res = await (await getClient()).signIn(req);
  const id = res.credential?.credentialId;
  return { phrase: phraseOf(res.wallet), credentialId: id ? b64(Uint8Array.from(id)) : credentialId || null };
}

/**
 * The library's errors reach the page as messages. The order matters:
 * "created but derivation failed" carries the underlying reason too.
 */
export function passkeyErrorKind(e) {
  const m = String(e?.message ?? e ?? '');
  const name = e?.name || e?.constructor?.name || '';
  if (/Passkey created but derivation failed/i.test(m)) return 'created';
  if (/AlreadyExists/.test(name) || /already exists/i.test(m)) return 'exists';
  if (/TimedOut/.test(name) || /timed out/i.test(m)) return 'timeout';
  if (/UserCancelled/.test(name) || /cancel/i.test(m) || /NotAllowedError/.test(name)) return 'cancelled';
  if (/CredentialNotFound/.test(name) || /credential not found|no credential/i.test(m)) return 'not_found';
  if (/PRF not supported|prf.*unsupported/i.test(m)) return 'unsupported';
  if (/configuration/i.test(m)) return 'config';
  return 'generic';
}

/** What to tell the person for each kind. */
export function passkeyMessage(kind) {
  return {
    created: 'Your passkey was created, but the wallet could not be opened with it. Do not create another one: tap "Sign in with a passkey" and choose it.',
    exists: 'This device already has a CPAY Wallet passkey. Tap "Sign in with a passkey" instead.',
    timeout: 'The passkey prompt timed out. Try again when you are ready.',
    cancelled: 'The passkey prompt was closed. Try again when you are ready.',
    not_found: 'No CPAY Wallet passkey was found on this device. Create one, or restore with your 12 words.',
    unsupported: 'This device or browser cannot use passkeys for a wallet. Use a 12-word recovery phrase instead.',
    config: 'Passkeys are not set up correctly for this copy of the wallet. Use a 12-word recovery phrase for now.',
    generic: 'The passkey did not work. Check the connection and try again, or use your 12 words.',
  }[kind] || 'The passkey did not work.';
}
