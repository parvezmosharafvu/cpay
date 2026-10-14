import { test, expect, type Page } from '@playwright/test';
import { makeUser, login, db } from './helpers';
// @ts-ignore -- plain ESM helper shared with the fake Supabase Auth
import { totp, b32encode } from '../../e2e/totp.mjs';
import { randomBytes } from 'node:crypto';

// Two-step sign-in for Freelancers (Security tab on the desk), and the rule
// from 20261014080000: an admin who has an authenticator is an admin only
// in an aal2 session, even while admin_mfa_required is off.

const GENERIC = /That code did not work/;

async function logout(page: Page) {
  await Promise.all([page.waitForURL(/login\.html/), page.click('#logoutBtn')]);
}

async function enrol(page: Page) {
  await page.click('.navi[data-tab="security"]');
  await expect(page.locator('#security')).toContainText('Off. Signing in needs only your password.');
  await expect(page.locator('#security')).toContainText('contact support');
  await page.fill('[data-role="factor-name"]', 'Phone');
  await page.click('[data-role="add-factor"]');
  const secret = (await page.locator('[data-role="totp-secret"]').textContent())!.trim();
  // A wrong code does not turn it on.
  const right = totp(secret);
  await page.fill('[data-role="enrol-code"]', right === '000000' ? '111111' : '000000');
  await page.click('[data-role="enrol-verify"]');
  await expect(page.locator('#security [role="alert"]')).toHaveText(GENERIC);
  await page.fill('[data-role="enrol-code"]', totp(secret));
  await page.click('[data-role="enrol-verify"]');
  await expect(page.locator('#security')).toContainText('On: 1 authenticator');
  await expect(page.locator('[data-role="totp-secret"]')).toHaveCount(0);
  return secret;
}

test('a Freelancer turns on two-step sign-in; the next sign-in needs the code', async ({ page }) => {
  const seen: string[] = [];
  page.on('console', (m) => seen.push(m.text()));
  const u = await makeUser({ name: 'MFA Freelancer' });
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  const secret = await enrol(page);
  expect((await db.query(`select status from auth.mfa_factors where user_id = $1`, [u.id])).rows.map((r) => r.status)).toEqual(['verified']);

  await logout(page);
  await login(page, u);
  await expect(page.locator('#mfaCode')).toBeVisible();
  await page.locator('dialog [data-role="cancel"]').click();
  await expect(page.locator('#errorMsg')).toHaveText(/Sign-in not finished/);
  await login(page, u);
  await page.fill('#mfaCode', totp(secret));
  await page.locator('dialog [data-role="ok"]').click();
  await page.waitForURL(/dashboard\.html/);
  const level = await page.evaluate(async () => (await (window as any).supabaseClient.auth.mfa.getAuthenticatorAssuranceLevel()).data.currentLevel);
  expect(level).toBe('aal2');
  for (const s of seen) expect(s.includes(secret), 'secret in console').toBe(false);
});

test('removing the authenticator needs a current code and turns two-step sign-in off', async ({ page }) => {
  const u = await makeUser({ name: 'MFA Remover' });
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  const secret = await enrol(page);
  await logout(page);
  await login(page, u);
  await page.fill('#mfaCode', totp(secret));
  await page.locator('dialog [data-role="ok"]').click();
  await page.waitForURL(/dashboard\.html/);
  await page.click('.navi[data-tab="security"]');
  page.once('dialog', (d) => d.accept());
  await page.click('#security li button');
  await expect(page.locator('#security')).toContainText('Off. Signing in needs only your password.');
  expect((await db.query(`select count(*)::int n from auth.mfa_factors where user_id = $1`, [u.id])).rows[0].n).toBe(0);
});

test('an admin with an authenticator is not an admin with a password-only token', async ({ page }) => {
  const u = await makeUser({ role: 'admin', name: 'Enrolled Admin' });
  expect((await db.query(`select value from app_settings where key = 'admin_mfa_required'`)).rows[0].value).toBe(false);
  const secret = b32encode(randomBytes(20)); // fresh per run
  await page.goto('/login.html');
  const isAdminWith = (code: string | null) => page.evaluate(async ({ email, password, code }) => {
    const sb = (window as any).supabaseClient;
    await sb.auth.signOut();
    const { error: e1 } = await sb.auth.signInWithPassword({ email, password });
    if (e1) throw new Error(e1.message);
    if (code) {
      const { data: f } = await sb.auth.mfa.listFactors();
      const { error: e2 } = await sb.auth.mfa.challengeAndVerify({ factorId: f.totp[0].id, code });
      if (e2) throw new Error(e2.message);
    }
    const { data, error } = await sb.rpc('is_admin');
    if (error) throw new Error(error.message);
    return data;
  }, { email: u.email, password: u.password, code });

  expect(await isAdminWith(null)).toBe(true); // no authenticator yet: unchanged
  const c = await db.connect();
  try {
    await c.query('begin');
    await c.query('set local session authorization supabase_auth_admin');
    await c.query(`insert into auth.mfa_factors(user_id, friendly_name, factor_type, status, secret) values ($1, 'Phone', 'totp', 'verified', $2)`, [u.id, secret]);
    await c.query('commit');
  } finally { c.release(); }
  expect(await isAdminWith(null)).toBe(false);
  expect(await isAdminWith(totp(secret))).toBe(true);
});
