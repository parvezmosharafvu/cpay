import { test, expect } from '@playwright/test';
import { makeUser, login, db, uniq, ORIGIN, PASSWORD, readyAddress } from './helpers';

// Email confirmation for new Freelancer accounts, "Continue with Google",
// and the desk's payout-network list. The stand-in Auth plays Supabase:
// /__e2e/confirm turns on "Confirm email", /__e2e/google the Google provider.

const toggle = (what: string, q: string) => fetch(`${ORIGIN}/__e2e/${what}?${q}`, { method: 'POST' });
const mailFor = async (email: string) => (await fetch(`${ORIGIN}/__e2e/mailbox?to=${encodeURIComponent(email)}`)).json();

test.afterEach(async () => { await toggle('confirm', 'on=0'); await toggle('google', 'on=0'); });

test('sign-up needs the email link: check-inbox screen, login refused, resend, confirm, then approval', async ({ page }) => {
  await toggle('confirm', 'on=1');
  const email = `${uniq('conf')}@test.invalid`;
  await page.goto('/register.html');
  await page.fill('#displayName', 'Confirm Me');
  await page.fill('#email', email);
  await page.fill('#password', PASSWORD);
  await page.click('#submitBtn');
  await expect(page.locator('#checkState')).toBeVisible();
  await expect(page.locator('#checkText')).toContainText(email);
  expect(await mailFor(email)).toHaveLength(1);
  expect((await db.query('select email_confirmed_at from auth.users where email = $1', [email])).rows[0].email_confirmed_at).toBeNull();

  // Before confirming: login is refused with the confirm notice; resend works.
  await login(page, { id: '', email, password: PASSWORD });
  await expect(page.locator('#confirmBox')).toBeVisible();
  await expect(page.locator('#errorMsg')).toBeHidden();
  await page.click('#resendConfirmBtn');
  await expect(page.locator('#okMsg')).toContainText('a new link is on its way');
  const mails = await mailFor(email);
  expect(mails).toHaveLength(2);

  // Open the newest link: email confirmed, account still waits for the admin.
  await page.goto(mails[1].link);
  await page.waitForURL(/login\.html\?confirmed=1/);
  await expect(page.locator('#okMsg')).toContainText('Email confirmed');
  await expect(page.locator('#okMsg')).toContainText('waiting for admin approval');
  const { rows: [u] } = await db.query('select u.email_confirmed_at, p.account_status from auth.users u join profiles p on p.id = u.id where u.email = $1', [email]);
  expect(u.email_confirmed_at).not.toBeNull();
  expect(u.account_status).toBe('pending');

  // After approval the password works.
  await db.query(`update profiles set account_status = 'active' where email = $1`, [email]);
  await login(page, { id: '', email, password: PASSWORD });
  await page.waitForURL(/dashboard\.html/);
});

test('a used or expired confirmation link explains itself instead of failing silently', async ({ page }) => {
  await toggle('confirm', 'on=1');
  const email = `${uniq('conf2')}@test.invalid`;
  await page.goto('/register.html');
  await page.fill('#email', email);
  await page.fill('#password', PASSWORD);
  await page.click('#submitBtn');
  await expect(page.locator('#checkState')).toBeVisible();
  const [mail] = await mailFor(email);
  await page.goto(mail.link);
  await page.waitForURL(/login\.html\?confirmed=1/);
  await page.goto(mail.link); // second use
  await page.waitForURL(/reset\.html/);
  await expect(page.locator('#linkTitle')).toHaveText('This email link no longer works');
});

test('Google button stays hidden while the provider is off', async ({ page }) => {
  for (const p of ['/login.html', '/register.html']) {
    await page.goto(p);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#googleBtn')).toBeHidden();
  }
});

test('Continue with Google: new account starts pending with the Google name; after approval it reaches the desk', async ({ page }) => {
  const email = `${uniq('goog')}@test.invalid`;
  await toggle('google', `on=1&email=${encodeURIComponent(email)}&name=${encodeURIComponent('Rina Akter')}`);
  await page.goto('/register.html');
  await expect(page.locator('#googleBtn')).toBeVisible();
  await page.goto('/login.html');
  await page.click('#googleBtn');
  await page.waitForURL(/login\.html\?via=google/);
  await expect(page.locator('#okMsg')).toContainText('Signed in with Google');
  await expect(page.locator('#okMsg')).toContainText('waiting for admin approval');
  const { rows: [p] } = await db.query('select display_name, role, account_status from profiles where email = $1', [email]);
  expect(p).toEqual({ display_name: 'Rina Akter', role: 'creator', account_status: 'pending' });
  expect((await db.query('select count(*)::int n from account_applications where email = $1', [email])).rows[0].n).toBe(1);

  await db.query(`update profiles set account_status = 'active' where email = $1`, [email]);
  await page.click('#googleBtn');
  await page.waitForURL(/dashboard\.html/);
  await expect(page.locator('#hello')).toHaveText('Rina Akter');
});

test('the desk lists saved payout networks by name with their ready time', async ({ page }) => {
  const u = await makeUser({ name: 'Net Check' });
  await readyAddress(u.id, 'tron');
  // Saving is instant now; a row still waiting from before that change is simulated with triggers off.
  await db.query(`begin; set local session_replication_role = replica; insert into usdt_wallets(user_id, network, address, usable_after) values ('${u.id}', 'bsc', '0x52908400098527886E0F7030069857D2E4169EE7', now() + interval '20 hours'); commit;`);
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  await page.click('.navi[data-tab="profile"]');
  const tron = page.locator('#profile tr', { hasText: 'Tron (TRC-20)' });
  await expect(tron).toContainText('Ready');
  const bsc = page.locator('#profile tr', { hasText: 'BNB Smart Chain (BEP-20)' });
  await expect(bsc).toContainText('Usable from');
  await page.click('.navi[data-tab="cash"]');
  await expect(page.locator('#cash')).toContainText('Tron (TRC-20) (Ready)');
  await expect(page.locator('#cash')).toContainText('BNB Smart Chain (BEP-20) (Usable from');
});

test('the first authenticator is suggested as "Google Authenticator"', async ({ page }) => {
  const u = await makeUser({ name: 'Name Default' });
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  await page.click('.navi[data-tab="security"]');
  await expect(page.locator('[data-role="factor-name"]')).toHaveAttribute('placeholder', 'Google Authenticator');
});
