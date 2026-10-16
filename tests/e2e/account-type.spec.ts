import { test, expect } from '@playwright/test';
import { makeUser, login, db, uniq, PASSWORD, expectCleanCopy } from './helpers';

// Account type (CPAY design artifacts): Individual or Business / Organization,
// chosen at sign-up, shown on the desk and to the admin reviewing the
// application. It grants nothing; role and approval are unchanged.

const profileOf = async (email: string) =>
  (await db.query('select role, account_status, account_type, business_name from profiles where email = $1', [email])).rows[0] ?? null;

test('register as a Business / Organization records the type and the name; approval is unchanged', async ({ page }) => {
  const email = `${uniq('biz')}@test.invalid`;
  await page.goto('/register.html');
  await expectCleanCopy(page);
  await expect(page.locator('input[name="accountType"][value="individual"]')).toBeChecked();
  await expect(page.locator('#businessField')).toBeHidden();
  await page.getByLabel(/Business \/ Organization/).check();
  await expect(page.locator('#businessField')).toBeVisible();
  await page.fill('#displayName', 'Rina');
  await page.fill('#email', email);
  await page.fill('#password', PASSWORD);

  // The name is required for a business, before anything is sent.
  await page.click('#submitBtn');
  await expect(page.locator('#errorMsg')).toHaveText(/business or organization name/);
  await expect(page.locator('#businessName')).toBeFocused();
  expect(await profileOf(email)).toBeNull();

  await page.fill('#businessName', 'Rina Crafts Ltd');
  await page.click('#submitBtn');
  await expect.poll(() => profileOf(email), { timeout: 15_000 }).toEqual({
    role: 'creator', account_status: 'pending', account_type: 'business', business_name: 'Rina Crafts Ltd',
  });
});

test('register keeps Individual by default and never sends a business name for it', async ({ page }) => {
  const email = `${uniq('ind')}@test.invalid`;
  await page.goto('/register.html');
  // A name typed, then the choice switched back: it is not sent.
  await page.getByLabel(/Business \/ Organization/).check();
  await page.fill('#businessName', 'Left Behind Co');
  await page.getByLabel(/^Individual/).check();
  await expect(page.locator('#businessField')).toBeHidden();
  await page.fill('#email', email);
  await page.fill('#password', PASSWORD);
  await page.click('#submitBtn');
  await expect.poll(() => profileOf(email), { timeout: 15_000 }).toEqual({
    role: 'creator', account_status: 'pending', account_type: 'individual', business_name: null,
  });
});

test('the desk shows the account type; the admin sees it on the application', async ({ page }) => {
  const u = await makeUser({ name: 'Shop Owner' });
  await db.query(`update profiles set account_type = 'business', business_name = 'Owner Goods' where id = $1`, [u.id]);
  await db.query(`update account_applications set status = 'pending' where user_id = $1`, [u.id]);
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  await expect(page.locator('#deskKind')).toHaveText('Business / Organization account');
  await expect(page.locator('.profile-card')).toContainText('Account type');
  await expect(page.locator('.profile-card')).toContainText('Business / Organization: Owner Goods');
  await page.click('#logoutBtn');
  await page.waitForURL(/login\.html|\/$/);

  const solo = await makeUser({ name: 'Solo Person' });
  await login(page, solo);
  await page.waitForURL(/dashboard\.html/);
  await expect(page.locator('#deskKind')).toHaveText('Individual account');
  await page.click('#logoutBtn');
  await page.waitForURL(/login\.html|\/$/);

  const admin = await makeUser({ name: 'Type Admin', role: 'admin' });
  await login(page, admin);
  await page.waitForURL(/admin\.html/);
  // The application tables (Overview and Applications) carry the column.
  const apps = page.locator('table', { has: page.locator('th', { hasText: 'Account type' }) });
  const row = apps.locator('tr', { hasText: 'Shop Owner' }).first();
  await expect(row).toContainText('Business / Organization: Owner Goods');
  await expect(apps.locator('tr', { hasText: 'Solo Person' }).first()).toContainText('Individual');
});

test('a business name is plain text everywhere it is shown', async ({ page }) => {
  const u = await makeUser({ name: 'Markup Shop' });
  await db.query(`update profiles set account_type = 'business', business_name = '<img src=x onerror=alert(1)>' where id = $1`, [u.id]);
  let dialog = false;
  page.on('dialog', async (d) => { dialog = true; await d.dismiss(); });
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  await expect(page.locator('.profile-card')).toContainText('Business / Organization: <img src=x onerror=alert(1)>');
  expect(await page.locator('.profile-card img').count()).toBe(0);
  expect(dialog).toBe(false);
});
