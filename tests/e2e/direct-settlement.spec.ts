import { test, expect, type Page } from '@playwright/test';
import { makeUser, makeLink, login, db, ORIGIN, expectCleanCopy, type User } from './helpers';

// Direct settlement (20261018010000): payers pay the Freelancer's own wallet
// through the fake merchant provider in e2e/fake-lnurl.mjs. Nothing here
// touches the platform wallet or a CPAY balance.

const hook = (path: string, body?: unknown) =>
  fetch(`${ORIGIN}/__e2e/${path}`, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const balance = async (userId: string) =>
  (await db.query('select to_jsonb(b)::text as b from get_balance_for($1) b', [userId])).rows[0].b as string;

async function desk(page: Page, u: User, tab: string) {
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  await page.click(`.navi[data-tab="${tab}"]`);
}

async function payerOpens(page: Page, slug: string, amount: string) {
  const payer = await (await page.context().browser()!.newContext()).newPage();
  await payer.goto(`/${slug}`);
  await expect(payer.locator('#payBtn')).toBeEnabled();
  await payer.keyboard.type(amount);
  await payer.click('#payBtn');
  await payer.waitForURL(/invoice-cpay-v2\.html\?id=.*settlement=direct/);
  await expect(payer.locator('#step2')).toBeVisible();
  return { payer, id: new URL(payer.url()).searchParams.get('id')! };
}

test.describe.serial('direct payments to the Freelancer\'s own wallet', () => {
  let u: User;
  let slug: string;

  test.afterAll(async () => { await hook('direct-switch?on=0'); });

  test('switched off (the default): no direct controls, and direct-invoice refuses', async ({ page }) => {
    await hook('direct-switch?on=0');
    u = await makeUser({ name: 'Direct Owner' });
    slug = await makeLink(u.id, { name: 'Direct Owner' });
    await desk(page, u, 'profile');
    await expect(page.locator('#profile .card').first()).toBeVisible();
    await expect(page.locator('#directCard')).toBeHidden();
    await page.click('.navi[data-tab="links"]');
    await expect(page.locator('#links table')).not.toContainText('Payments go to');
    const r = await fetch(`${ORIGIN}/functions/v1/direct-invoice`, { method: 'POST', body: JSON.stringify({ slug, amount: 10 }) });
    expect(r.status).toBe(503);
    expect((await r.json()).error).toBe('Direct payments are not available.');
  });

  test('a Lightning address is checked with its provider, saved after a fresh sign-in, and used 24 hours later without an authenticator', async ({ page }) => {
    await hook('direct-switch?on=1');
    await desk(page, u, 'profile');
    await expect(page.locator('#directCard')).toBeVisible();
    await expect(page.locator('#directCard')).toContainText('CPAY never holds it');
    // A provider that cannot confirm payments is refused.
    await page.fill('#directAddr', 'bob@noverify.example.com');
    await page.click('#directCheck');
    await expect(page.locator('#directResult')).toContainText('does not confirm payments');
    await expect(page.locator('#directSave')).toBeDisabled();
    await page.fill('#directAddr', 'Alice@Pay.Example.com');
    await page.click('#directCheck');
    await expect(page.locator('#directResult')).toContainText('alice@pay.example.com works and confirms payments');
    await page.click('#directSave');
    // 20261020060000: no authenticator on this account, so it waits 24 hours
    // (a stolen password alone cannot redirect payments at once), and the
    // user is told when it starts.
    await expect(page.locator('#directStatus')).toContainText('waiting');
    const { rows: [d] } = await db.query(`select address, ready_at > now() + interval '23 hours' as waits from settlement_destinations where user_id = $1 and status = 'active'`, [u.id]);
    expect(d).toEqual({ address: 'alice@pay.example.com', waits: true });
    expect((await db.query(`select count(*)::int as n from support_messages where user_id = $1 and security_notice and message like 'Security notice: your Lightning payout address%24 hours%'`, [u.id])).rows[0].n).toBe(1);
    // Pass the wait (test DB only) for the tests below.
    const c = await db.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      await c.query(`update settlement_destinations set ready_at = now() - interval '1 minute' where user_id = $1`, [u.id]);
      await c.query('commit');
    } finally { c.release(); }
    await page.reload();
    await page.click('.navi[data-tab="profile"]');
    await expect(page.locator('#directStatus')).toContainText('in use');
  });

  test('opened from CPAY Wallet: the address is filled in through the login page, nothing is saved until Check and Save', async ({ page }) => {
    const before = (await db.query('select count(*)::int as n from settlement_destinations where user_id = $1', [u.id])).rows[0].n;
    // Signed out: the login page comes first; the address survives it.
    await page.goto('/dashboard.html#direct=carol.shop%40pay.example.com');
    await page.waitForURL(/login\.html/);
    await page.fill('#email', u.email);
    await page.fill('#password', u.password);
    await page.click('#submitBtn');
    await page.waitForURL(/dashboard\.html/);
    await expect(page.locator('#profile')).toBeVisible();
    await expect(page.locator('#directAddr')).toHaveValue('carol.shop@pay.example.com');
    await expect(page.locator('#directResult')).toContainText('Filled in from your CPAY Wallet');
    await expect(page.locator('#directSave')).toBeDisabled();
    expect(new URL(page.url()).hash).toBe('');
    expect((await db.query('select count(*)::int as n from settlement_destinations where user_id = $1', [u.id])).rows[0].n).toBe(before);
    // Used once: a reload does not fill it again.
    await page.reload();
    await page.click('.navi[data-tab="profile"]');
    await expect(page.locator('#directCard')).toBeVisible();
    await expect(page.locator('#directAddr')).toHaveValue('');
    // Anything that is not a plain Lightning address is ignored.
    await page.goto('/dashboard.html#direct=%3Cimg%20src%3Dx%3E%40pay.example.com');
    await page.click('.navi[data-tab="profile"]');
    await expect(page.locator('#directCard')).toBeVisible();
    await expect(page.locator('#directAddr')).toHaveValue('');
  });

  test('a direct link: the payer pays the merchant\'s wallet, proof marks it paid, the CPAY balance does not move', async ({ page }) => {
    await hook('direct-ready', { userId: u.id });
    const before = await balance(u.id);
    await desk(page, u, 'links');
    page.on('dialog', (d) => d.accept());
    await page.click('[data-settle-link][data-mode="direct"]');
    await expect(page.locator('#links table')).toContainText('Your wallet');
    expect((await db.query('select settlement_mode from payment_links where slug = $1', [slug])).rows[0].settlement_mode).toBe('direct');

    const { payer, id } = await payerOpens(page, slug, '10');
    await expect(payer.locator('#directNote')).toContainText("Goes straight to Direct Owner's own wallet (alice@pay.example.com)");
    await expect(payer.locator('#statusChip')).toHaveText(/Waiting/);
    const { rows: [row] } = await db.query('select status, bolt11, amount_msat::text, amount_usd::text from direct_payments where id = $1', [id]);
    expect(row).toMatchObject({ status: 'pending', amount_msat: '10000000', amount_usd: '10.00' }); // $10 at $100k
    expect(row.bolt11).toMatch(/^lnbcrt100000n1/);
    await expectCleanCopy(payer);

    expect((await (await hook('direct-pay', { paymentId: id })).json()).paid).toBe(true);
    await expect(payer.locator('#step3')).toBeVisible({ timeout: 15_000 });
    await expect(payer.locator('#successTitle')).toHaveText('Payment received');
    await expect(payer.locator('#rcpProofRow')).toBeVisible();
    await expect(payer.locator('#rcpDirectNote')).toContainText('CPAY did not hold this payment');
    const { rows: [paid] } = await db.query(
      `select status, encode(sha256(decode(preimage, 'hex')), 'hex') = payment_hash as proven from direct_payments where id = $1`, [id]);
    expect(paid).toEqual({ status: 'paid', proven: true });
    // Never a custodial row, never a balance change.
    expect((await db.query('select count(*)::int as n from payments p join payment_links l on l.id = p.payment_link_id where l.slug = $1', [slug])).rows[0].n).toBe(0);
    expect(await balance(u.id)).toBe(before);
    // The desk loaded before the payment; like the CPAY history, it shows
    // new rows after a reload.
    await page.reload();
    await page.click('.navi[data-tab="pay"]');
    await expect(page.locator('#directPays')).toContainText('Direct payments');
    await expect(page.locator('#directPays table')).toContainText('$10.00');
    await expect(page.locator('#directPays table')).toContainText('paid');
  });

  test('a provider that says "paid" without a valid proof is not believed', async ({ page }) => {
    const { payer, id } = await payerOpens(page, slug, '12');
    await hook('direct-pay', { paymentId: id, forge: true });
    await payer.waitForTimeout(7_000); // two status polls past the check interval
    await expect(payer.locator('#step3')).toBeHidden();
    await expect(payer.locator('#statusChip')).toHaveText(/Waiting/);
    expect((await db.query('select status from direct_payments where id = $1', [id])).rows[0].status).toBe('pending');
  });

  test('the platform-wallet endpoint refuses a direct link; without an address the link says so up front', async ({ page }) => {
    const r = await fetch(`${ORIGIN}/functions/v1/create-invoice`, { method: 'POST', body: JSON.stringify({ slug, amount: 10 }) });
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe('direct_link');
    await desk(page, u, 'profile');
    page.on('dialog', (d) => d.accept());
    await page.click('#directRemove');
    await expect(page.locator('#directStatus')).toContainText('No Lightning address yet');
    expect((await db.query('select settlement_mode from payment_links where slug = $1', [slug])).rows[0].settlement_mode).toBe('direct');
    const payer = await (await page.context().browser()!.newContext()).newPage();
    await payer.goto(`/${slug}`);
    await expect(payer.locator('#notTakingCard')).toBeVisible();
    await expect(payer.locator('#paymentCard')).toBeHidden();
  });

  test('another Freelancer sees none of it', async () => {
    const other = await makeUser({ name: 'Other Freelancer' });
    const tok = await (await fetch(`${ORIGIN}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: other.email, password: other.password }),
    })).json();
    const anon = (await (await fetch(`${ORIGIN}/__e2e/anon-key`)).json()).anonKey;
    for (const table of ['direct_payments', 'settlement_destinations']) {
      const rows = await (await fetch(`${ORIGIN}/rest/v1/${table}?select=*`, { headers: { apikey: anon, authorization: `Bearer ${tok.access_token}` } })).json();
      expect(rows).toEqual([]);
    }
  });
});
