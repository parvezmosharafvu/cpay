import { test, expect, type Page } from './fixtures';
import { makeUser, login, loginAdmin, withPasskeys, readyAddress, db, ORIGIN, TRON, type User, openAuthForm } from './helpers';
// @ts-ignore -- plain ESM helper shared with the fake Supabase Auth
import { totp } from '../../e2e/totp.mjs';

// 20261021020000: a passkey is the only second step. Admins sign in with a
// passkey (a new admin adds the first one at sign-in); an account with an
// old authenticator is asked for its passkey, never a code; a password-only
// session is refused where two-step sign-in was required.

test.afterEach(async () => { await fetch(`${ORIGIN}/__e2e/passkey?on=0`, { method: 'POST' }); });

const amr = (page: Page) => page.evaluate(async () => {
  const { data: { session } } = await (window as any).supabaseClient.auth.getSession();
  const c = JSON.parse(atob(session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  return { aal: c.aal as string, amr: (c.amr || []).map((m: { method: string }) => m.method) as string[] };
});

async function logout(page: Page) {
  await Promise.all([page.waitForURL(/login\.html/), page.click('#logoutBtn')]);
  await openAuthForm(page);
}

test('a new admin adds a passkey at the first sign-in, then reaches the admin desk with it', async ({ page }) => {
  const u = await makeUser({ role: 'admin', name: 'Passkey Admin' });
  await withPasskeys(page);
  await login(page, u);
  await expect(page.locator('#pkTitle')).toHaveText('Confirm with your passkey');
  await expect(page.locator('dialog [data-role="ok"]')).toHaveText('Add a passkey and continue');
  await expect(page.locator('#mfaCode')).toHaveCount(0);
  await page.locator('dialog [data-role="ok"]').click();
  await page.waitForURL(/admin\.html/);
  expect((await amr(page)).amr).toContain('passkey');
  // Next time the passkey already exists: password, then "Use my passkey".
  await logout(page);
  await login(page, u);
  await expect(page.locator('dialog [data-role="ok"]')).toHaveText('Use my passkey');
  await page.locator('dialog [data-role="ok"]').click();
  await page.waitForURL(/admin\.html/);
  // The admin's only passkey cannot be removed.
  await page.click('.navi[data-tab="security"]');
  await expect(page.locator('[data-role="passkeys"] [data-passkey]')).toBeDisabled();
  await expect(page.locator('#security')).not.toContainText('Turn on two-step sign-in');
});

test('an admin who cancels the passkey is signed out and not prompted again on reload', async ({ page }) => {
  const u = await makeUser({ role: 'admin', name: 'Cancel Admin' });
  await withPasskeys(page);
  await login(page, u);
  await page.locator('dialog [data-role="cancel"]').click();
  await expect(page.locator('#errorMsg')).toHaveText(/Sign-in not finished/);
  expect(await page.evaluate(async () => (await (window as any).supabaseClient.auth.getSession()).data.session)).toBeNull();
  await page.reload();
  await expect(page.locator('#pkTitle')).toHaveCount(0);
  await page.goto('/admin.html');
  await page.waitForURL(/login\.html/);
});

test('with admin two-step sign-in required, admin data needs a passkey session even through direct RPC', async ({ page }) => {
  const u = await makeUser({ role: 'admin', name: 'Enforced Admin' });
  await loginAdmin(page, u);
  await db.query(`update app_settings set value = 'true'::jsonb where key = 'admin_mfa_required'`);
  try {
    const rpc = () => page.evaluate(async () => {
      const { error } = await (window as any).supabaseClient.rpc('admin_wallet_health');
      return error ? error.message : 'ok';
    });
    expect(await rpc()).toBe('ok');
    await page.evaluate(async (c) => { await (window as any).supabaseClient.auth.signInWithPassword(c); }, { email: u.email, password: u.password });
    expect((await amr(page)).amr).not.toContain('passkey');
    expect(await rpc()).not.toBe('ok');
  } finally {
    await db.query(`update app_settings set value = 'false'::jsonb where key = 'admin_mfa_required'`);
  }
});

test('an account with an old authenticator signs in with its passkey; no code is ever asked', async ({ page }) => {
  await withPasskeys(page);
  const u = await makeUser({ name: 'Old Factor' });
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  const f = await page.evaluate(async () => {
    const sb = (window as any).supabaseClient;
    const { data } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Phone', issuer: 'CPAY' });
    return { id: data.id as string, secret: data.totp.secret as string };
  });
  await page.evaluate(async ({ id, code }) => { await (window as any).supabaseClient.auth.mfa.challengeAndVerify({ factorId: id, code }); }, { id: f.id, code: totp(f.secret) });
  await page.click('.navi[data-tab="security"]');
  await page.click('[data-role="add-passkey"]');
  await expect(page.locator('#toast')).toHaveText(/Passkey added/);
  await expect(page.locator('[data-role="old-authenticators"]')).toContainText('no longer used');
  await logout(page);

  // Password only: the passkey is asked, not the code.
  await login(page, u);
  await expect(page.locator('#pkTitle')).toBeVisible();
  await expect(page.locator('#mfaCode')).toHaveCount(0);
  await page.locator('dialog [data-role="ok"]').click();
  await page.waitForURL(/dashboard\.html/);
  expect((await amr(page)).amr).toContain('passkey');
  await logout(page);

  // Passkey sign-in goes straight to the desk.
  await page.click('#passkeyBtn');
  await page.waitForURL(/dashboard\.html/);
  await expect(page.locator('#pkTitle')).toHaveCount(0);
});

test('a payout for an account with an old authenticator needs the passkey; the password alone is not enough', async ({ page }) => {
  await withPasskeys(page);
  const u: User = await makeUser({ name: 'Passkey Payout Only', earned: 50 });
  await readyAddress(u.id);
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  const f = await page.evaluate(async () => {
    const sb = (window as any).supabaseClient;
    const { data } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Phone', issuer: 'CPAY' });
    return { id: data.id as string, secret: data.totp.secret as string };
  });
  await page.evaluate(async ({ id, code }) => { await (window as any).supabaseClient.auth.mfa.challengeAndVerify({ factorId: id, code }); }, { id: f.id, code: totp(f.secret) });
  await page.click('.navi[data-tab="security"]');
  await page.click('[data-role="add-passkey"]');
  await expect(page.locator('#toast')).toHaveText(/Passkey added/);
  // A password-only session, as with a stolen password.
  await page.evaluate(async (c) => { await (window as any).supabaseClient.auth.signInWithPassword(c); }, { email: u.email, password: u.password });

  await page.click('.navi[data-tab="cash"]');
  const tron = await page.locator('#wNet option', { hasText: 'Tron' }).getAttribute('value');
  await page.selectOption('#wNet', tron!);
  await page.fill('#wDest', TRON);
  await page.fill('#wAmt', '10');
  await page.click('#wBtn');
  await expect(page.locator('#wBtn')).toHaveText(/Confirm and send/);
  await page.click('#wBtn');
  // The password is not enough: the passkey is asked next.
  await page.fill('#reauthPw', u.password);
  await page.click('#reauthOk');
  await expect(page.locator('#pkTitle')).toBeVisible();
  await expect(page.locator('#mfaCode')).toHaveCount(0);
  await page.locator('dialog [data-role="ok"]').click();
  await expect(page.locator('#toast')).toHaveText(/Sent/);
  expect((await db.query('select count(*)::int n from withdrawals where user_id = $1', [u.id])).rows[0].n).toBe(1);
});

test('a Freelancer without a passkey or old authenticator signs in as before', async ({ page }) => {
  const u = await makeUser({ name: 'Plain Freelancer' });
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  await expect(page.locator('#pkTitle')).toHaveCount(0);
  await expect(page.locator('#mfaCode')).toHaveCount(0);
});

test('log in and register show no Google button', async ({ page }) => {
  for (const p of ['/login.html', '/register.html']) {
    await page.goto(p);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#googleBtn')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('Google');
  }
});
