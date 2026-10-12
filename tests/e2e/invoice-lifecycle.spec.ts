import { test, expect, type Page } from '@playwright/test';
import { makeUser, makeLink, paymentsFor, simulatePayment, db } from './helpers';

async function startInvoice(page: Page, amount = '10') {
  const u = await makeUser({ name: 'Life Cycle' });
  const slug = await makeLink(u.id, { name: 'Life Cycle' });
  await page.goto(`/${slug}`);
  await expect(page.locator('#payBtn')).toBeEnabled();
  await page.keyboard.type(amount);
  await page.click('#payBtn');
  await page.waitForURL(/invoice-cpay-v2\.html\?id=/);
  await expect(page.locator('#step2')).toBeVisible();
  const id = new URL(page.url()).searchParams.get('id')!;
  return { u, slug, id };
}

test('waiting → paid: a simulated incoming payment settles once and the page shows the receipt', async ({ page }) => {
  const { u, id } = await startInvoice(page, '10');
  await expect(page.locator('#statusChip')).toHaveText(/Waiting/);
  expect(await simulatePayment(id)).toBe('settled');
  await expect(page.locator('#step3')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#successTitle')).toHaveText('Payment received');
  await expect(page.locator('#successAmount')).toHaveText('$10.00');
  // Replaying the same event credits nothing more.
  await simulatePayment(id);
  const rows = await paymentsFor(u.id);
  expect(rows.map((r) => r.status)).toEqual(['settled']);
  expect(rows[0].amount_settled).toBe('10.00000000');
});

test('refresh resumes the same invoice and creates no new one', async ({ page }) => {
  const { u, id } = await startInvoice(page, '15');
  const before = await page.locator('#invoiceText').textContent();
  await page.reload();
  await expect(page.locator('#step2')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('id')).toBe(id);
  expect(await page.locator('#invoiceText').textContent()).toBe(before);
  // Opened on a second device (no session cache) it still resolves.
  const other = await (await page.context().browser()!.newContext()).newPage();
  await other.goto(page.url());
  await expect(other.locator('#step2')).toBeVisible();
  await expect(other.locator('#amountDue')).toContainText('15.00');
  expect(await paymentsFor(u.id)).toHaveLength(1);
});

test('an underpayment does not settle the invoice', async ({ page }) => {
  const { u, id } = await startInvoice(page, '10');
  const { rows: [p] } = await db.query('select amount_sat from payments where id = $1', [id]);
  expect(await simulatePayment(id, Number(p.amount_sat) - 1)).toBe('pending');
  await expect(page.locator('#step3')).toBeHidden();
  expect((await paymentsFor(u.id))[0].status).not.toBe('settled');
});

test('expiry: the page says expired, and "Generate new payment" makes a fresh invoice', async ({ page }) => {
  const { u, id } = await startInvoice(page, '13');
  await db.query(`update payments set expires_at = now() - interval '1 second', status = 'expired' where id = $1`, [id]);
  await page.reload();
  await expect(page.locator('#stateTitle')).toHaveText('This payment request expired');
  await page.click('#stateBtn');
  await page.waitForURL((url) => url.searchParams.get('id') !== id && /invoice-cpay-v2|\/pay-/.test(url.href));
  if (!/invoice-cpay-v2/.test(page.url())) { await page.click('#payBtn'); await page.waitForURL(/invoice-cpay-v2/); }
  await expect(page.locator('#step2')).toBeVisible();
  const rows = await paymentsFor(u.id);
  expect(rows).toHaveLength(2);
  expect(rows.filter((r) => r.status === 'new')).toHaveLength(1);
});

test('an unknown invoice id says the payment is gone instead of spinning', async ({ page }) => {
  await page.goto('/invoice-cpay-v2.html?id=00000000-0000-4000-8000-000000000000');
  await expect(page.locator('#stateTitle')).toHaveText(/no longer available/);
  await expect(page.locator('#stateBtn')).toHaveText('Start over');
});

test('going back to the link offers the open payment, and the same amount reopens it instead of a second invoice', async ({ page }) => {
  const { u, slug, id } = await startInvoice(page, '11');
  await page.goto(`/${slug}`);
  await expect(page.locator('#resumeBox')).toBeVisible();
  await expect(page.locator('#resumeText')).toHaveText(/open payment of \$11\.00/);
  // Keys typed while the resume check holds the page are not handled yet.
  await expect(page.locator('#payBtn')).toBeEnabled();
  await page.keyboard.type('11');
  await page.click('#payBtn');
  await page.waitForURL(/invoice-cpay-v2/);
  expect(new URL(page.url()).searchParams.get('id')).toBe(id);
  expect(await paymentsFor(u.id)).toHaveLength(1);
  // A different amount is a new, deliberate payment.
  await page.goto(`/${slug}`);
  await expect(page.locator('#payBtn')).toBeEnabled();
  await expect(page.locator('#resumeBox')).toBeVisible();
  await expect(page.locator('#payBtn')).toBeEnabled();
  await page.keyboard.type('12');
  await page.click('#payBtn');
  await page.waitForURL((url) => url.searchParams.get('id') !== id && /invoice-cpay-v2/.test(url.href));
  expect(await paymentsFor(u.id)).toHaveLength(2);
});

test('no resume offer once the open payment is paid', async ({ page }) => {
  const { slug, id } = await startInvoice(page, '6');
  expect(await simulatePayment(id)).toBe('settled');
  await expect(page.locator('#step3')).toBeVisible({ timeout: 15_000 });
  await page.goto(`/${slug}`);
  await expect(page.locator('#paymentCard')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.locator('#resumeBox')).toBeHidden();
});

test('pay stays disabled until the resume check finishes, then same-amount reopen still works', async ({ page }) => {
  const { u, slug, id } = await startInvoice(page, '9');
  // Hold the resume RPC so a fast tap cannot race ahead of findOpenInvoice.
  await page.route('**/rest/v1/rpc/get_invoice_public', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  const nav = page.goto(`/${slug}`);
  await page.waitForSelector('#payBtn');
  await expect(page.locator('#payBtn')).toBeDisabled();
  await nav;
  await expect(page.locator('#payBtn')).toBeEnabled({ timeout: 15_000 });
  await expect(page.locator('#resumeBox')).toBeVisible();
  await page.unroute('**/rest/v1/rpc/get_invoice_public');
  await expect(page.locator('#payBtn')).toBeEnabled();
  await page.keyboard.type('9');
  await page.click('#payBtn');
  await page.waitForURL(/invoice-cpay-v2/);
  expect(new URL(page.url()).searchParams.get('id')).toBe(id);
  expect(await paymentsFor(u.id)).toHaveLength(1);
});

test('a reused slug does not resume another link open invoice', async ({ page }) => {
  const { u, slug, id } = await startInvoice(page, '8');
  // Soft-delete mangles the old slug (…--deleted-…) and frees the original.
  await db.query(
    `update payment_links set deleted_at = now(), slug = left(slug, 32) || '--deleted-' || substr(md5(id::text), 1, 8) where slug = $1`,
    [slug],
  );
  const other = await makeUser({ name: 'New Owner' });
  await makeLink(other.id, { slug, name: 'New Studio' });
  await page.goto(`/${slug}`);
  await expect(page.locator('#paymentCard')).toBeVisible();
  await expect(page.locator('#payBtn')).toBeEnabled({ timeout: 15_000 });
  await expect(page.locator('#resumeBox')).toBeHidden();
  await expect(page.locator('#payBtn')).toBeEnabled();
  await page.keyboard.type('8');
  await page.click('#payBtn');
  await page.waitForURL(/invoice-cpay-v2/);
  const newId = new URL(page.url()).searchParams.get('id');
  expect(newId).not.toBe(id);
  expect(await paymentsFor(other.id)).toHaveLength(1);
  expect(await paymentsFor(u.id)).toHaveLength(1);
});
