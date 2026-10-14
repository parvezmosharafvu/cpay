// CPAY Wallet, PRODUCTION build rules with the REAL wallet library
// (regtest, so no API key), under the real CSP.
//
// Always: the WebAssembly library loads under the wallet's strict CSP and
// builds a config; the fake engine is absent from the build.
// With WALLET_LIVE=1 (needs internet to the Spark regtest network): create
// a wallet in the page, connect with the on-device phrase, read the
// balance, create a Lightning invoice (with its QR) and a regtest deposit
// address. The phrase never appears in any
// request.
import { expect, test, type Request } from '@playwright/test';

const PASS = 'my wallet passphrase';

test('real library loads under the strict CSP; fake engine not shipped', async ({ page, request }) => {
  const violations: string[] = [];
  page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Create a new wallet' })).toBeVisible();
  const net = await page.evaluate(async () => {
    const mod = await import('./vendor/sdk/index.js');
    await mod.default();
    const c = mod.defaultConfig('regtest');
    return { network: c.network, operators: c.sparkConfig.signingOperators.length, threshold: c.sparkConfig.threshold };
  });
  expect(net).toEqual({ network: 'regtest', operators: 3, threshold: 2 });
  expect(violations).toEqual([]);
  expect((await request.get('/fake-engine.js')).status()).toBe(404);
  const release = await (await request.get('/version.json')).json();
  expect(release).toMatchObject({ name: 'CPAY Wallet', test: false, walletLibrary: { version: '0.26.0' } });
  expect(Object.keys(release.files)).not.toContain('fake-engine.js');
});

test('live regtest: phrase made on the device, wallet connects, invoice created', async ({ page }) => {
  test.skip(process.env.WALLET_LIVE !== '1', 'set WALLET_LIVE=1 where the Spark regtest network is reachable');
  test.setTimeout(180_000);
  const bodies: string[] = [];
  page.on('request', (r: Request) => bodies.push(`${r.url()}\n${r.postData() || ''}`));
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a new wallet' }).click();
  await expect(page.locator('#words li')).toHaveCount(12);
  const words = await page.locator('#words li').allTextContents();
  await page.getByLabel('I wrote the 12 words down on paper.').check();
  await page.locator('#backupNext').click();
  for (const input of await page.locator('#confirmFields input').all()) {
    await input.fill(words[Number((await input.getAttribute('id'))!.slice(2))]);
  }
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#pass1').fill(PASS);
  await page.locator('#pass2').fill(PASS);
  await page.getByRole('button', { name: 'Create wallet' }).click();
  await expect(page.getByText('This wallet · your keys')).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('#balSats')).toHaveText('0');
  await page.getByRole('button', { name: 'Receive' }).click();
  await page.locator('#rcvAmount').fill('1000');
  await page.getByRole('button', { name: 'Create invoice' }).click();
  await expect(page.locator('#rcvInvoice')).toHaveValue(/^lnbcrt/i, { timeout: 60_000 });
  await expect(page.locator('#rcvQr')).toBeVisible();
  // The documented regtest funding route: an on-chain deposit address.
  await page.getByRole('button', { name: 'Show deposit address' }).click();
  await expect(page.locator('#fundAddr')).toHaveValue(/^bcrt1/, { timeout: 60_000 });
  const phrase = words.join(' ');
  for (const b of bodies) expect(b.includes(words.slice(0, 4).join(' ')) || b.includes(phrase), 'phrase in a request').toBe(false);
});
