import { test, expect, type Page, type CDPSession } from '@playwright/test';
import { makeUser, login, db, ORIGIN, TRON, readyAddress, type User } from './helpers';
// @ts-ignore -- plain ESM helper shared with the fake Supabase Auth
import { totp } from '../../e2e/totp.mjs';

// Passkeys (Supabase Auth, WebAuthn) with Chromium's virtual authenticator:
// the browser runs the real ceremony and the stand-in Auth checks the real
// signature. /__e2e/passkey plays "Authentication → Passkeys: on".

const toggle = (on: boolean) => fetch(`${ORIGIN}/__e2e/passkey?on=${on ? 1 : 0}`, { method: 'POST' });
test.beforeEach(async () => { await toggle(true); });
test.afterEach(async () => { await toggle(false); });

async function authenticator(page: Page): Promise<{ cdp: CDPSession; id: string }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { cdp, id: authenticatorId };
}

async function logout(page: Page) {
  await Promise.all([page.waitForURL(/login\.html/), page.click('#logoutBtn')]);
}

async function addPasskey(page: Page) {
  await page.click('.navi[data-tab="security"]');
  const card = page.locator('[data-role="passkeys"]');
  await expect(card).toContainText('No passkey yet.');
  await page.click('[data-role="add-passkey"]');
  await expect(page.locator('#toast')).toHaveText(/Passkey added/);
  await expect(card.locator('.passkey-list li')).toHaveCount(1);
}

const amrMethods = (page: Page) => page.evaluate(async () => {
  const { data: { session } } = await (window as any).supabaseClient.auth.getSession();
  const claims = JSON.parse(atob(session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  return { aal: claims.aal, amr: (claims.amr || []).map((m: { method: string }) => m.method) };
});

test('passkey buttons stay hidden while passkeys are off', async ({ page }) => {
  await toggle(false);
  await page.goto('/login.html');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#passkeyBtn')).toBeHidden();
  await expect(page.locator('[data-alt]')).toBeHidden();
  const u = await makeUser({ name: 'No Passkeys' });
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  await page.click('.navi[data-tab="security"]');
  await expect(page.locator('#security')).toContainText('Two-step sign-in');
  await expect(page.locator('[data-role="passkeys"]')).toHaveCount(0);
});

test('add a passkey in Security, then sign in with it: no password, amr "passkey"', async ({ page }) => {
  await authenticator(page);
  const u = await makeUser({ name: 'Passkey Freelancer' });
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  await addPasskey(page);
  await logout(page);

  await expect(page.locator('#passkeyBtn')).toBeVisible();
  await expect(page.locator('#passkeyBtn')).toHaveText('Sign in with a passkey');
  await page.click('#passkeyBtn');
  await page.waitForURL(/dashboard\.html/);
  await expect(page.locator('#hello')).toHaveText('Passkey Freelancer');
  expect(await amrMethods(page)).toEqual({ aal: 'aal1', amr: ['passkey'] });
});

test('a passkey does not skip two-step sign-in: the authenticator code is still asked', async ({ page }) => {
  await authenticator(page);
  const u = await makeUser({ name: 'Passkey And Code' });
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  const f = await page.evaluate(async () => {
    const sb = (window as any).supabaseClient;
    const { data } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Google Authenticator', issuer: 'CPAY' });
    return { id: data.id as string, secret: data.totp.secret as string };
  });
  await page.evaluate(async ({ id, code }) => { await (window as any).supabaseClient.auth.mfa.challengeAndVerify({ factorId: id, code }); }, { id: f.id, code: totp(f.secret) });
  await addPasskey(page);
  await logout(page);

  await page.click('#passkeyBtn');
  await expect(page.locator('#mfaCode')).toBeVisible();
  await page.locator('dialog [data-role="cancel"]').click();
  await expect(page.locator('#errorMsg')).toHaveText(/Sign-in not finished/);
  expect(await page.evaluate(async () => (await (window as any).supabaseClient.auth.getSession()).data.session)).toBeNull();

  await page.click('#passkeyBtn');
  await page.fill('#mfaCode', totp(f.secret));
  await page.locator('dialog [data-role="ok"]').click();
  await page.waitForURL(/dashboard\.html/);
  const { aal, amr } = await amrMethods(page);
  expect(aal).toBe('aal2');
  expect(amr).toEqual(['totp', 'passkey']);
});

test('adding a passkey with two-step sign-in on asks for the code first', async ({ page }) => {
  await authenticator(page);
  const u = await makeUser({ name: 'Gate Passkey' });
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  await page.click('.navi[data-tab="security"]');
  await expect(page.locator('[data-role="passkeys"]')).toContainText('No passkey yet.');
  const f = await page.evaluate(async () => {
    const sb = (window as any).supabaseClient;
    const { data } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Google Authenticator', issuer: 'CPAY' });
    return { id: data.id as string, secret: data.totp.secret as string };
  });
  await page.evaluate(async ({ id, code }) => { await (window as any).supabaseClient.auth.mfa.challengeAndVerify({ factorId: id, code }); }, { id: f.id, code: totp(f.secret) });
  // A password-only (aal1) session, as with a stolen password. The Security
  // card on screen was drawn before the authenticator existed: the code is
  // still asked, because the rule is checked when the button is pressed.
  await page.evaluate(async (c) => { await (window as any).supabaseClient.auth.signInWithPassword(c); }, { email: u.email, password: u.password });
  await page.click('[data-role="add-passkey"]');
  await expect(page.locator('#mfaCode')).toBeVisible();
  await page.locator('dialog [data-role="cancel"]').click();
  await expect(page.locator('[data-role="passkeys"]')).toContainText('No passkey yet.');
  await page.click('[data-role="add-passkey"]');
  await page.fill('#mfaCode', totp(f.secret));
  await page.locator('dialog [data-role="ok"]').click();
  await expect(page.locator('#toast')).toHaveText(/Passkey added/);
  await expect(page.locator('[data-role="passkeys"] .passkey-list li')).toHaveCount(1);
  await expect(page.locator('#security')).toContainText('On: 1 authenticator');
});

test('a passkey CPAY does not know is refused with a plain message', async ({ page }) => {
  const { cdp, id } = await authenticator(page);
  const u = await makeUser({ name: 'Stray Passkey' });
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  await addPasskey(page);
  // Removed on CPAY's side, still on the device.
  page.once('dialog', (d) => d.accept());
  await page.click('[data-role="passkeys"] li button');
  await expect(page.locator('[data-role="passkeys"]')).toContainText('No passkey yet.');
  expect((await cdp.send('WebAuthn.getCredentials', { authenticatorId: id })).credentials).toHaveLength(1);
  await logout(page);
  await page.click('#passkeyBtn');
  await expect(page.locator('#errorMsg')).toHaveText(/That passkey is not set up for CPAY/);
  expect(page.url()).toContain('login.html');
});

test('a pending account signing in with a passkey sees the approval message', async ({ page }) => {
  await authenticator(page);
  const u = await makeUser({ name: 'Pending Passkey' });
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  await addPasskey(page);
  await logout(page);
  await db.query(`update profiles set account_status = 'pending' where id = $1`, [u.id]);
  await page.click('#passkeyBtn');
  await expect(page.locator('#errorMsg')).toHaveText(/waiting for admin approval/);
  expect(page.url()).toContain('login.html');
});

test('a payout re-confirm can use the passkey, then the authenticator code; it is sent once', async ({ page }) => {
  await authenticator(page);
  const u: User = await makeUser({ name: 'Passkey Payout', earned: 50 });
  await readyAddress(u.id);
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  const f = await page.evaluate(async () => {
    const sb = (window as any).supabaseClient;
    const { data } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Google Authenticator', issuer: 'CPAY' });
    return { id: data.id as string, secret: data.totp.secret as string };
  });
  await page.evaluate(async ({ id, code }) => { await (window as any).supabaseClient.auth.mfa.challengeAndVerify({ factorId: id, code }); }, { id: f.id, code: totp(f.secret) });
  await addPasskey(page);
  // Back to an aal1 session, so the payout asks to confirm it is you.
  await page.evaluate(async (c) => { await (window as any).supabaseClient.auth.signInWithPassword(c); }, { email: u.email, password: u.password });

  await page.click('.navi[data-tab="cash"]');
  const tron = await page.locator('#wNet option', { hasText: 'Tron' }).getAttribute('value');
  await page.selectOption('#wNet', tron!);
  await page.fill('#wDest', TRON);
  await page.fill('#wAmt', '10');
  await page.click('#wBtn');
  await expect(page.locator('#wBtn')).toHaveText(/Confirm and send/);
  await page.click('#wBtn');
  await expect(page.locator('#reauthPasskey')).toBeVisible();
  await expect(page.locator('#reauthGoogle')).toBeHidden();
  await page.click('#reauthPasskey');
  await expect(page.locator('#mfaCode')).toBeVisible();
  await page.fill('#mfaCode', totp(f.secret));
  await page.locator('dialog [data-role="ok"]').click();
  await expect(page.locator('#toast')).toHaveText(/Sent/);
  expect((await db.query('select count(*)::int n from withdrawals where user_id = $1', [u.id])).rows[0].n).toBe(1);
  const { amr } = await amrMethods(page);
  expect(amr).toContain('passkey');
});

test('the re-confirm dialog offers no passkey to an account without one', async ({ page }) => {
  const u = await makeUser({ name: 'No Key Payout', earned: 50 });
  await readyAddress(u.id);
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  await page.evaluate(() => { (window as any).cpayReauth('Check'); });
  await expect(page.locator('#reauthPw')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#reauthPasskey')).toBeHidden();
  await expect(page.locator('#reauthAlt')).toBeHidden();
});
