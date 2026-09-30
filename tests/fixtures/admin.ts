import { test as base, expect, type Page } from '@playwright/test';

type AdminFixtures = {
  adminPage: Page;
};

export const test = base.extend<AdminFixtures>({
  adminPage: async ({ page }, use) => {
    const email = process.env.CPAY_ADMIN_EMAIL || '';
    const password = process.env.CPAY_ADMIN_PASSWORD || '';
    if (!email || !password) {
      test.skip(true, 'Set CPAY_ADMIN_EMAIL and CPAY_ADMIN_PASSWORD');
    }
    await page.goto('/login.html');
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(password);
    await page.locator('#submitBtn').click();
    await page.waitForURL(/admin\.html/);
    await expect(page.locator('.navi[data-tab="wallet"]')).toBeVisible();
    await use(page);
  },
});

export { expect };
