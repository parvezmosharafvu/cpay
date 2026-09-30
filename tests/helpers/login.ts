import { expect, type Page } from '@playwright/test';

export function credentials() {
  const email = process.env.CPAY_ADMIN_EMAIL || '';
  const password = process.env.CPAY_ADMIN_PASSWORD || '';
  return { email, password, ready: Boolean(email && password) };
}

export async function loginAsAdmin(page: Page) {
  const { email, password } = credentials();
  await page.goto('/login.html');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.locator('#submitBtn').click();
  await page.waitForURL(/admin\.html/);
  await expect(page.locator('.navi[data-tab="wallet"]')).toBeVisible();
}
