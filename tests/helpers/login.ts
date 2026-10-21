/** @deprecated Use tests/fixtures/admin.ts (`adminPage`) instead. */
import { expect, type Page } from '@playwright/test';

export function credentials() {
  const email = process.env.CPAY_ADMIN_EMAIL || '';
  const password = process.env.CPAY_ADMIN_PASSWORD || '';
  return { email, password, ready: Boolean(email && password) };
}

export async function loginAsAdmin(page: Page) {
  const { email, password } = credentials();
  await page.goto('/login.html');
  await openAuthForm(page);
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.locator('#submitBtn').click();
  await page.waitForURL(/admin\.html/);
  await expect(page.locator('.navi[data-tab="wallet"]')).toBeVisible();
}

/** Log-in and register show the form only after the lamp chain is pulled
 *  (public/lamp.js). Pull it unless the page already opened the form. */
export async function openAuthForm(page: Page) {
  const chain = page.locator('#lampChain');
  if (!(await chain.count())) return;
  if ((await chain.getAttribute('aria-pressed')) !== 'true') await chain.click();
  await expect(chain).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('main.auth-card')).not.toHaveAttribute('inert', '');
}
