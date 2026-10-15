// Supabase Auth CAPTCHA: every browser call to an endpoint Supabase
// protects (password sign-in, sign-up, reset email) must carry a Turnstile
// token, and every page making one must load turnstile.js. Production
// login broke on 2026-10-15 because login.html did neither.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

const pub = (f) => readFileSync(`public/${f}`, 'utf8');
// Objects from the vm realm: compare by value.
const same = (a, b, msg) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);
const files = readdirSync('public').filter((f) => /\.(html|js)$/.test(f));
const PROTECTED = /\.auth\.(signInWithPassword|signUp|resetPasswordForEmail|signInWithOtp|resend)\(/g;

test('every protected Auth call passes a captcha token', () => {
  const seen = [];
  for (const f of files) {
    const s = pub(f);
    for (const m of s.matchAll(PROTECTED)) {
      const call = s.slice(m.index, m.index + 400);
      seen.push(`${f}:${m[1]}`);
      assert.match(call, /captcha/i, `${f}: ${m[1]}() without a captcha token`);
    }
  }
  for (const want of ['login.html:signInWithPassword', 'login.html:resend', 'reauth.js:signInWithPassword', 'register.html:signUp', 'auth-link.js:resetPasswordForEmail']) {
    assert.ok(seen.includes(want), `expected ${want}`);
  }
});

test('pages that sign in, sign up or send reset email load turnstile.js before using it', () => {
  const users = files.filter((f) => f.endsWith('.html')).filter((f) => {
    const s = pub(f);
    return /\.auth\.(signInWithPassword|signUp|resetPasswordForEmail|signInWithOtp)\(/.test(s) || /src="reauth\.js"|cpayResetRequest\.requestReset/.test(s);
  });
  for (const f of ['login.html', 'reset.html', 'register.html', 'admin.html', 'dashboard.html']) assert.ok(users.includes(f), f);
  for (const f of users) {
    const s = pub(f);
    const t = s.indexOf('src="turnstile.js"');
    assert.ok(t >= 0, `${f} must load turnstile.js`);
    for (const dep of ['reauth.js', 'mfa.js']) {
      const d = s.indexOf(`src="${dep}"`);
      if (d >= 0) assert.ok(t < d, `${f}: turnstile.js before ${dep}`);
    }
  }
});

function loadTurnstile(win) {
  const doc = { getElementById: () => null, querySelector: () => null, head: { appendChild: () => {} }, body: { appendChild: () => {} }, createElement: () => ({ style: {} }) };
  vm.runInNewContext(pub('turnstile.js'), { window: win, document: doc, setTimeout, clearTimeout, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, crypto: globalThis.crypto });
  return win;
}

test('turnstile.js: off without a site key, fresh token per call, errors and expiry reject', async () => {
  const off = loadTurnstile({});
  same(await off.cpayCaptchaOptions('login'), {});

  let n = 0;
  const behaviours = [];
  const fake = { render: (box, o) => { const b = behaviours.shift() || 'pass'; setTimeout(() => (b === 'pass' ? o.callback(`tok-${++n}`) : o[`${b}-callback`]()), 1); return `w${n}`; }, remove() {} };
  const on = loadTurnstile({ CPAY_TURNSTILE_SITE_KEY: 'site-key', turnstile: fake });
  const box = {};
  same(await on.cpayCaptchaOptions('login', { container: box }), { captchaToken: 'tok-1' });
  same(await on.cpayCaptchaOptions('login', { container: box }), { captchaToken: 'tok-2' });
  for (const [b, msg] of [['error', /failed/], ['expired', /expired/], ['timeout', /timed out/]]) {
    behaviours.push(b);
    await assert.rejects(on.cpayTurnstileToken('login', { container: box }), msg);
  }
  // Payments stay challenge-free unless explicitly turned on.
  assert.equal(await on.cpayTurnstileToken('pay', { container: box }), null);
  on.CPAY_TURNSTILE_PAYMENTS = true;
  assert.match(await on.cpayTurnstileToken('pay', { container: box }), /^tok-/);
  assert.equal(on.cpayIsCaptchaError({ code: 'captcha_failed' }), true);
  assert.equal(on.cpayIsCaptchaError({ message: 'captcha protection: request disallowed (no captcha_token found)' }), true);
  assert.equal(on.cpayIsCaptchaError({ code: 'invalid_credentials', message: 'Invalid login credentials' }), false);
});

test('the reset request reports a refused check as captcha, never as "no account"', async () => {
  const run = (resetResult, captchaFails = false) => {
    const win = {
      supabaseClient: { auth: { resetPasswordForEmail: async () => resetResult } },
      cpayCaptchaOptions: async () => { if (captchaFails) throw new Error('Verification failed.'); return { captchaToken: 't' }; },
      cpayIsCaptchaError: (e) => e && e.code === 'captcha_failed',
    };
    vm.runInNewContext(pub('auth-link.js'), { window: win, location: { pathname: '/login.html', search: '', hash: '', origin: 'https://x', replace() {} }, history: {}, setTimeout, decodeURIComponent });
    return win.cpayResetRequest.requestReset('a@b.co');
  };
  assert.equal(await run({ error: null }), 'sent');
  assert.equal(await run({ error: { code: 'captcha_failed', status: 400 } }), 'captcha');
  assert.equal(await run({ error: null }, true), 'captcha');
  assert.equal(await run({ error: { status: 429 } }), 'sent');
});

test('config.js holds at most the public Turnstile site key, never the secret', () => {
  const s = pub('config.js');
  const m = s.match(/CPAY_TURNSTILE_SITE_KEY\s*=\s*window\.CPAY_TURNSTILE_SITE_KEY\s*\|\|\s*'([^']*)'/);
  assert.ok(m, 'config.js declares CPAY_TURNSTILE_SITE_KEY');
  // Site keys are short (about 24 characters); secret keys are much longer.
  assert.ok(m[1] === '' || /^(0x|1x|2x|3x)[A-Za-z0-9_-]{18,26}$/.test(m[1]), 'not a Turnstile site key (a secret key must never be here)');
  assert.doesNotMatch(s, /TURNSTILE_SECRET|secret_key|captcha_secret/i);
});
