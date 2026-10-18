// CPAY Wallet passkey login with the REAL wallet library (production build
// rules, regtest, WALLET_RP_ID=localhost) against Chromium's virtual
// authenticator with the WebAuthn PRF extension. No payment network is
// needed: the passkey derivation runs in the page.
//
// What this proves: the library's PasskeyClient, with our provider options,
// creates a passkey and derives a valid 12-word phrase from it; signing in
// again with the same passkey derives the same phrase; the wallet's own
// passkey screens drive it; nothing is stored but the credential id.
import { expect, test, type Page } from '@playwright/test';

async function virtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal',
      hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
      automaticPresenceSimulation: true, hasPrf: true,
    },
  });
  return { cdp, authenticatorId };
}

test('real library: passkey creates a 12-word wallet and signs in to the same one', async ({ page }) => {
  await virtualAuthenticator(page);
  await page.goto('/');
  await expect(page.locator('#passkeyChoice')).toBeVisible();
  const out = await page.evaluate(async () => {
    const pk = await import('./passkey.js');
    const bip = await import('./bip39.js');
    const a = await pk.registerPasskey();
    const b = await pk.signInPasskey(a.credentialId);
    return { same: a.phrase === b.phrase, words: a.phrase.split(' ').length, valid: await bip.validateMnemonic(a.phrase), cred: Boolean(a.credentialId) };
  });
  expect(out).toEqual({ same: true, words: 12, valid: true, cred: true });
});

test('real library: the wallet\'s passkey screens create it and show its words', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); });
  await virtualAuthenticator(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Create with a passkey' }).click();
  await expect(page.locator('#words li')).toHaveCount(12);
  await expect(page.locator('#backupPasskeyNote')).toBeVisible();
  const vaultBefore = await page.evaluate(() => localStorage.getItem('cpay-wallet.vault.v1'));
  expect(vaultBefore).toBeNull(); // nothing saved until the paper check passes
  // The library publishes the wallet label to public Nostr relays in the
  // background (multi-wallet discovery). The wallet uses one fixed label,
  // so the CSP blocks that on purpose: no passkey-linked record goes to a
  // third party. Nothing else may be refused.
  await page.waitForTimeout(3000);
  expect(violations.filter((v) => !/Refused to connect to 'wss:\/\//.test(v))).toEqual([]);
});
