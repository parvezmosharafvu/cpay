// The wallet uses a passkey only on its RP ID's own host, over https, and
// offers creating one only with the build's passkey switch on.
//   node --test tests/wallet/passkey-origin.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.CPAY_WALLET_CONFIG = { engine: 'sdk', rpId: 'wallet.pay-cashapp.buzz', passkeys: true };
const pk = await import('../../wallet/src/passkey.js');
const at = (href) => { const u = new URL(href); return { protocol: u.protocol, hostname: u.hostname }; };

test('only https on exactly the RP ID host', () => {
  assert.equal(pk.passkeyOriginOk(at('https://wallet.pay-cashapp.buzz/')), true);
  for (const href of [
    'http://wallet.pay-cashapp.buzz/', // not https
    'https://pay-cashapp.buzz/', // the website
    'https://www.pay-cashapp.buzz/',
    'https://evil.wallet.pay-cashapp.buzz/', // a subdomain could claim the RP ID; the wallet never runs there
    'https://wallet.pay-cashapp.buzz.evil.example/',
    'https://cpay-wallet.example.workers.dev/',
  ]) assert.equal(pk.passkeyOriginOk(at(href)), false, href);
});

test('plain http only for localhost in tests', () => {
  globalThis.CPAY_WALLET_CONFIG = { engine: 'sdk', rpId: 'localhost', passkeys: true };
  assert.equal(pk.passkeyOriginOk(at('http://localhost:8793/')), true);
  assert.equal(pk.passkeyOriginOk(at('http://127.0.0.1:8793/')), false);
});

test('no RP ID: never', () => {
  globalThis.CPAY_WALLET_CONFIG = { engine: 'sdk', rpId: null, passkeys: true };
  assert.equal(pk.passkeyOriginOk(at('https://wallet.pay-cashapp.buzz/')), false);
});

test('switch off: nothing offered, nothing registered', async () => {
  globalThis.CPAY_WALLET_CONFIG = { engine: 'sdk', rpId: 'wallet.pay-cashapp.buzz', passkeys: false };
  assert.equal(pk.passkeyConfigured(), false);
  assert.equal(await pk.passkeyAvailability(), 'unconfigured');
  await assert.rejects(pk.registerPasskey(), /Passkey configuration/);
  await assert.rejects(pk.signInPasskey(null), /Passkey configuration/);
  assert.equal(pk.passkeyErrorKind(await pk.registerPasskey().catch((e) => e)), 'config');
});
