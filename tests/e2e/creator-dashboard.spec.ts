import { test, expect } from '@playwright/test';
import { makeUser, makeLink, login, db, simulatePayment } from './helpers';

test('the desk shows the real balance, and a settled payment appears in Payments', async ({ page }) => {
  const u = await makeUser({ name: 'Desk Owner', earned: 40 });
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  await expect(page.locator('#home')).toContainText('$40.00');
  await page.click('.navi[data-tab="pay"]');
  await expect(page.locator('#pay table')).toContainText('$40.00');
});

test('create a payment link from the desk; payers can open it', async ({ page }) => {
  const u = await makeUser({ name: 'Maker' });
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  await page.click('.navi[data-tab="links"]');
  await page.fill('#linkName', 'Garden Design');
  await page.click('#makeLink');
  await expect(page.locator('#links table')).toContainText('Garden Design');
  const { rows: [l] } = await db.query('select slug, is_active from payment_links where user_id = $1', [u.id]);
  expect(l.is_active).toBe(true);
  const payer = await (await page.context().browser()!.newContext()).newPage();
  await payer.goto(`/${l.slug}`);
  await expect(payer.locator('#merchantName')).toHaveText('Garden Design');
});

test('turning a link off makes it not found for payers', async ({ page }) => {
  const u = await makeUser();
  const slug = await makeLink(u.id, { name: 'Switch Me' });
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  await page.click('.navi[data-tab="links"]');
  await page.click(`[data-toggle-link]`);
  await expect(page.locator('#links table')).toContainText('Turn on');
  const payer = await (await page.context().browser()!.newContext()).newPage();
  await payer.goto(`/${slug}`);
  await expect(payer.locator('#notFoundCard')).toBeVisible();
});

test('a payment made on my link raises my available balance after reload', async ({ page, browser }) => {
  const u = await makeUser({ name: 'Earner' });
  const slug = await makeLink(u.id);
  const payer = await (await browser.newContext()).newPage();
  await payer.goto(`/${slug}`);
  await payer.keyboard.type('20');
  await payer.click('#payBtn');
  await payer.waitForURL(/invoice-cpay-v2/);
  expect(await simulatePayment(new URL(payer.url()).searchParams.get('id')!)).toBe('settled');
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  await expect(page.locator('#home')).toContainText('$20.00');
});

test('the desk survives a refresh on every tab', async ({ page }) => {
  const u = await makeUser({ name: 'Refresher', earned: 5 });
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  for (const tab of ['links', 'pay', 'cash', 'profile', 'home']) {
    await page.click(`.navi[data-tab="${tab}"]`);
    await page.reload();
    await expect(page.locator(`#${tab}`)).toBeVisible();
    await expect(page.locator(`#${tab} .skeleton, #${tab} [aria-busy="true"]`)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator(`#${tab}`)).not.toBeEmpty();
  }
});
