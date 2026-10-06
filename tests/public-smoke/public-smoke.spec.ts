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
  const box = await page.locator('#submitBtn').boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  const email = await page.locator('#email').boundingBox();
  expect(email!.height).toBeGreaterThanOrEqual(44);
});
