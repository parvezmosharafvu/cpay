import { test, expect } from '@playwright/test';
import { makeUser, makeLink, paymentsFor, db, expectCleanCopy } from './helpers';

test('customer-entered amount creates one invoice through the real Edge Function and payment service', async ({ page }) => {
  const u = await makeUser();
  const slug = await makeLink(u.id, { name: 'Amount Typed' });
  await page.goto(`/${slug}`);
  await page.keyboard.type('12.50');
  await expect(page.locator('#amountDisplay')).toHaveText('$12.50');
  await page.click('#payBtn');
  await page.waitForURL(/invoice-cpay-v2\.html\?id=/);
  await expect(page.locator('#amountDue')).toContainText('12.50');
  await expect(page.locator('#invoiceText')).toHaveText(/^lnbcrt/, { useInnerText: false });
  await expectCleanCopy(page);
  const rows = await paymentsFor(u.id);
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe('new');
  expect(rows[0].amount_requested).toBe('12.50000000');
});

test('a prefilled amount (?amount=) is used as is', async ({ page }) => {
  const u = await makeUser();
  const slug = await makeLink(u.id);
  await page.goto(`/${slug}?amount=25`);
  await expect(page.locator('#amountDisplay')).toHaveText('$25');
  await page.click('#payBtn');
  await page.waitForURL(/invoice-cpay-v2/);
  expect((await paymentsFor(u.id))[0].amount_requested).toBe('25.00000000');
});

test('out-of-range amounts are refused before any request', async ({ page }) => {
  const u = await makeUser();
  const slug = await makeLink(u.id);
  let calls = 0;
  page.on('request', (r) => { if (r.url().includes('create-invoice')) calls++; });
  await page.goto(`/${slug}`);
  await page.keyboard.type('0.5');
  await page.click('#payBtn');
  await expect(page.locator('#statusMsg')).toHaveText(/between \$1 and \$5,000/);
  expect(calls).toBe(0);
  expect(await paymentsFor(u.id)).toHaveLength(0);
});

test('double-clicking pay creates exactly one invoice', async ({ page }) => {
  const u = await makeUser();
  const slug = await makeLink(u.id);
  await page.goto(`/${slug}`);
  await page.keyboard.type('7');
  await page.locator('#payBtn').dblclick();
  await page.keyboard.press('Enter');
  await page.waitForURL(/invoice-cpay-v2/);
  expect(await paymentsFor(u.id)).toHaveLength(1);
});

test('a link cost is shown to the payer before paying and charged on the invoice', async ({ page }) => {
  const u = await makeUser();
  const slug = await makeLink(u.id);
  await db.query(`update payment_links set cost_percent = 10 where slug = $1`, [slug]);
  await page.goto(`/${slug}`);
  await page.keyboard.type('20');
  await expect(page.locator('#chargeSummary')).toHaveText(/You pay \$22\.00 · includes 10% service fee/);
  await page.click('#payBtn');
  await page.waitForURL(/invoice-cpay-v2/);
  await expect(page.locator('#amountDue')).toContainText('22.00');
});

test('payments paused by the operator are refused with a plain message and no invoice', async ({ page }) => {
  const u = await makeUser();
  const slug = await makeLink(u.id);
  await db.query(`insert into app_settings(key, value) values ('emergency_payments_stop', 'true'::jsonb)
                  on conflict (key) do update set value = excluded.value`);
  try {
    await page.goto(`/${slug}`);
    await page.keyboard.type('9');
    await page.click('#payBtn');
    await expect(page.locator('#statusMsg')).toHaveText(/paused|unavailable/i);
    expect(await paymentsFor(u.id)).toHaveLength(0);
  } finally {
    await db.query(`update app_settings set value = 'false'::jsonb where key = 'emergency_payments_stop'`);
  }
});
