import { test, expect } from '@playwright/test';

const pages = [
  { path: '/', title: /CPAY/ },
  { path: '/login.html', title: /Log in/ },
  { path: '/register.html', title: /account/i },
  { path: '/store.html', title: /Store|CPAY/ },
];

for (const p of pages) {
  test(`loads ${p.path}`, async ({ page }) => {
    const res = await page.goto(p.path, { waitUntil: 'domcontentloaded' });
    expect(res && res.status()).toBeLessThan(500);
    await expect(page).toHaveTitle(p.title);
    await expect(page.locator('link[href*="cpay.css"]').first()).toHaveCount(1);
    await expect(page.locator('.skip-link')).toHaveCount(1);
    if (p.path === '/' || p.path.includes('login') || p.path.includes('register')) {
      const body = await page.locator('body').innerText();
      expect(body.toLowerCase()).not.toMatch(/breez|bkash|nagad|binance/);
    }
  });
}

test('invoice markup includes timeline and QR download (JS off)', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  const res = await page.goto('/invoice-cpay-v2.html', { waitUntil: 'domcontentloaded' });
  expect(res && res.status()).toBe(200);
  await expect(page.locator('#statusTimeline')).toHaveCount(1);
  await expect(page.locator('#downloadQrBtn')).toHaveCount(1);
  await expect(page.locator('#timerPill')).toHaveCount(1);
  await expect(page.locator('#shareInvoiceBtn')).toHaveCount(1);
  await expect(page.locator('link[href*="a11y.css"]')).toHaveCount(1);
  await context.close();
});

test('payment slug page keeps loading and retry controls (JS off)', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  // Static server serves 404.html only as that filename; CF maps slugs to it in prod.
  await page.goto('/404.html', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#loadRetryBtn')).toHaveCount(1);
  await expect(page.locator('#paymentCard')).toHaveCount(1);
  await expect(page.locator('.skip-link')).toHaveCount(1);
  await context.close();
});

test('login form has 44px touch targets', async ({ page }) => {
  await page.goto('/login.html', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#lampChain')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('main.auth-card')).not.toHaveAttribute('inert', '');
  const chain = await page.locator('#lampChain').boundingBox();
  expect(chain!.height).toBeGreaterThanOrEqual(44);
  expect(chain!.width).toBeGreaterThanOrEqual(44);
  const box = await page.locator('#submitBtn').boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  const email = await page.locator('#email').boundingBox();
  expect(email!.height).toBeGreaterThanOrEqual(44);
});

// Download wallet page (/assets/wallet.html). With no published release it
// must say so and show no link; a link appears only for a published
// release on the wallet's own https hostname.
test('download wallet page: not available until published, no fake link', async ({ page }) => {
  const res = await page.goto('/assets/wallet.html', { waitUntil: 'domcontentloaded' });
  expect(res && res.status()).toBe(200);
  await expect(page).toHaveTitle(/Download wallet/);
  await expect(page.locator('#relOff')).toContainText('Not available yet');
  await expect(page.locator('#relOn')).toBeHidden();
  await expect(page.locator('#curVer')).toHaveText('0.1.0');
  await expect(page.getByRole('heading', { name: 'Security and recovery' })).toBeVisible();
  const hrefs = await page.locator('a[href]:visible').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  expect(hrefs.every((h) => h === '/' || h === '/dashboard.html' || h === '#walletMain')).toBe(true);
  const body = (await page.locator('body').innerText()).toLowerCase();
  expect(body).not.toMatch(/breez|bkash|nagad|binance/);
  expect(body).toContain('separate from your cpay account');
});

const release = (r: Record<string, unknown>) => `window.CPAY_WALLET_RELEASE = Object.freeze(${JSON.stringify({ version: '0.1.0', ...r })});`;

test('download wallet page: a published release links to its own https host', async ({ page }) => {
  await page.route('**/wallet-release.js', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: release({ url: 'https://wallet.example.test/', publishedAt: '2026-10-20', versionJsonSha256: 'ab'.repeat(32) }),
  }));
  await page.goto('/assets/wallet.html');
  await expect(page.locator('#relOff')).toBeHidden();
  await expect(page.locator('#relLink')).toHaveAttribute('href', 'https://wallet.example.test/');
  await expect(page.locator('#relHost')).toHaveText('wallet.example.test');
  await expect(page.locator('#relHash')).toHaveText('ab'.repeat(32));
  await expect(page.locator('#secLink')).toHaveAttribute('href', 'https://wallet.example.test/security.html');
});

for (const [name, r] of Object.entries({
  'http url': { url: 'http://wallet.example.test/', publishedAt: '2026-10-20' },
  'this site\'s own host': { url: 'https://127.0.0.1/', publishedAt: '2026-10-20' },
  'not published yet': { url: 'https://wallet.example.test/', publishedAt: null },
  'javascript: url': { url: 'javascript:alert(1)', publishedAt: '2026-10-20' },
  'credentials in url': { url: 'https://a:b@wallet.example.test/', publishedAt: '2026-10-20' },
})) {
  test(`download wallet page: no link for ${name}`, async ({ page }) => {
    await page.route('**/wallet-release.js', (route) => route.fulfill({ contentType: 'text/javascript', body: release(r) }));
    await page.goto('/assets/wallet.html');
    await expect(page.locator('#relOff')).toBeVisible();
    await expect(page.locator('#relOn')).toBeHidden();
  });
}

// The CPAY Wallet is not published yet: the desk has no Download wallet link.
test('freelancer desk has no Download wallet link and keeps its tabs', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('/dashboard.html', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.side a.navi[href="/assets/wallet.html"]')).toHaveCount(0);
  const tabs = await page.locator('.side .navi[data-tab]').evaluateAll((b) => b.map((x) => x.getAttribute('data-tab')));
  expect(tabs).toEqual(['home', 'links', 'pay', 'cash', 'chat', 'profile', 'security']);
  await context.close();
});

// Pull-chain lamp (public/lamp.js): the form shows only after the chain is
// toggled; it starts open, stays in the DOM (inert while off), and shows without JS.
for (const p of [{ path: '/login.html', card: 'loginCard' }, { path: '/register.html', card: 'registerCard' }]) {
  test(`lamp on ${p.path}: chain is a real toggle button; click, keyboard and drag`, async ({ page }) => {
    await page.goto(p.path, { waitUntil: 'domcontentloaded' });
    const chain = page.locator('#lampChain');
    const card = page.locator('main.auth-card');
    await expect(chain).toHaveAttribute('aria-pressed', 'true');
    await expect(chain).toHaveAttribute('aria-controls', p.card);
    await expect(chain).toHaveAttribute('aria-label', 'Show or hide the form');
    await expect(card).not.toHaveAttribute('inert', '');
    await expect(card).not.toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator(`#${p.card}`)).toHaveCount(1);
    await chain.click();
    await expect(chain).toHaveAttribute('aria-pressed', 'false');
    await expect(card).toHaveAttribute('inert', '');
    await chain.click();
    await expect(chain).toHaveAttribute('aria-pressed', 'true');
    await expect(card).not.toHaveAttribute('inert', '');
    await expect(page.locator('#email')).toBeEditable();
    await chain.focus();
    await page.keyboard.press('Enter');
    await expect(chain).toHaveAttribute('aria-pressed', 'false');
    await expect(card).toHaveAttribute('inert', '');
    await page.keyboard.press('Space');
    await expect(chain).toHaveAttribute('aria-pressed', 'true');
    await chain.click();
    const b = (await chain.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height - 10);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height + 50, { steps: 6 });
    await page.mouse.up();
    await expect(chain).toHaveAttribute('aria-pressed', 'true');
    await expect(card).not.toHaveAttribute('aria-hidden', 'true');
  });

  test(`lamp on ${p.path}: without JavaScript the form shows`, async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(p.path, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#email')).toBeVisible();
    await expect(page.locator('#submitBtn')).toBeVisible();
    await expect(page.locator('#lampChain')).toBeHidden();
    await context.close();
  });

  test(`lamp on ${p.path}: a URL hash or auth result opens the form`, async ({ page }) => {
    await page.goto(`${p.path}#${p.card}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#lampChain')).toHaveAttribute('aria-pressed', 'true');
    await page.goto(`${p.path}?error=access_denied`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('main.auth-card')).not.toHaveAttribute('inert', '');
  });
}

test('lamp with reduced motion: no transition on the card or chain', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/login.html', { waitUntil: 'domcontentloaded' });
  await page.locator('#lampChain').click();
  const t = await page.evaluate(() => ['main.auth-card', '#lampChain'].map((s) => parseFloat(getComputedStyle(document.querySelector(s)!).transitionDuration) || 0));
  expect(Math.max(...t)).toBeLessThanOrEqual(0.01);
});

test('lamp on a phone: lamp above the card, chain at least 44px', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.goto('/login.html', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#lampChain')).toHaveAttribute('aria-pressed', 'true');
  const lamp = (await page.locator('[data-lamp]').boundingBox())!;
  const card = (await page.locator('#loginCard').boundingBox())!;
  expect(lamp.y + lamp.height).toBeLessThanOrEqual(card.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  for (const id of ['#lampChain', '#forgotBtn', '#submitBtn', '#email', '#password']) {
    expect((await page.locator(id).boundingBox())!.height, id).toBeGreaterThanOrEqual(44);
  }
  await context.close();
});
