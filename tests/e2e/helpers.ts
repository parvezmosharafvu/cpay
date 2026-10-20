import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT || 54321);
// ORIGIN is the API (Auth, REST, functions, test hooks); SITE serves the
// pages. Different origins, like supabase.co and pay-cashapp.buzz.
export const ORIGIN = `http://127.0.0.1:${PORT}`;
export const SITE = `http://localhost:${PORT}`;
export const db = new pg.Pool({
  host: process.env.PGHOST || 'localhost', user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres', database: process.env.E2E_DB || 'cpay_e2e', max: 3,
});
export const TRON = 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL';
export const PASSWORD = 'correct-horse-9';
export const uniq = (p = 'u') => `${p}-${randomUUID().slice(0, 8)}`;

export type User = { id: string; email: string; password: string };

/** Sign up through the real auth endpoint, then set status/role in the test DB. */
export async function makeUser({ status = 'active', role = 'creator', name = 'Test Freelancer', earned = 0, fee = 0 } = {}): Promise<User> {
  const email = `${uniq('e2e')}@test.invalid`;
  const r = await fetch(`${ORIGIN}/auth/v1/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, data: { display_name: name } }),
  });
  if (!r.ok) throw new Error(`signup failed ${r.status}`);
  const { rows: [u] } = await db.query(
    `update profiles set account_status = $2, role = $3, display_name = $4, withdrawal_fee_percent = $5, platform_fee_percent = 0
     where email = $1 returning id`, [email, status, role, name, fee]);
  if (earned) {
    await db.query(`insert into payments(user_id, amount_requested, amount_settled, status, settled_at, expires_at)
                    values ($1, $2, $2, 'settled', now(), now() + interval '1 hour')`, [u.id, earned]);
  }
  return { id: u.id, email, password: PASSWORD };
}

export async function makeLink(userId: string, { slug = uniq('pay'), name = 'Studio Work', active = true } = {}) {
  await db.query(`insert into payment_links(user_id, slug, display_name, is_active) values ($1, $2, $3, $4)`, [userId, slug, name, active]);
  return slug;
}

/** A saved payout address, ready to use (test DB only). */
export async function readyAddress(userId: string, network = 'tron', address = TRON) {
  await db.query(`insert into usdt_wallets(user_id, network, address) values ($1, $2, $3)
                  on conflict (user_id, network) do update set address = excluded.address`, [userId, network, address]);
  const c = await db.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query(`update usdt_wallets set usable_after = now() - interval '1 minute' where user_id = $1`, [userId]);
    await c.query('commit');
  } finally { c.release(); }
}

export async function login(page: Page, u: User) {
  await page.goto('/login.html');
  await page.fill('#email', u.email);
  await page.fill('#password', u.password);
  await page.click('#submitBtn');
}

/** Simulated incoming payment, delivered to the real payment service via the fake SDK. */
export async function simulatePayment(paymentId: string, amountSat?: number) {
  const r = await fetch(`${ORIGIN}/__e2e/pay`, { method: 'POST', body: JSON.stringify({ paymentId, amountSat }) });
  return (await r.json()).status as string;
}

export async function paymentsFor(userId: string) {
  return (await db.query(`select id, status, amount_requested::text, amount_settled::text from payments where user_id = $1 order by created_at`, [userId])).rows;
}

/** No page may name the payment rails we do not offer or the wallet provider. */
export async function expectCleanCopy(page: Page) {
  const text = (await page.locator('body').innerText()).toLowerCase();
  expect(text).not.toMatch(/breez|bkash|nagad|binance|bank transfer/);
}

/** Passkeys on in the stand-in Auth, plus Chromium's virtual authenticator. */
export async function withPasskeys(page: Page) {
  await fetch(`${ORIGIN}/__e2e/passkey?on=1`, { method: 'POST' });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { cdp, id: authenticatorId };
}

/** Admin sign-in since 20261021020000: password, then the passkey (added on first sign-in). */
export async function loginAdmin(page: Page, u: User) {
  await withPasskeys(page);
  await login(page, u);
  await page.locator('dialog [data-role="ok"]').click();
  await page.waitForURL(/admin\.html/);
}
