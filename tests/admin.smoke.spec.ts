import { test, expect } from './fixtures/admin';

test('login then stay on wallet after reload', async ({ adminPage }) => {
  await adminPage.locator('.navi[data-tab="wallet"]').click();
  await expect(adminPage.locator('#wallet')).toBeVisible();
  await adminPage.reload();
  await expect(adminPage.locator('#wallet')).toBeVisible();
  await expect(adminPage.locator('#home')).toBeHidden();
});

test('settings shows live on/off controls', async ({ adminPage }) => {
  await adminPage.locator('.navi[data-tab="settings"]').click();
  await expect(adminPage.locator('#settings')).toBeVisible();
  await expect(adminPage.locator('[data-k="manual_withdrawals_enabled"][data-v="true"]')).toBeVisible();
  await expect(adminPage.locator('[data-k="manual_withdrawals_enabled"][data-v="false"]')).toBeVisible();
  await expect(adminPage.locator('#flags')).toContainText(/Now: (On|Off)/);
});

test('wallet does not show a transport failure', async ({ adminPage }) => {
  await adminPage.locator('.navi[data-tab="wallet"]').click();
  const status = adminPage.locator('#wbUsd');
  await expect(status).not.toHaveText(/Loading/);
  const text = (await status.textContent()) || '';
  expect(text, text).not.toMatch(/Failed to send|Not found|Edge Function/i);
});
