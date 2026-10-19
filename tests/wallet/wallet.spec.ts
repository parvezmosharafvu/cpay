// CPAY Wallet, TEST build (fake engine: no payment network), real CSP,
// against a fake CPAY account API that records every request.
//
// What this proves: the recovery phrase and passphrase never leave the
// page (no request to any host carries them), only ciphertext is stored,
// backup is checked before the wallet exists, lock/unlock/restore/wipe
// work, the optional CPAY link is consented, read-only, labelled as a
// separate CPAY-held balance and revocable, and the wallet opens offline.
import { expect, test, type Page, type Request } from '@playwright/test';
// Test-only QR decoder (wallet devDependency), to read back what the page drew.
import jsQRModule from '../../wallet/node_modules/jsqr/dist/jsQR.js';
const jsQR = ((jsQRModule as any).default || jsQRModule) as (d: Uint8ClampedArray, w: number, h: number) => { data: string } | null;
async function decodeCanvas(page: Page, id: string): Promise<string | null> {
  const img = await page.evaluate((cid) => {
    const c = document.getElementById(cid) as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
    return { w: c.width, h: c.height, data: Array.from(d.data) };
  }, id);
  const out = jsQR(Uint8ClampedArray.from(img.data), img.w, img.h);
  return out ? out.data : null;
}

const CPAY = 'http://127.0.0.1:8791';
const PASS = 'my wallet passphrase';
const VECTOR = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

// Every request the page makes, to any host, with its body.
const seen: { url: string; body: string; headers: string }[] = [];
function record(page: Page) {
  page.on('request', (r: Request) => {
    seen.push({ url: r.url(), body: r.postData() || '', headers: JSON.stringify(r.headers()) });
  });
}
function assertNoLeak(phrase: string) {
  const words = phrase.split(' ');
  const needles = [phrase, PASS];
  for (let i = 0; i + 4 <= words.length; i++) needles.push(words.slice(i, i + 4).join(' '), words.slice(i, i + 4).join('","'), words.slice(i, i + 4).join('%20'), words.slice(i, i + 4).join('+'));
  for (const r of seen) {
    const hay = `${decodeURIComponent(r.url)}\n${r.body}\n${r.headers}`;
    for (const n of needles) expect(hay.includes(n), `leaked "${n}" in ${r.url}`).toBe(false);
  }
}

async function readWords(page: Page): Promise<string> {
  await expect(page.locator('#words li')).toHaveCount(12); // rendered after the click resolves
  const items = await page.locator('#words li').allTextContents();
  expect(items).toHaveLength(12);
  return items.join(' ');
}

async function createWallet(page: Page): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a new wallet' }).click();
  const phrase = await readWords(page);
  await expect(page.locator('#backupNext')).toBeDisabled();
  await page.getByLabel('I wrote the 12 words down on paper.').check();
  await page.locator('#backupNext').click();
  const words = phrase.split(' ');
  for (const input of await page.locator('#confirmFields input').all()) {
    const i = Number((await input.getAttribute('id'))!.slice(2));
    await input.fill(words[i]);
  }
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#pass1').fill(PASS);
  await page.locator('#pass2').fill(PASS);
  await page.getByRole('button', { name: 'Create wallet' }).click();
  await expect(page.getByText('This wallet · your keys')).toBeVisible();
  return phrase;
}

async function fingerprintOf(page: Page, phrase: string) {
  return page.evaluate(async (m) => {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(m)));
    return Array.from(d.slice(0, 4), (b) => b.toString(16).padStart(2, '0')).join('');
  }, phrase);
}

test.beforeEach(async ({ page, request }) => {
  seen.length = 0;
  await request.get(`${CPAY}/__reset`);
  record(page);
});

test('create: phrase shown once, paper check enforced, only ciphertext stored', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a new wallet' }).click();
  const phrase = await readWords(page);
  await page.getByLabel('I wrote the 12 words down on paper.').check();
  await page.locator('#backupNext').click();
  await expect(page.locator('#words li')).toHaveCount(0); // hidden while checking
  for (const input of await page.locator('#confirmFields input').all()) await input.fill('wrong');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('That does not match.')).toBeVisible();
  await expect(page.locator('#s-setpass')).toBeHidden();
  const words = phrase.split(' ');
  for (const input of await page.locator('#confirmFields input').all()) {
    await input.fill(words[Number((await input.getAttribute('id'))!.slice(2))]);
  }
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#pass1').fill('short');
  await page.locator('#pass2').fill('short');
  await page.getByRole('button', { name: 'Create wallet' }).click();
  await expect(page.getByText('at least 10 characters')).toBeVisible();
  await page.locator('#pass1').fill(PASS);
  await page.locator('#pass2').fill(PASS);
  await page.getByRole('button', { name: 'Create wallet' }).click();
  await expect(page.getByText('This wallet · your keys')).toBeVisible();
  await expect(page.locator('#balSats')).toHaveText('0');

  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  for (const w of new Set(words)) expect(stored.includes(`"${w}`) || stored.includes(` ${w} `), w).toBe(false);
  const vault = JSON.parse(await page.evaluate(() => localStorage.getItem('cpay-wallet.vault.v1') || 'null'));
  expect(vault).toMatchObject({ v: 1, kdf: 'PBKDF2-SHA256', iterations: 600000 });
  expect(Object.keys(vault).sort()).toEqual(['ct', 'iterations', 'iv', 'kdf', 'salt', 'v']);
  expect(await page.evaluate(() => (window as any).__fakeWallet.fingerprint)).toBe(await fingerprintOf(page, phrase));
  assertNoLeak(phrase);
});

test('receive, then send with a fee confirm; balances move only in this wallet', async ({ page }) => {
  const phrase = await createWallet(page);
  await page.getByRole('button', { name: 'Receive' }).click();
  await page.locator('#rcvAmount').fill('2100');
  await page.getByRole('button', { name: 'Create invoice' }).click();
  await expect(page.locator('#rcvInvoice')).toHaveValue(/^lnbcrt2100n1fake/);
  await expect(page.locator('#rcvQr')).toBeVisible();
  expect(await decodeCanvas(page, 'rcvQr')).toBe(`lightning:${await page.locator('#rcvInvoice').inputValue()}`);
  await page.evaluate(() => (window as any).__fakeWallet.credit(5000));
  await expect(page.locator('#balSats')).toHaveText('5,000');

  await page.getByRole('button', { name: 'Send' }).click();
  await page.locator('#sendTo').fill('lnbcrt9000n1fakeinvoice');
  await page.getByRole('button', { name: 'Check fee' }).click();
  await expect(page.locator('#sendSats')).toHaveText('9,000');
  await page.getByRole('button', { name: 'Send now' }).click();
  await expect(page.getByText('Not enough sats in this wallet.')).toBeVisible();
  await expect(page.locator('#balSats')).toHaveText('5,000');

  await page.locator('#sendTo').fill('lnbcrt1000n1fakeinvoice');
  await page.getByRole('button', { name: 'Check fee' }).click();
  await expect(page.locator('#sendFee')).toHaveText('1');
  await page.getByRole('button', { name: 'Send now' }).click();
  await expect(page.locator('#balSats')).toHaveText('3,999');
  await expect(page.locator('#history li')).toHaveCount(2);
  assertNoLeak(phrase);
});

test('lock, wrong passphrase refused, unlock reopens the same wallet', async ({ page }) => {
  const phrase = await createWallet(page);
  const fp = await page.evaluate(() => (window as any).__fakeWallet.fingerprint);
  await page.getByRole('button', { name: 'Lock' }).click();
  await expect(page.locator('#s-unlock')).toBeVisible();
  await page.reload();
  await page.locator('#unlockPass').fill('not the passphrase');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.locator('#unlockErr')).toHaveText('Wrong passphrase.');
  await page.locator('#unlockPass').fill(PASS);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByText('This wallet · your keys')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__fakeWallet.fingerprint)).toBe(fp);
  assertNoLeak(phrase);
});

test('reveal phrase needs the passphrase and matches the backup', async ({ page }) => {
  const phrase = await createWallet(page);
  await page.getByRole('button', { name: 'Show recovery phrase' }).click();
  await page.locator('#revealPass').fill('wrong passphrase!');
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  await expect(page.locator('#revealErr')).toHaveText('Wrong passphrase.');
  await page.locator('#revealPass').fill(PASS);
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  await expect(page.locator('#revealWords li')).toHaveCount(12);
  expect((await page.locator('#revealWords li').allTextContents()).join(' ')).toBe(phrase);
  assertNoLeak(phrase);
});

test('restore: bad phrase refused; a valid phrase restores that wallet', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Restore with a recovery phrase' }).click();
  await page.locator('#restoreWords').fill(VECTOR.replace(/yellow$/, 'zoo'));
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('That is not a valid 12- or 24-word recovery phrase.')).toBeVisible();
  await page.locator('#restoreWords').fill(`  ${VECTOR.toUpperCase()} `);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#pass1').fill(PASS);
  await page.locator('#pass2').fill(PASS);
  await page.getByRole('button', { name: 'Create wallet' }).click();
  await expect(page.getByText('This wallet · your keys')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__fakeWallet.fingerprint)).toBe(await fingerprintOf(page, VECTOR));
  assertNoLeak(VECTOR);
});

test('optional CPAY link: consent, separate labelled balances, revocable', async ({ page, request }) => {
  const phrase = await createWallet(page);
  await page.evaluate(() => (window as any).__fakeWallet.credit(777));
  const card = page.locator('#linkCard');
  await expect(card).toBeVisible();
  await expect(card).toContainText('never shares the wallet\'s recovery phrase or keys');

  await page.locator('#linkEmail').fill('member@example.test');
  await page.locator('#linkPass').fill('site-password-123');
  await page.getByRole('button', { name: 'Link account' }).click();
  // Without consent the browser refuses to submit the form: nothing is sent.
  expect(await page.locator('#linkConsent').evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true);
  await page.waitForTimeout(300);
  expect(await (await request.get(`${CPAY}/__log`)).json()).toEqual([]);
  await page.getByLabel('I want this app to sign in to my CPAY account and show its balance.').check();
  await page.getByRole('button', { name: 'Link account' }).click();

  await expect(page.getByText('CPAY website balance · held by CPAY')).toBeVisible();
  await expect(page.locator('#siteBal')).toHaveText('$12.50 available');
  await expect(page.locator('#balSats')).toHaveText('777'); // the wallet's own number is untouched
  await expect(page.locator('#linkOn')).toContainText('It is not in this wallet');

  let log = await (await request.get(`${CPAY}/__log`)).json();
  expect(log.map((r: any) => r.path)).toEqual(['/auth/v1/token', '/rest/v1/rpc/get_my_balance']);
  expect(JSON.stringify(log)).not.toContain(phrase.split(' ').slice(0, 4).join(' '));

  await page.getByRole('button', { name: 'Unlink', exact: true }).click();
  await expect(page.locator('#linkOff')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('cpay-wallet.cpay-link'))).toBeNull();
  log = await (await request.get(`${CPAY}/__log`)).json();
  expect(log.at(-1)).toMatchObject({ path: '/auth/v1/logout', query: '?scope=local' });

  await page.getByLabel('I want this app to sign in to my CPAY account and show its balance.').check();
  await page.locator('#linkPass').fill('site-password-123');
  await page.getByRole('button', { name: 'Link account' }).click();
  await expect(page.locator('#siteBal')).toHaveText('$12.50 available');
  await page.getByRole('button', { name: 'Unlink and sign out everywhere' }).click();
  await expect(page.locator('#linkOff')).toBeVisible();
  log = await (await request.get(`${CPAY}/__log`)).json();
  expect(log.at(-1)).toMatchObject({ path: '/auth/v1/logout', query: '?scope=global' });
  assertNoLeak(phrase);
});

test('wrong CPAY password: link refused, wallet unaffected', async ({ page }) => {
  const phrase = await createWallet(page);
  await page.locator('#linkEmail').fill('member@example.test');
  await page.locator('#linkPass').fill('nope-nope-nope');
  await page.getByLabel('I want this app to sign in to my CPAY account and show its balance.').check();
  await page.getByRole('button', { name: 'Link account' }).click();
  await expect(page.locator('#linkErr')).toHaveText('Could not sign in to CPAY. Check the email and password.');
  await expect(page.getByText('This wallet · your keys')).toBeVisible();
  assertNoLeak(phrase);
});

test('opens and unlocks offline (no CPAY website, no network)', async ({ page, context }) => {
  const phrase = await createWallet(page);
  await page.waitForFunction(() => navigator.serviceWorker?.controller || navigator.serviceWorker?.ready.then(() => true));
  await page.reload(); // now served by the service worker
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#offline')).toBeVisible();
  await page.locator('#unlockPass').fill(PASS);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByText('This wallet · your keys')).toBeVisible();
  await page.getByRole('button', { name: 'Show recovery phrase' }).click();
  await page.locator('#revealPass').fill(PASS);
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  await expect(page.locator('#revealWords li')).toHaveCount(12);
  expect((await page.locator('#revealWords li').allTextContents()).join(' ')).toBe(phrase);
  await context.setOffline(false);
  assertNoLeak(phrase);
});

test('remove from this phone needs DELETE and leaves nothing behind', async ({ page }) => {
  const phrase = await createWallet(page);
  await page.getByRole('button', { name: 'Remove wallet from this phone' }).click();
  await page.locator('#wipeText').fill('delete');
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByText('This wallet · your keys')).toBeVisible();
  await page.locator('#wipeText').fill('DELETE');
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create a new wallet' })).toBeVisible();
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('cpay-wallet')))).toEqual([]);
  assertNoLeak(phrase);
});

test('the page runs under the strict CSP with no violations', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); });
  const res = await page.goto('/');
  const csp = res!.headers()['content-security-policy'];
  expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(csp).not.toContain('unsafe-inline');
  expect(csp).toContain("frame-ancestors 'none'");
  await createWallet(page);
  expect(violations).toEqual([]);
});

test('beta warning on every screen; test-network note on a regtest build', async ({ page }) => {
  await page.goto('/');
  const banner = page.locator('#betaBanner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Only use small amounts you can afford to lose');
  await expect(banner).toContainText('test network');
  const phrase = await createWallet(page);
  await expect(banner).toBeVisible();
  await page.goto('/security.html');
  await expect(page.getByText('Only use small amounts you can afford to lose')).toBeVisible();
  assertNoLeak(phrase);
});

test('regtest funding: deposit address with a QR that decodes to it', async ({ page }) => {
  const phrase = await createWallet(page);
  await expect(page.locator('#fundPanel')).toBeVisible();
  await page.getByRole('button', { name: 'Show deposit address' }).click();
  const addr = await page.locator('#fundAddr').inputValue();
  expect(addr).toMatch(/^bcrt1/);
  await expect(page.locator('#fundQr')).toBeVisible();
  expect(await decodeCanvas(page, 'fundQr')).toBe(`bitcoin:${addr}`);
  await page.getByRole('button', { name: 'Lock' }).click();
  expect(await page.locator('#fundAddr').inputValue()).toBe('');
  assertNoLeak(phrase);
});

test('welcome explains Spark operator co-signing before a wallet is made', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#s-welcome')).toContainText('co-signing by Spark operators');
  await expect(page.locator('#s-welcome')).toContainText('Lightspark, Breez and Flashnet');
});

test('exit backup downloads a file, needs no network, and holds no phrase', async ({ page }) => {
  const phrase = await createWallet(page);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save exit backup' }).click()]);
  expect(dl.suggestedFilename()).toMatch(/^cpay-wallet-exit-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const fs = await import('node:fs');
  const text = fs.readFileSync((await dl.path())!, 'utf8');
  expect(JSON.parse(text).fake).toBe(true);
  for (const w of [phrase, PASS]) expect(text.includes(w)).toBe(false);
  await expect(page.locator('#exitErr')).toBeHidden();
  assertNoLeak(phrase);
});

// ---- send outcomes that are not a plain success (audit 2026-10-18) ----------
test('a send that times out after paying is shown as in progress, never as "nothing sent", and is not paid twice', async ({ page }) => {
  const phrase = await createWallet(page);
  await page.evaluate(() => (window as any).__fakeWallet.credit(5000));
  await page.getByRole('button', { name: 'Send' }).click();
  await page.locator('#sendTo').fill('lnbcrt1000n1fakeuncertain');
  await page.getByRole('button', { name: 'Check fee' }).click();
  await page.evaluate(() => { (window as any).__fakeWallet.failNextSend = 'after'; });
  await page.getByRole('button', { name: 'Send now' }).click();
  await expect(page.locator('#sendUnsureMsg')).toHaveText(/in progress and may still complete\. Do not pay again/);
  await expect(page.getByText('Nothing was sent')).toHaveCount(0);
  await expect(page.locator('#sendRetry')).toBeHidden();
  await expect(page.locator('#pendingSends')).toContainText('may still complete');
  await expect(page.locator('#history')).toContainText('in progress, do not pay again');
  // Preparing the same request again warns before a second payment.
  await page.locator('#sendTo').fill('lnbcrt1000n1fakeuncertain');
  await page.getByRole('button', { name: 'Check fee' }).click();
  await expect(page.locator('#sendDupWarn')).toContainText('sending again may pay twice');
  await page.getByRole('button', { name: 'Cancel' }).click();
  // The payment lands: the notice goes, one send in all.
  await page.evaluate(() => {
    const w = (window as any).__fakeWallet;
    const keys = JSON.parse(localStorage.getItem('cpay-wallet.sends.v1') || '[]').map((x: { k: string }) => x.k);
    for (const k of keys) w.settle(k);
  });
  await expect(page.locator('#pendingSends')).toBeHidden();
  expect(await page.evaluate(() => (window as any).__fakeWallet.sendCount)).toBe(1);
  await expect(page.locator('#balSats')).toHaveText('3,999');
  assertNoLeak(phrase);
});

test('"Try again safely" after an unconfirmed send reuses the same payment and pays once', async ({ page }) => {
  await createWallet(page);
  await page.evaluate(() => (window as any).__fakeWallet.credit(5000));
  await page.getByRole('button', { name: 'Send' }).click();
  await page.locator('#sendTo').fill('lnbcrt1000n1fakeretry');
  await page.getByRole('button', { name: 'Check fee' }).click();
  await page.evaluate(() => { (window as any).__fakeWallet.failNextSend = 'before'; });
  await page.getByRole('button', { name: 'Send now' }).click();
  await expect(page.locator('#sendUnsureMsg')).toContainText('Could not reach the network.');
  await expect(page.locator('#sendUnsureMsg')).toContainText('most likely not sent');
  await page.getByRole('button', { name: 'Try again safely' }).click();
  await expect(page.locator('#sendPanel')).toBeHidden();
  await expect(page.locator('#balSats')).toHaveText('3,999');
  expect(await page.evaluate(() => (window as any).__fakeWallet.sendCount)).toBe(1);
});

test('restoring a different phrase over this phone\'s wallet needs REPLACE; the same phrase does not', async ({ page }) => {
  const phrase = await createWallet(page);
  await expect(page.locator('#backupStatus')).toContainText('you checked your paper copy when you created this wallet');
  await page.getByRole('button', { name: 'Lock' }).click();
  await page.locator('#forgotLink').click();
  // The same wallet (forgotten passphrase): no warning.
  await page.locator('#restoreWords').fill(phrase);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('#s-setpass')).toBeVisible();
  await expect(page.locator('#restoreReplace')).toBeHidden();
  await page.locator('#pass1').fill(PASS);
  await page.locator('#pass2').fill(PASS);
  await page.getByRole('button', { name: 'Create wallet' }).click();
  await expect(page.getByText('This wallet · your keys')).toBeVisible();
  await expect(page.locator('#backupStatus')).toContainText('restored from it');
  // A different wallet: warned, and refused until confirmed.
  await page.getByRole('button', { name: 'Lock' }).click();
  await page.locator('#forgotLink').click();
  await page.locator('#restoreWords').fill(VECTOR);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('#restoreReplace')).toBeVisible();
  await expect(page.locator('#s-setpass')).toBeHidden();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('#restoreErr')).toContainText('type REPLACE');
  await expect(page.locator('#s-setpass')).toBeHidden();
  await page.getByLabel('I have the old wallet\'s recovery phrase, or it has no money.').check();
  await page.locator('#replaceText').fill('REPLACE');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('#s-setpass')).toBeVisible();
  await page.locator('#pass1').fill(PASS);
  await page.locator('#pass2').fill(PASS);
  await page.getByRole('button', { name: 'Create wallet' }).click();
  await expect(page.getByText('This wallet · your keys')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__fakeWallet.fingerprint)).toBe(await fingerprintOf(page, VECTOR));
  assertNoLeak(VECTOR);
});

// ---- passkey login (fake passkey: test builds only) ---------------------
// The fake derives VECTOR, as the library derives a 12-word phrase from the
// passkey's PRF output.
async function createPasskeyWallet(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create with a passkey' }).click();
  const phrase = await readWords(page);
  expect(phrase).toBe(VECTOR);
  await expect(page.locator('#backupPasskeyNote')).toBeVisible();
  await page.getByLabel('I wrote the 12 words down on paper.').check();
  await page.locator('#backupNext').click();
  const words = phrase.split(' ');
  for (const input of await page.locator('#confirmFields input').all()) {
    await input.fill(words[Number((await input.getAttribute('id'))!.slice(2))]);
  }
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('This wallet · your keys')).toBeVisible();
  return phrase;
}

test('passkey create: words shown and checked, no passphrase, nothing secret stored', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create with a passkey' }).click();
  const phrase = await readWords(page);
  await page.getByLabel('I wrote the 12 words down on paper.').check();
  await page.locator('#backupNext').click();
  for (const input of await page.locator('#confirmFields input').all()) await input.fill('wrong');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('That does not match.')).toBeVisible();
  const words = phrase.split(' ');
  for (const input of await page.locator('#confirmFields input').all()) {
    await input.fill(words[Number((await input.getAttribute('id'))!.slice(2))]);
  }
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('This wallet · your keys')).toBeVisible();
  await expect(page.locator('#s-setpass')).toBeHidden();
  await expect(page.locator('#backupStatus')).toContainText('you checked your paper copy when you created this wallet');

  const vault = JSON.parse(await page.evaluate(() => localStorage.getItem('cpay-wallet.vault.v1') || 'null'));
  expect(Object.keys(vault).sort()).toEqual(['cred', 'kind', 'label', 'v']);
  expect(vault).toMatchObject({ v: 1, kind: 'passkey', label: 'Default' });
  const stored = await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(localStorage).filter(([k]) => !k.startsWith('cpay-wallet.test.')))));
  for (const w of new Set(words)) expect(stored.includes(`"${w}`) || stored.includes(` ${w} `), w).toBe(false);
  expect(await page.evaluate(() => (window as any).__fakeWallet.fingerprint)).toBe(await fingerprintOf(page, phrase));
  assertNoLeak(phrase);
});

test('passkey unlock asks for this wallet\'s passkey; reveal derives the same words', async ({ page }) => {
  const phrase = await createPasskeyWallet(page);
  await page.getByRole('button', { name: 'Lock' }).click();
  await expect(page.locator('#unlockPkBtn')).toBeVisible();
  await expect(page.locator('#unlockForm')).toBeHidden();
  await expect(page.locator('#forgotNote')).toBeHidden();
  await page.evaluate(() => { (window as any).__fakePasskey.failNext = 'Passkey error: User cancelled authentication'; });
  await page.locator('#unlockPkBtn').click();
  await expect(page.locator('#unlockPkErr')).toContainText('was closed');
  await page.locator('#unlockPkBtn').click();
  await expect(page.getByText('This wallet · your keys')).toBeVisible();
  const calls = await page.evaluate(() => (window as any).__fakePasskey.calls);
  expect(calls.at(-1)).toMatchObject({ op: 'signIn', label: 'Default', pinned: true });
  await page.getByRole('button', { name: 'Show recovery phrase' }).click();
  await expect(page.locator('#revealForm')).toBeHidden();
  await expect(page.locator('#revealWords li')).toHaveCount(12);
  expect((await page.locator('#revealWords li').allTextContents()).join(' ')).toBe(phrase);
  assertNoLeak(phrase);
});

test('passkey sign-in on a phone without the wallet; backup shown as not checked here', async ({ page }) => {
  await createPasskeyWallet(page);
  await page.getByRole('button', { name: 'Remove wallet from this phone' }).click();
  await page.locator('#wipeText').fill('DELETE');
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByText('This wallet · your keys')).toBeVisible();
  await expect(page.locator('#backupStatus')).toContainText('not checked on this phone');
  expect(await page.evaluate(() => (window as any).__fakeWallet.fingerprint)).toBe(await fingerprintOf(page, VECTOR));
});

test('passkey errors: existing passkey, created-but-not-derived, none on device', async ({ page }) => {
  await createPasskeyWallet(page);
  await page.getByRole('button', { name: 'Remove wallet from this phone' }).click();
  await page.locator('#wipeText').fill('DELETE');
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  // The fake passkey still exists on the "device": creating another is refused.
  await page.getByRole('button', { name: 'Create with a passkey' }).click();
  await expect(page.locator('#welcomeErr')).toContainText('already has a CPAY Wallet passkey');
  await page.evaluate(() => { (window as any).__fakePasskey.failNext = 'Passkey created but derivation failed: PRF evaluation failed: x'; });
  await page.getByRole('button', { name: 'Create with a passkey' }).click();
  await expect(page.locator('#welcomeErr')).toContainText('Do not create another one');
  await page.evaluate(() => localStorage.removeItem('cpay-wallet.test.fake-passkey'));
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.locator('#welcomeErr')).toContainText('No CPAY Wallet passkey was found');
  await expect(page.locator('#s-welcome')).toBeVisible();
});

test('no passkey choice where the device cannot do PRF; 12 words still work', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__fakePasskeyPreset = { supported: false }; });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Create a new wallet' })).toBeVisible();
  await expect(page.locator('#passkeyChoice')).toBeHidden();
});

test('lost passkey: the 12 words restore the same wallet with a passphrase, no REPLACE', async ({ page }) => {
  const phrase = await createPasskeyWallet(page);
  await page.getByRole('button', { name: 'Lock' }).click();
  await page.locator('#pkLostLink').click();
  await page.locator('#restoreWords').fill(phrase);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('#restoreReplace')).toBeHidden();
  await expect(page.locator('#s-setpass')).toBeVisible();
  await page.locator('#pass1').fill(PASS);
  await page.locator('#pass2').fill(PASS);
  await page.getByRole('button', { name: 'Create wallet' }).click();
  await expect(page.getByText('This wallet · your keys')).toBeVisible();
  const vault = JSON.parse(await page.evaluate(() => localStorage.getItem('cpay-wallet.vault.v1') || 'null'));
  expect(vault).toMatchObject({ kdf: 'PBKDF2-SHA256' });
  await page.getByRole('button', { name: 'Lock' }).click();
  await expect(page.locator('#unlockForm')).toBeVisible();
  await expect(page.locator('#unlockPasskey')).toBeHidden();
});
