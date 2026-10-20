import { test, expect } from '@playwright/test';
import { makeUser, makeLink, login, db, simulatePayment, expectCleanCopy } from './helpers';

// 20261020: one-page checkout in the default (express) design, the new
// overview layout, payment details, and coarse locations.

test('the link page shows the invoice in place, on the link address, in the default design', async ({ page }) => {
  const u = await makeUser({ name: 'One Page' });
  const slug = await makeLink(u.id, { name: 'One Page Studio' });
  await page.goto(`/${slug}`);
  await expect(page.locator('#payBtn')).toBeEnabled();
  await expect(page.locator('html')).toHaveAttribute('data-layout', 'keypad');
  await expect(page.locator('body')).toHaveCSS('background-color', /rgb\(0, 214, 50\)|rgb\(10, 10, 10\)/);
  await page.keyboard.type('12');
  await page.click('#payBtn');
  await page.waitForURL((url) => url.pathname === `/${slug}` && Boolean(url.searchParams.get('id')));
  await expect(page.locator('#qrcode')).toBeVisible();
  await expect(page.locator('#amountDue')).toContainText('12.00');
  await expect(page.locator('#paymentCard')).toHaveCount(0);
  await expect(page.locator('#timerPill')).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/invoice/);
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  await expectCleanCopy(page);
  const id = new URL(page.url()).searchParams.get('id')!;

  // A refresh (or the shared invoice address) opens the same invoice.
  await page.reload();
  await expect(page.locator('#qrcode')).toBeVisible();
  await expect(page.locator('#amountDue')).toContainText('12.00');

  // Paid: the success view and receipt on the same page.
  expect(await simulatePayment(id)).toBe('settled');
  await expect(page.locator('#step3')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#rcpRef')).not.toHaveText('');
  expect(new URL(page.url()).pathname).toBe(`/${slug}`);
});

test('older invoice links still open on the invoice page', async ({ page }) => {
  const u = await makeUser({ name: 'Old Link' });
  const slug = await makeLink(u.id);
  await page.goto(`/${slug}`);
  await page.keyboard.type('5');
  await page.click('#payBtn');
  await page.waitForURL(/[?&]id=/);
  const id = new URL(page.url()).searchParams.get('id')!;
  await page.goto(`/invoice-cpay-v2.html?id=${id}`);
  await expect(page.locator('#qrcode')).toBeVisible();
  await expect(page.locator('#amountDue')).toContainText('5.00');
});

test('overview: actions on their own, one summary card without link cost, recent payments open details', async ({ page }) => {
  const u = await makeUser({ name: 'Overview Owner' });
  await db.query('update profiles set platform_fee_percent = 2 where id = $1', [u.id]);
  const slug = await makeLink(u.id, { name: 'Area Link' });
  const { rows: [p] } = await db.query(
    `insert into payments(user_id, payment_link_id, amount_requested, status, expires_at, invoice_ref, customer_country, customer_region, customer_city)
     select $1, id, 25, 'new', now() + interval '15 min', 'loc-e2e', 'BD', 'Dhaka Division', 'Dhaka' from payment_links where slug = $2 returning id`, [u.id, slug]);
  await db.query(`update payments set status = 'settled', amount_settled = 25, settled_at = now() where id = $1`, [p.id]);

  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  const actions = page.locator('#homeActions');
  await expect(actions.getByRole('button', { name: /^Withdraw$/ })).toBeVisible();
  await expect(actions.getByRole('button', { name: /New payment link/ })).toBeVisible();
  const summary = page.locator('#homeSummary');
  await expect(summary).toContainText('Available');
  await expect(summary).toContainText('Platform fee');
  await expect(summary).not.toContainText(/link cost/i);
  await expect(summary.locator('button')).toHaveCount(0);
  // Order: actions, then the summary, then recent payments.
  const y = async (sel: string) => (await page.locator(sel).boundingBox())!.y;
  expect(await y('#homeActions')).toBeLessThan(await y('#homeSummary'));
  expect(await y('#homeSummary')).toBeLessThan(await y('#homeRecent'));

  await page.locator(`#recentPays [data-pay-id="${p.id}"]`).click();
  const d = page.locator('#payDetails');
  await expect(d).toBeVisible();
  await expect(d.locator('#pdReceive')).toHaveText('$24.50');
  await expect(d).toContainText('Platform fee (2%)');
  await expect(d).toContainText('Dhaka, Dhaka Division, Bangladesh');
  await expect(d).not.toContainText('Link area');
  await expect(d).toContainText(`/${slug}`);
  await expect(d).toContainText('settled');
  await d.locator('[data-close]').click();
  await expect(d).toBeHidden();

  // The same details from the Payments tab.
  await page.click('.navi[data-tab="pay"]');
  await page.locator(`#pay tr[data-pay-id="${p.id}"]`).click();
  await expect(page.locator('#payDetails #pdReceive')).toHaveText('$24.50');
});

test('payment details are the owner\'s only', async ({ page }) => {
  const owner = await makeUser({ name: 'Owner' });
  const other = await makeUser({ name: 'Other' });
  const { rows: [p] } = await db.query(
    `insert into payments(user_id, amount_requested, amount_settled, status, settled_at, expires_at, customer_country)
     values ($1, 30, 30, 'settled', now(), now() + interval '1 hour', 'BD') returning id`, [owner.id]);
  await login(page, other);
  await page.waitForURL(/dashboard\.html/);
  const r = await page.evaluate(async (id) => {
    const { data, error } = await (window as any).supabaseClient.rpc('get_my_payment_details', { p_payment_id: id });
    return { data, error: error ? error.message : null };
  }, p.id);
  expect(r.error).toBeNull();
  expect(r.data).toBeNull();
});

test('a user sets an account location; last seen is country only', async ({ page }) => {
  const u = await makeUser({ name: 'Locator' });
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  await page.click('.navi[data-tab="profile"]');
  await page.selectOption('#locCountry', 'BD');
  await page.fill('#locDivision', 'Chattogram');
  await page.fill('#locDistrict', "Cox's Bazar");
  await page.fill('#locArea', 'Kolatoli');
  await page.click('#saveLoc');
  await expect(page.locator('#toast')).toContainText('Location saved');
  const { rows: [l] } = await db.query('select * from profile_locations where user_id = $1', [u.id]);
  expect([l.country, l.division, l.district, l.area]).toEqual(['BD', 'Chattogram', "Cox's Bazar", 'Kolatoli']);
  expect(Object.keys(l).some((k) => /(^|_)ip($|_)/.test(k))).toBe(false);
});
