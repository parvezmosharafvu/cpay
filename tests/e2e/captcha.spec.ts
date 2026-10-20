import { test, expect, type Page } from '@playwright/test';
import { makeUser, makeLink, login, db, uniq, ORIGIN, SITE, PASSWORD, TRON, paymentsFor, readyAddress } from './helpers';

// Supabase Auth CAPTCHA protection (production since 2026-10-15): sign-in,
// sign-up and reset-email requests without a Turnstile token are refused
// with "captcha protection: request disallowed (no captcha_token found)".
// The stand-in Auth enforces the same rule while /__e2e/captcha is on, and
// a fake Turnstile (no network) hands out single-use "e2e-pass-" tokens.

const captcha = (on: boolean) => fetch(`${ORIGIN}/__e2e/captcha?on=${on ? 1 : 0}`, { method: 'POST' });
const mailFor = async (email: string) => (await fetch(`${ORIGIN}/__e2e/mailbox?to=${encodeURIComponent(email)}`)).json();
const CAPTCHA_MSG = /The security check did not pass/;

// mode: 'pass' issues a fresh token. The others misbehave once, then pass
// (so a retry works): 'fail' calls the error callback, 'expire' the expiry
// callback, 'bad' hands out a token Supabase Auth refuses (as a stale or
// forged one would be).
async function fakeTurnstile(page: Page, { siteKey = true, mode = 'pass' } = {}) {
  const loads: string[] = [];
  await page.route('https://challenges.cloudflare.com/**', (route) => {
    loads.push(route.request().url());
    return route.fulfill({
      contentType: 'application/javascript',
      body: `window.turnstile = { _n: 0, _odd: ${mode === 'pass' ? 0 : 1}, _mode: ${JSON.stringify(mode)},
        render(el, o) { const id = 'w' + (++this._n); const odd = this._odd > 0; if (odd) this._odd--;
          const tok = (p) => p + Math.random().toString(36).slice(2);
          setTimeout(() => {
            if (!odd) return o.callback(tok('e2e-pass-'));
            if (this._mode === 'fail') return o['error-callback']();
            if (this._mode === 'expire') return o['expired-callback']();
            return o.callback(tok('e2e-bad-'));
          }, 20); return id; },
        remove() {} };`,
    });
  });
  if (siteKey) await page.addInitScript(() => { (window as any).CPAY_TURNSTILE_SITE_KEY = '1x00000000000000000000AA'; });
  return loads;
}

test.afterEach(async () => { await captcha(false); });

test('without a site key the login fails with a clear message, not the raw Auth error', async ({ page }) => {
  const u = await makeUser({ name: 'No Key' });
  await captcha(true);
  await login(page, u);
  await expect(page.locator('#errorMsg')).toHaveText(CAPTCHA_MSG);
  await expect(page.locator('#submitBtn')).toBeEnabled();
  expect(page.url()).toContain('login.html');
});

test('login sends a fresh token and works; a second login needs a new token', async ({ page, browser }) => {
  const u = await makeUser({ name: 'Captcha Login' });
  await captcha(true);
  const loads = await fakeTurnstile(page);
  await login(page, u);
  await page.waitForURL(/dashboard\.html/);
  expect(loads.length).toBeGreaterThan(0);
  // A new browser: a new token, accepted once.
  const ctx = await browser.newContext();
  const other = await ctx.newPage();
  await fakeTurnstile(other);
  await login(other, u);
  await other.waitForURL(/dashboard\.html/);
  await ctx.close();
});

test('a widget error re-enables the button and a retry logs in', async ({ page }) => {
  const u = await makeUser({ name: 'Captcha Retry' });
  await captcha(true);
  await fakeTurnstile(page, { mode: 'fail' });
  await login(page, u);
  await expect(page.locator('#errorMsg')).toHaveText(/Verification failed/);
  await expect(page.locator('#submitBtn')).toBeEnabled();
  await expect(page.locator('#submitBtn')).toHaveText('Log in');
  await page.click('#submitBtn');
  await page.waitForURL(/dashboard\.html/);
});

test('forgot password and resend carry a token; a refused check says nothing about the account', async ({ page }) => {
  const u = await makeUser({ name: 'Captcha Reset' });
  await captcha(true);
  // No site key: refused as a security check, not "no account".
  await page.goto('/login.html');
  await page.fill('#email', u.email);
  await page.click('#forgotBtn');
  await expect(page.locator('#errorMsg')).toHaveText(CAPTCHA_MSG);
  expect(await mailFor(u.email)).toHaveLength(0);
  // With the widget: the email goes out.
  const fresh = await page.context().newPage();
  await fakeTurnstile(fresh);
  await fresh.goto('/login.html');
  await fresh.fill('#email', u.email);
  await fresh.click('#forgotBtn');
  await expect(fresh.locator('#okMsg')).toHaveText(/^If an account uses that email/);
  expect(await mailFor(u.email)).toHaveLength(1);
  // The link itself (/verify) needs no token; setting the password works.
  const [mail] = await mailFor(u.email);
  await fresh.goto(mail.link);
  await fresh.fill('#password', 'captcha-reset-pass-1');
  await fresh.fill('#password2', 'captcha-reset-pass-1');
  await fresh.click('#saveBtn');
  await expect(fresh.locator('#doneState')).toBeVisible();
  // Resend from the reset page also carries a token.
  await fresh.goto('/reset.html');
  await fresh.fill('#resendEmail', u.email);
  await fresh.click('#resendBtn');
  await expect(fresh.locator('#okMsg')).toHaveText(/^If an account uses that email/);
  expect(await mailFor(u.email)).toHaveLength(2);
});

test('registration carries a token', async ({ page }) => {
  const email = `${uniq('cap')}@test.invalid`;
  await captcha(true);
  await fakeTurnstile(page);
  await page.goto('/register.html');
  await page.fill('#displayName', 'Captcha Signup');
  await page.fill('#email', email);
  await page.fill('#password', PASSWORD);
  await page.click('#submitBtn');
  await expect.poll(async () => (await db.query('select account_status from profiles where email = $1', [email])).rows[0]?.account_status ?? null,
    { timeout: 15_000 }).toBe('pending');
});

test('payments stay challenge-free when only Auth CAPTCHA is on', async ({ page }) => {
  const u = await makeUser();
  const slug = await makeLink(u.id, { name: 'No Challenge' });
  const loads = await fakeTurnstile(page);
  await page.goto(`/${slug}?amount=5`);
  await page.click('#payBtn');
  await page.waitForURL(/[?&]id=/);
  expect(loads).toHaveLength(0);
  expect(await paymentsFor(u.id)).toHaveLength(1);
});

test('an expired check says so and a retry logs in with a new token', async ({ page }) => {
  const u = await makeUser({ name: 'Captcha Expired' });
  await captcha(true);
  await fakeTurnstile(page, { mode: 'expire' });
  await login(page, u);
  await expect(page.locator('#errorMsg')).toHaveText(/Verification expired/);
  await expect(page.locator('#submitBtn')).toBeEnabled();
  await page.click('#submitBtn');
  await page.waitForURL(/dashboard\.html/);
});

test('a token Supabase Auth refuses gives the plain CAPTCHA message, and a retry with a fresh token works', async ({ page }) => {
  const u = await makeUser({ name: 'Captcha Refused' });
  await captcha(true);
  await fakeTurnstile(page, { mode: 'bad' });
  await login(page, u);
  await expect(page.locator('#errorMsg')).toHaveText(CAPTCHA_MSG);
  await expect(page.locator('#errorMsg')).not.toContainText(/invalid|credentials|not found/i);
  await expect(page.locator('#submitBtn')).toBeEnabled();
  await page.click('#submitBtn');
  await page.waitForURL(/dashboard\.html/);
});

test('the sign-up confirmation email can be sent again with a token', async ({ page }) => {
  const email = `${uniq('capconf')}@test.invalid`;
  await fetch(`${ORIGIN}/__e2e/confirm?on=1`, { method: 'POST' });
  try {
    await captcha(true);
    await fakeTurnstile(page);
    await page.goto('/register.html');
    await page.fill('#email', email);
    await page.fill('#password', PASSWORD);
    await page.click('#submitBtn');
    await expect(page.locator('#checkState')).toBeVisible();
    await login(page, { id: '', email, password: PASSWORD });
    await expect(page.locator('#confirmBox')).toBeVisible();
    await page.click('#resendConfirmBtn');
    await expect(page.locator('#okMsg')).toContainText('a new link is on its way');
    expect(await mailFor(email)).toHaveLength(2);
  } finally {
    await fetch(`${ORIGIN}/__e2e/confirm?on=0`, { method: 'POST' });
  }
});

test('the payout password re-confirm carries a token too', async ({ page }) => {
  const u = await makeUser({ name: 'Captcha Payout', earned: 50 });
  await readyAddress(u.id);
  // A reset-link session (requested before CAPTCHA is on) must re-confirm.
  await fetch(`${ORIGIN}/auth/v1/recover?redirect_to=${encodeURIComponent(`${SITE}/reset.html`)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: u.email }),
  });
  const [mail] = (await mailFor(u.email)).filter((m: { kind: string }) => m.kind === 'recovery');
  await captcha(true);
  await fakeTurnstile(page, { mode: 'bad' });
  await page.goto(mail.link);
  await expect(page.locator('#formState')).toBeVisible();
  await page.goto('/dashboard.html');
  await page.click('.navi[data-tab="cash"]');
  const tron = await page.locator('#wNet option', { hasText: 'Tron' }).getAttribute('value');
  await page.selectOption('#wNet', tron!);
  await page.fill('#wDest', TRON);
  await page.fill('#wAmt', '10');
  await page.click('#wBtn');
  await expect(page.locator('#wBtn')).toHaveText(/Confirm and send/);
  await page.click('#wBtn');
  await page.fill('#reauthPw', u.password);
  await page.click('#reauthOk');
  // The first token is refused: a plain message, nothing sent.
  await expect(page.locator('#reauthErr')).toHaveText(CAPTCHA_MSG);
  expect((await db.query('select count(*)::int n from withdrawals where user_id = $1', [u.id])).rows[0].n).toBe(0);
  await page.fill('#reauthPw', u.password);
  await page.click('#reauthOk');
  await expect(page.locator('#toast')).toHaveText(/Sent/);
  expect((await db.query('select count(*)::int n from withdrawals where user_id = $1', [u.id])).rows[0].n).toBe(1);
});
