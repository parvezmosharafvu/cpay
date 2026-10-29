import { test, expect } from './fixtures';
import { makeUser, login, db, uniq, ORIGIN, SITE, PASSWORD, expectCleanCopy, openAuthForm } from './helpers';

const SENT = /^If an account uses that email, a reset link is on its way/;
const mailFor = async (email: string) => (await fetch(`${ORIGIN}/__e2e/mailbox?to=${encodeURIComponent(email)}`)).json();

test('register creates a pending Freelancer application', async ({ page }) => {
  const email = `${uniq('reg')}@test.invalid`;
  await page.goto('/register.html');
  await openAuthForm(page);
  await expectCleanCopy(page);
  await page.fill('#displayName', 'New Person');
  await page.fill('#phone', '+8801712345678');
  await page.fill('#email', email);
  await page.fill('#password', PASSWORD);
  await page.fill('#passwordConfirm', PASSWORD);
  await page.click('#submitBtn');
  // The URL can already match before sign-up finishes; wait for the row.
  await expect.poll(async () => (await db.query('select role, account_status from profiles where email = $1', [email])).rows[0] ?? null,
    { timeout: 15_000 }).toEqual({ role: 'creator', account_status: 'pending' });
});

test('register rejects a short password before calling the server', async ({ page }) => {
  await page.goto('/register.html');
  await openAuthForm(page);
  await page.fill('#displayName', 'Short Password');
  await page.fill('#phone', '+8801712345678');
  await page.fill('#email', `${uniq('reg')}@test.invalid`);
  await page.fill('#password', 'short');
  await page.fill('#passwordConfirm', 'short');
  await page.click('#submitBtn');
  await expect(page.locator('#errorMsg')).toHaveText(/at least 8/);
});

test('an active Freelancer logs in to the desk and logs out', async ({ page }) => {
  const u = await makeUser({ name: 'Rina' });
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  await expect(page.locator('#hello')).toHaveText('Rina');
  await page.click('#logoutBtn');
  await page.waitForURL(/login\.html|\/$/);
  await page.goto('/dashboard.html');
  await page.waitForURL(/login\.html/);
});

test('wrong password and pending account are refused with a clear message', async ({ page }) => {
  const u = await makeUser();
  await login(page, { ...u, password: 'not-the-password' });
  await expect(page.locator('#errorMsg')).toHaveText(/Invalid login credentials/);
  const pending = await makeUser({ status: 'pending' });
  await login(page, pending);
  await expect(page.locator('#errorMsg')).toHaveText(/waiting for admin approval/i);
  expect(page.url()).toContain('login.html');
});

test('password recovery: request a link, set a new password, log in with it', async ({ page, browser }) => {
  const u = await makeUser({ name: 'Recover Me' });
  await page.goto('/login.html');
  await openAuthForm(page);
  await page.fill('#email', u.email);
  await page.click('#forgotBtn');
  await expect(page.locator('#okMsg')).toHaveText(SENT);
  await expect(page.locator('#forgotBtn')).toBeDisabled();
  await expect(page.locator('#forgotBtn')).toHaveText(/Send again in \d+s/);
  const mail = await mailFor(u.email);
  expect(mail).toHaveLength(1);
  expect(mail[0].link).toContain(`${SITE}/reset.html#`);
  await page.goto(mail[0].link);
  await page.fill('#password', 'brand-new-pass-1');
  await page.fill('#password2', 'brand-new-pass-1');
  await page.click('#saveBtn');
  await expect(page.locator('#doneState')).toBeVisible();
  await page.click('#doneState a');
  await page.waitForURL(/login\.html\?reset=done/);
  await expect(page.locator('#okMsg')).toHaveText(/Password updated/);
  // A fresh browser: the old password fails, the new one works.
  const fresh = await (await browser.newContext()).newPage();
  await login(fresh, u);
  await expect(fresh.locator('#errorMsg')).toHaveText(/Invalid login credentials/);
  await login(fresh, { ...u, password: 'brand-new-pass-1' });
  await fresh.waitForURL(/dashboard\.html/);
});

test('forgot password answers the same for an unknown email and sends nothing', async ({ page }) => {
  const email = `${uniq('nobody')}@test.invalid`;
  await page.goto('/login.html');
  await openAuthForm(page);
  await page.fill('#email', email);
  await page.click('#forgotBtn');
  await expect(page.locator('#okMsg')).toHaveText(SENT);
  await expect(page.locator('#errorMsg')).toBeHidden();
  expect(await mailFor(email)).toHaveLength(0);
});

test('a reset link that falls back to the home page (Site URL) still opens the reset form', async ({ page, browser }) => {
  const u = await makeUser({ name: 'Home Landing' });
  await page.goto('/login.html');
  await openAuthForm(page);
  await page.fill('#email', u.email);
  await page.click('#forgotBtn');
  await expect(page.locator('#okMsg')).toHaveText(SENT);
  const [mail] = await mailFor(u.email);
  // What Supabase Auth does when /reset.html is not on the Redirect URLs list.
  const home = `${SITE}/${mail.link.slice(mail.link.indexOf('#'))}`;
  await page.goto(home);
  await page.waitForURL(/reset\.html/);
  await expect(page.locator('#formState')).toBeVisible();
  await page.fill('#password', 'home-landing-pass-1');
  await page.fill('#password2', 'home-landing-pass-1');
  await page.click('#saveBtn');
  await expect(page.locator('#doneState')).toBeVisible();
  const fresh = await (await browser.newContext()).newPage();
  await login(fresh, { ...u, password: 'home-landing-pass-1' });
  await fresh.waitForURL(/dashboard\.html/);
});

test('an expired or reused link shows a clear state and can send a new link', async ({ page }) => {
  const u = await makeUser({ name: 'Expired Link' });
  await page.goto('/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
  await page.waitForURL(/reset\.html/);
  await expect(page.locator('#linkState')).toBeVisible();
  await expect(page.locator('#linkTitle')).toHaveText('This email link no longer works');
  await expect(page.locator('#formState')).toBeHidden();
  await page.fill('#resendEmail', u.email);
  await page.click('#resendBtn');
  await expect(page.locator('#okMsg')).toHaveText(SENT);
  await expect(page.locator('#resendBtn')).toBeDisabled();
  expect(await mailFor(u.email)).toHaveLength(1);
});

test('the reset page refuses a missing or ordinary session, and a malformed link', async ({ page }) => {
  await page.goto('/reset.html');
  await expect(page.locator('#linkState')).toBeVisible();
  await expect(page.locator('#linkTitle')).toHaveText('Open the link from your email');
  await page.goto('/reset.html#access_token=not-a-token&type=recovery');
  await expect(page.locator('#formState')).toBeHidden();
  // Signed in with a password (not from a reset link): no password change here.
  const u = await makeUser({ name: 'Ordinary Session' });
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  await page.goto('/reset.html');
  await expect(page.locator('#linkState')).toBeVisible();
  await expect(page.locator('#formState')).toBeHidden();
});

test('reset rejects short and mismatched passwords before calling the server', async ({ page }) => {
  const u = await makeUser({ name: 'Validate Me' });
  await page.goto('/login.html');
  await openAuthForm(page);
  await page.fill('#email', u.email);
  await page.click('#forgotBtn');
  await expect(page.locator('#okMsg')).toHaveText(SENT);
  const [mail] = await mailFor(u.email);
  await page.goto(mail.link);
  await page.fill('#password', 'short');
  await page.fill('#password2', 'short');
  await page.click('#saveBtn');
  await expect(page.locator('#errorMsg')).toHaveText(/at least 8/);
  await page.fill('#password', 'long-enough-1');
  await page.fill('#password2', 'long-enough-2');
  await page.click('#saveBtn');
  await expect(page.locator('#errorMsg')).toHaveText(/do not match/);
  await expect(page.locator('#formState')).toBeVisible();
});

test('branded-template link: nothing is used until Continue; a second use is refused', async ({ page }) => {
  const u = await makeUser({ name: 'Token Hash' });
  await page.goto('/login.html');
  await openAuthForm(page);
  await page.fill('#email', u.email);
  await page.click('#forgotBtn');
  await expect(page.locator('#okMsg')).toHaveText(SENT);
  const [mail] = await mailFor(u.email);
  const link = `${SITE}/reset.html?token_hash=${mail.tokenHash}&type=recovery`;
  await page.goto(link);
  await expect(page.locator('#confirmState')).toBeVisible();
  // The one-time hash leaves the address bar before anything else loads.
  expect(page.url()).toBe(`${SITE}/reset.html`);
  await page.click('#continueBtn');
  await expect(page.locator('#formState')).toBeVisible();
  await page.fill('#password', 'token-hash-pass-1');
  await page.fill('#password2', 'token-hash-pass-1');
  await page.click('#saveBtn');
  await expect(page.locator('#doneState')).toBeVisible();
  // Reusing the same link fails safely.
  await page.goto(link);
  await page.click('#continueBtn');
  await expect(page.locator('#linkState')).toBeVisible();
  await expect(page.locator('#linkTitle')).toHaveText('This link no longer works');
});
