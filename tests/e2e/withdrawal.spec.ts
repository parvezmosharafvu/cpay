import { test, expect, type Page } from '@playwright/test';
import { makeUser, login, readyAddress, db, TRON } from './helpers';

async function openWithdraw(page: Page, earned = 50, fee = 0, ready = true) {
  const u = await makeUser({ name: 'Payout', earned, fee });
  if (ready) await readyAddress(u.id);
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  await page.click('.navi[data-tab="cash"]');
  await expect(page.locator('#wNet option', { hasText: 'Tron' })).toHaveCount(1);
  const tron = await page.locator('#wNet option', { hasText: 'Tron' }).getAttribute('value');
  await page.selectOption('#wNet', tron!);
  await page.fill('#wDest', TRON);
  return u;
}
const available = async (id: string) => (await db.query('select available::text a from get_balance_for($1)', [id])).rows[0].a;

test('quote shows platform fee, network fee, masked destination and a countdown, then confirm sends once', async ({ page }) => {
  const u = await openWithdraw(page, 50, 2);
  await page.fill('#wAmt', '20');
  await page.click('#wBtn');
  await expect(page.locator('#sumFee')).toHaveText('-$0.40');
  await expect(page.locator('#sumNet')).toHaveText(/^-\$\d/);
  await expect(page.locator('#sumTo')).toHaveText(`${TRON.slice(0, 8)}...${TRON.slice(-6)}`);
  await expect(page.locator('#sumNote')).toHaveText(/Quote valid for \d+:\d\d/);
  await expect(page.locator('#wBtn')).toHaveText(/Confirm and send .* USDT/);
  await page.locator('#wBtn').dblclick();
  await expect(page.locator('#toast')).toHaveText(/Sent/);
  const { rows } = await db.query('select status, amount_requested::text from withdrawals where user_id = $1', [u.id]);
  expect(rows).toHaveLength(1);
  expect(rows[0].amount_requested).toBe('20.00000000');
  expect(await available(u.id)).toBe('30.00000000');
  await expect(page.locator('#wHist table')).toContainText(/paid|sending/i);
});

test('an address saved less than 24 h ago gets no quote', async ({ page }) => {
  const u = await openWithdraw(page, 50, 0, false);
  await db.query(`insert into usdt_wallets(user_id, network, address) values ($1, 'tron', $2)`, [u.id, TRON]);
  await page.fill('#wDest', TRON);
  await page.fill('#wAmt', '10');
  await page.click('#wBtn');
  await expect(page.locator('#toast')).toBeVisible();
  await expect(page.locator('#wBtn')).toHaveText('Get quote');
  expect((await db.query('select count(*)::int n from withdrawals where user_id = $1', [u.id])).rows[0].n).toBe(0);
});

test('more than the balance, or under $5, is refused and nothing is reserved', async ({ page }) => {
  const u = await openWithdraw(page, 12);
  await page.fill('#wAmt', '4');
  await page.click('#wBtn');
  await expect(page.locator('#toast')).toHaveText(/Minimum withdrawal is \$5/);
  await page.fill('#wAmt', '13');
  await page.click('#wBtn');
  await expect(page.locator('#toast')).toBeVisible();
  await expect(page.locator('#wBtn')).toHaveText('Get quote');
  expect(await available(u.id)).toBe('12.00000000');
});

test('an expired quote is never sent: confirm asks for a fresh one', async ({ page }) => {
  const u = await openWithdraw(page, 50);
  await page.fill('#wAmt', '10');
  await page.click('#wBtn');
  await expect(page.locator('#wBtn')).toHaveText(/Confirm and send/);
  // Jump the page clock past the quote expiry.
  await page.clock.install();
  await page.clock.fastForward('20:00');
  await expect(page.locator('#sumNote')).toHaveText(/expired/);
  await expect(page.locator('#wBtn')).toHaveText('Get new quote');
  expect((await db.query('select count(*)::int n from withdrawals where user_id = $1', [u.id])).rows[0].n).toBe(0);
});

test('changing the amount after a quote discards the quote', async ({ page }) => {
  await openWithdraw(page, 50);
  await page.fill('#wAmt', '10');
  await page.click('#wBtn');
  await expect(page.locator('#wBtn')).toHaveText(/Confirm and send/);
  await page.fill('#wAmt', '11');
  await expect(page.locator('#wBtn')).toHaveText('Get quote');
});

test('the network picker follows the saved address: preferred network first, and switching swaps the address', async ({ page }) => {
  const u = await makeUser({ name: 'Two Nets', earned: 50 });
  const EVM = '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063';
  await readyAddress(u.id, 'tron', TRON);
  await readyAddress(u.id, 'ethereum', EVM);
  await db.query(`update profiles set preferred_usdt_network = 'tron' where id = $1`, [u.id]);
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  await page.click('.navi[data-tab="cash"]');
  await expect(page.locator('#wNet option:checked')).toHaveText(/Tron/);
  await expect(page.locator('#wDest')).toHaveValue(TRON);
  const bsc = await page.locator('#wNet option', { hasText: 'BNB' }).getAttribute('value');
  await page.selectOption('#wNet', bsc!);
  await expect(page.locator('#wDest')).toHaveValue('');
  const tron = await page.locator('#wNet option', { hasText: 'Tron' }).getAttribute('value');
  await page.selectOption('#wNet', tron!);
  await expect(page.locator('#wDest')).toHaveValue(TRON);
  await page.fill('#wAmt', '10');
  await page.click('#wBtn');
  await expect(page.locator('#wBtn')).toHaveText(/Confirm and send/);
});

test('networks: a failing routes call is retried with backoff; after the retries a Retry button loads them', async ({ page }) => {
  const u = await makeUser({ name: 'Routes Retry', earned: 50 });
  await readyAddress(u.id);
  let failLeft = 2;
  let failAll = false;
  await page.route('**/functions/v1/user-withdraw', async (route) => {
    const body = route.request().postDataJSON?.() ?? {};
    if (route.request().method() === 'POST' && body.action === 'routes' && (failAll || failLeft > 0)) {
      failLeft--;
      return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'Could not load networks' }) });
    }
    return route.continue();
  });
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  await page.click('.navi[data-tab="cash"]');
  // two failures, then success on the third try: no error shown
  await expect(page.locator('#wNet option', { hasText: 'Tron' })).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator('#wNetRetry')).toHaveCount(0);

  // every try fails: only then the error and a Retry button
  failAll = true;
  await page.reload();
  await page.click('.navi[data-tab="cash"]');
  await expect(page.locator('#wNet option')).toHaveText('Networks did not load', { timeout: 15_000 });
  await expect(page.locator('#wNetRetry')).toBeVisible();
  failAll = false; failLeft = 0;
  await page.click('#wNetRetry');
  await expect(page.locator('#wNet option', { hasText: 'Tron' })).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator('#wNetRetry')).toBeHidden();
});
