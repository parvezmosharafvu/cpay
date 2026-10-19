import { test, expect } from '@playwright/test';
import { makeUser, makeLink, paymentsFor } from './helpers';

// #72 follow-up: while the resume check holds the pay button, the keypad and
// keyboard must still take the amount; only paying waits for the check.
test('an amount typed while the resume check runs is kept, and a different amount makes a new invoice', async ({ page }) => {
  const u = await makeUser({ name: 'Resume Keypad' });
  const slug = await makeLink(u.id, { name: 'Resume Keypad' });
  await page.goto(`/${slug}`);
  await expect(page.locator('#paymentCard')).toBeVisible();
  await expect(page.locator('#payBtn')).toBeEnabled();
  await page.keyboard.type('11');
  await page.click('#payBtn');
  await page.waitForURL(/[?&]id=/);
  const id = new URL(page.url()).searchParams.get('id')!;

  // Back on the link, hold the resume lookup and type during the hold.
  await page.route('**/rest/v1/rpc/get_invoice_public', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.goto(`/${slug}`);
  await expect(page.locator('#paymentCard')).toBeVisible();
  await expect(page.locator('#payBtn')).toBeDisabled();
  await page.keyboard.type('12');
  await expect(page.locator('#amountDisplay')).toHaveText('$12');
  await expect(page.locator('#payBtn')).toBeEnabled({ timeout: 15_000 });
  await expect(page.locator('#resumeBox')).toBeVisible();
  await page.unroute('**/rest/v1/rpc/get_invoice_public');
  await page.click('#payBtn');
  await page.waitForURL((url) => url.searchParams.get('id') !== id && /[?&]id=/.test(url.href));
  expect(await paymentsFor(u.id)).toHaveLength(2);
});
