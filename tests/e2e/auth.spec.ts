import { test, expect } from '@playwright/test';
import { makeUser, login, db, uniq, ORIGIN, PASSWORD, expectCleanCopy } from './helpers';

test('register creates a pending Freelancer application', async ({ page }) => {
  const email = `${uniq('reg')}@test.invalid`;
  await page.goto('/register.html');
  await expectCleanCopy(page);
  await page.fill('#displayName', 'New Person');
  await page.fill('#email', email);
  await page.fill('#password', PASSWORD);
  await page.click('#submitBtn');
  // The URL can already match before sign-up finishes; wait for the row.
  await expect.poll(async () => (await db.query('select role, account_status from profiles where email = $1', [email])).rows[0] ?? null,
    { timeout: 15_000 }).toEqual({ role: 'creator', account_status: 'pending' });
});

test('register rejects a short password before calling the server', async ({ page }) => {
  await page.goto('/register.html');
  await page.fill('#email', `${uniq('reg')}@test.invalid`);
  await page.fill('#password', 'short');
  await page.click('#submitBtn');
  await expect(page.locator('#errorMsg')).toHaveText(/at least 8/);
});

test('an active Freelancer logs in to the desk and logs out', async ({ page }) => {
  const u = await makeUser({ name: 'Rina' });
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  await expect(page.locator('#hello')).toHaveText('Rina');
  await page.click('#logoutBtn');
  await page.waitForURL(/login\.html|\/$/);
  await page.goto('/dashboard.html');
  await page.waitForURL(/login\.html/);
});

test('wrong password and pending account are refused with a clear message', async ({ page }) => {
  const u = await makeUser();
  await login(page, { ...u, password: 'not-the-password' });
  await expect(page.locator('#errorMsg')).toHaveText(/Invalid login credentials/);
  const pending = await makeUser({ status: 'pending' });
  await login(page, pending);
  await expect(page.locator('#errorMsg')).toHaveText(/Waiting for admin approval/);
  expect(page.url()).toContain('login.html');
});

test('password recovery: request a link, set a new password, log in with it', async ({ page, browser }) => {
  const u = await makeUser({ name: 'Recover Me' });
  await page.goto('/login.html');
  await page.fill('#email', u.email);
  await page.click('#forgotBtn');
  await expect(page.locator('#okMsg')).toHaveText(/Check your email/);
  const mail = await (await fetch(`${ORIGIN}/__e2e/mailbox?to=${encodeURIComponent(u.email)}`)).json();
  expect(mail).toHaveLength(1);
  await page.goto(mail[0].link);
  await page.fill('#password', 'brand-new-pass-1');
  await page.fill('#password2', 'brand-new-pass-1');
  await page.click('#saveBtn');
  await page.waitForURL(/login\.html|dashboard\.html/);
  // A fresh browser: the old password fails, the new one works.
  const fresh = await (await browser.newContext()).newPage();
  await login(fresh, u);
  await expect(fresh.locator('#errorMsg')).toHaveText(/Invalid login credentials/);
  await login(fresh, { ...u, password: 'brand-new-pass-1' });
  await fresh.waitForURL(/dashboard\.html/);
});
