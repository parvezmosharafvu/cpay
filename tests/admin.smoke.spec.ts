import { test, expect } from '@playwright/test';
import { credentials, loginAsAdmin } from './helpers/login';

test.beforeEach(({}, testInfo) => {
  if (!credentials().ready) {
    testInfo.skip(true, 'Set CPAY_ADMIN_EMAIL and CPAY_ADMIN_PASSWORD');
  }
});

test('login then stay on wallet after reload', async ({ page }) => {
  await loginAsAdmin(page);
  await page.locator('.navi[data-tab="wallet"]').click();
  await expect(page.locator('#wallet')).toBeVisible();
  await page.reload();
  await expect(page.locator('#wallet')).toBeVisible();
  await expect(page.locator('#home')).toBeHidden();
});

test('settings shows live on/off controls', async ({ page }) => {
  await loginAsAdmin(page);
  await page.locator('.navi[data-tab="settings"]').click();
  await expect(page.locator('#settings')).toBeVisible();
  await expect(page.locator('[data-k="manual_withdrawals_enabled"][data-v="true"]')).toBeVisible();
  await expect(page.locator('[data-k="manual_withdrawals_enabled"][data-v="false"]')).toBeVisible();
  await expect(page.locator('#flags')).toContainText(/Now: (On|Off)/);
});

test('wallet does not show a transport failure', async ({ page }) => {
  await loginAsAdmin(page);
  await page.locator('.navi[data-tab="wallet"]').click();
  const status = page.locator('#wbUsd');
  await expect(status).not.toHaveText(/Loading/);
  const text = (await status.textContent()) || '';
  expect(text, text).not.toMatch(/Failed to send|Not found|Edge Function/i);
});
