import { test, expect, type Page } from '@playwright/test';
import { makeUser, login, readyAddress, db, TRON, type User } from './helpers';
// @ts-ignore -- plain ESM helper shared with the fake Supabase Auth
import { totp } from '../../e2e/totp.mjs';

// Two-step sign-in (TOTP): enrol from Admin → Security, finish sign-in with
// a code, cancel without looping, and keep payouts working when an
// authenticator is enrolled (the step-up asks for password, then the code).
// Secrets and codes must never reach the console or CPAY's own APIs.

const GENERIC = /That code did not work/;

async function watchLeaks(page: Page) {
  const seen: string[] = [];
  page.on('console', (m) => seen.push(m.text()));
  page.on('request', (r) => {
    const u = r.url();
    if (/\/(rest|functions)\/v1\//.test(u)) seen.push(`${u} ${r.postData() || ''}`);
  });
  return seen;
}

async function enrolFromSecurity(page: Page, name = 'Phone') {
  await page.click('.navi[data-tab="security"]');
  await page.fill('[data-role="factor-name"]', name);
  await page.click('[data-role="add-factor"]');
  const secret = (await page.locator('[data-role="totp-secret"]').textContent())!.trim();
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  await page.fill('[data-role="enrol-code"]', totp(secret));
  await page.click('[data-role="enrol-verify"]');
  await expect(page.locator('#security')).toContainText('On: 1 authenticator');
  await expect(page.locator('[data-role="totp-secret"]')).toHaveCount(0);
  return secret;
}

// Log out and wait for its own redirect, so the next goto does not race it.
async function logout(page: Page) {
  await Promise.all([page.waitForURL(/login\.html/), page.click('#logoutBtn')]);
}

const aal = (page: Page) => page.evaluate(async () => (await (window as any).supabaseClient.auth.mfa.getAuthenticatorAssuranceLevel()).data);

test('admin enrols an authenticator; next sign-in needs the code; a wrong code is refused generically', async ({ page }) => {
  const seen = await watchLeaks(page);
  const u = await makeUser({ role: 'admin', name: 'MFA Admin' });
  await login(page, u);
  await page.waitForURL(/admin\.html/);
  const secret = await enrolFromSecurity(page);

  const { rows: f } = await db.query(`select status from auth.mfa_factors where user_id = $1`, [u.id]);
  expect(f.map((r) => r.status)).toEqual(['verified']);
  const { rows: a } = await db.query(`select action, audit_log::text t from audit_log where subject_id = $1 and action like 'security.mfa.%' order by id`, [u.id]);
  expect(a.map((r) => r.action)).toEqual(['security.mfa.factor_enrolled', 'security.mfa.factor_verified']);
  expect(a.some((r) => r.t.includes(secret))).toBe(false);

  await logout(page);
  await login(page, u);
  await expect(page.locator('#mfaCode')).toBeVisible();
  const right = totp(secret);
  await page.fill('#mfaCode', right === '000000' ? '111111' : '000000');
  await page.locator('dialog [data-role="ok"]').click();
  await expect(page.locator('dialog [data-role="err"]')).toHaveText(GENERIC);
  await expect(page).toHaveURL(/login\.html/);
  await expect.poll(async () => (await db.query(`select count(*)::int n from audit_log where actor_id = $1 and action = 'security.mfa.challenge_failed'`, [u.id])).rows[0].n).toBe(1);

  await page.fill('#mfaCode', totp(secret));
  await page.locator('dialog [data-role="ok"]').click();
  await page.waitForURL(/admin\.html/);
  expect((await aal(page)).currentLevel).toBe('aal2');

  for (const s of seen) expect(s.includes(secret), `secret leaked: ${s.slice(0, 120)}`).toBe(false);
});

test('cancelling the code at sign-in signs out and does not prompt again on reload', async ({ page }) => {
  const u = await makeUser({ role: 'admin', name: 'MFA Cancel' });
  await login(page, u);
  await page.waitForURL(/admin\.html/);
  await enrolFromSecurity(page);
  await logout(page);

  await login(page, u);
  await expect(page.locator('#mfaCode')).toBeVisible();
  await page.locator('dialog [data-role="cancel"]').click();
  await expect(page.locator('#errorMsg')).toHaveText(/Sign-in not finished/);
  await page.reload();
  await expect(page.locator('#submitBtn')).toBeVisible();
  await expect(page.locator('#mfaCode')).toHaveCount(0);
  expect(await page.evaluate(async () => (await (window as any).supabaseClient.auth.getSession()).data.session)).toBeNull();
});

test('removing the only authenticator needs the current code and turns two-step sign-in off', async ({ page }) => {
  const u = await makeUser({ role: 'admin', name: 'MFA Remove' });
  await login(page, u);
  await page.waitForURL(/admin\.html/);
  const secret = await enrolFromSecurity(page);
  // Back to an aal1 session (password only): removal must ask for the code.
  await page.evaluate(async (c) => { await (window as any).supabaseClient.auth.signInWithPassword(c); }, { email: u.email, password: u.password });
  page.once('dialog', (d) => d.accept());
  await page.click('[data-factor]');
  await expect(page.locator('#mfaCode')).toBeVisible();
  await page.fill('#mfaCode', totp(secret));
  await page.locator('dialog [data-role="ok"]').click();
  await expect(page.locator('#security')).toContainText('Off.');
  expect((await db.query(`select count(*)::int n from auth.mfa_factors where user_id = $1`, [u.id])).rows[0].n).toBe(0);
  expect((await db.query(`select count(*)::int n from audit_log where subject_id = $1 and action = 'security.mfa.factor_removed_by_operator'`, [u.id])).rows[0].n).toBe(0);
});

test('with two authenticators, the backup device\'s code signs in', async ({ page }) => {
  const u = await makeUser({ role: 'admin', name: 'MFA Two' });
  await login(page, u);
  await page.waitForURL(/admin\.html/);
  await enrolFromSecurity(page, 'Phone');
  // The session is aal2 now, so adding a second authenticator needs no prompt.
  await page.fill('[data-role="factor-name"]', 'Backup');
  await page.click('[data-role="add-factor"]');
  const backup = (await page.locator('[data-role="totp-secret"]').textContent())!.trim();
  await page.fill('[data-role="enrol-code"]', totp(backup));
  await page.click('[data-role="enrol-verify"]');
  await expect(page.locator('#security')).toContainText('On: 2 authenticators');

  await logout(page);
  await login(page, u);
  await expect(page.locator('#mfaFactor')).toBeVisible();
  await page.selectOption('#mfaFactor', { label: 'Backup' });
  await page.fill('#mfaCode', totp(backup));
  await page.locator('dialog [data-role="ok"]').click();
  await page.waitForURL(/admin\.html/);
  expect((await aal(page)).currentLevel).toBe('aal2');
});

async function enrolViaApi(page: Page, u: User) {
  return page.evaluate(async () => {
    const sb = (window as any).supabaseClient;
    const { data } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Phone', issuer: 'CPAY' });
    return { id: data.id as string, secret: data.totp.secret as string };
  });
}

test('with an authenticator enrolled, a payout from an aal1 session asks for password then code, and is sent once', async ({ page }) => {
  const u = await makeUser({ name: 'MFA Payout', earned: 50 });
  await readyAddress(u.id);
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  const f = await enrolViaApi(page, u);
  await page.evaluate(async ({ id, code }) => { await (window as any).supabaseClient.auth.mfa.challengeAndVerify({ factorId: id, code }); }, { id: f.id, code: totp(f.secret) });
  // Drop to a password-only (aal1) session, as after a plain re-sign-in.
  await page.evaluate(async (c) => { await (window as any).supabaseClient.auth.signInWithPassword(c); }, { email: u.email, password: u.password });
  expect((await aal(page)).currentLevel).toBe('aal1');

  await page.click('.navi[data-tab="cash"]');
  await expect(page.locator('#wNet option', { hasText: 'Tron' })).toHaveCount(1);
  const tron = await page.locator('#wNet option', { hasText: 'Tron' }).getAttribute('value');
  await page.selectOption('#wNet', tron!);
  await page.fill('#wDest', TRON);
  await page.fill('#wAmt', '10');
  await page.click('#wBtn');
  await expect(page.locator('#wBtn')).toHaveText(/Confirm and send/);
  await page.click('#wBtn');
  await expect(page.locator('#reauthPw')).toBeVisible();
  await page.fill('#reauthPw', u.password);
  await page.click('#reauthOk');
  await expect(page.locator('#mfaCode')).toBeVisible();
  await page.fill('#mfaCode', totp(f.secret));
  await page.locator('dialog [data-role="ok"]').click();
  await expect(page.locator('#toast')).toHaveText(/Sent/);
  const { rows } = await db.query('select status from withdrawals where user_id = $1', [u.id]);
  expect(rows).toHaveLength(1);
  expect((await aal(page)).currentLevel).toBe('aal2');
});

test('an aal1 session cannot confirm a payout for an account with an authenticator', async ({ page }) => {
  const u = await makeUser({ name: 'MFA Refuse', earned: 50 });
  await readyAddress(u.id);
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  const f = await enrolViaApi(page, u);
  await page.evaluate(async ({ id, code }) => { await (window as any).supabaseClient.auth.mfa.challengeAndVerify({ factorId: id, code }); }, { id: f.id, code: totp(f.secret) });
  await page.evaluate(async (c) => { await (window as any).supabaseClient.auth.signInWithPassword(c); }, { email: u.email, password: u.password });

  await page.click('.navi[data-tab="cash"]');
  await expect(page.locator('#wNet option', { hasText: 'Tron' })).toHaveCount(1);
  const tron = await page.locator('#wNet option', { hasText: 'Tron' }).getAttribute('value');
  await page.selectOption('#wNet', tron!);
  await page.fill('#wDest', TRON);
  await page.fill('#wAmt', '10');
  await page.click('#wBtn');
  await expect(page.locator('#wBtn')).toHaveText(/Confirm and send/);
  await page.click('#wBtn');
  await page.fill('#reauthPw', u.password);
  await page.click('#reauthOk');
  await page.locator('dialog [data-role="cancel"]').click();
  await expect(page.locator('#toast')).toBeVisible();
  expect((await db.query('select count(*)::int n from withdrawals where user_id = $1', [u.id])).rows[0].n).toBe(0);
});

test('with admin two-step sign-in required, admin data needs aal2 even through direct RPC', async ({ page }) => {
  const u = await makeUser({ role: 'admin', name: 'MFA Enforced' });
  await login(page, u);
  await page.waitForURL(/admin\.html/);
  await enrolFromSecurity(page);
  // Set directly: other suites' admins have no authenticator, so the
  // Settings toggle would (rightly) refuse in this shared database.
  await db.query(`update app_settings set value = 'true'::jsonb where key = 'admin_mfa_required'`);
  try {
    const rpc = () => page.evaluate(async () => {
      const { error } = await (window as any).supabaseClient.rpc('admin_wallet_health');
      return error ? error.message : 'ok';
    });
    expect((await aal(page)).currentLevel).toBe('aal2');
    expect(await rpc()).toBe('ok');
    // The last authenticator cannot be removed while it is required.
    await page.click('.navi[data-tab="security"]');
    await expect(page.locator('#security')).toContainText('Required for every admin');
    await expect(page.locator('[data-factor]')).toBeDisabled();
    await page.evaluate(async (c) => { await (window as any).supabaseClient.auth.signInWithPassword(c); }, { email: u.email, password: u.password });
    expect((await aal(page)).currentLevel).toBe('aal1');
    expect(await rpc()).not.toBe('ok');
  } finally {
    await db.query(`update app_settings set value = 'false'::jsonb where key = 'admin_mfa_required'`);
  }
});

test('a freelancer without an authenticator signs in as before (no code prompt)', async ({ page }) => {
  const u = await makeUser({ name: 'No MFA' });
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  await expect(page.locator('#mfaCode')).toHaveCount(0);
  expect((await aal(page)).nextLevel).toBe('aal1');
});
