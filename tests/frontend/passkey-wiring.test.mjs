// Passkeys (public/passkey.js): opted in on the client, loaded where they
// are used, shown only when Supabase Auth has them on, never logging or
// storing anything, and a re-confirm passkey must belong to the same person.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const pub = (f) => readFileSync(`public/${f}`, 'utf8');
const before = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b); return i >= 0 && j >= 0 && i < j; };

test('the browser client opts in to passkeys, in production and in the E2E stack', () => {
  assert.match(pub('config.js'), /createClient\(window\.SUPABASE_URL, window\.SUPABASE_ANON_KEY, \{ auth: \{ experimental: \{ passkey: true \} \} \}\)/);
  assert.match(readFileSync('e2e/stack.mjs', 'utf8'), /experimental: \{ passkey: true \}/);
});

test('pages load the Auth settings reader before the scripts that use it', () => {
  const login = pub('login.html');
  assert.ok(!login.includes('oauth.js') && !pub('register.html').includes('oauth.js'), 'no Google sign-in script');
  assert.ok(before(login, 'src="auth-features.js"', 'src="passkey.js"'));
  assert.ok(before(login, 'src="turnstile.js"', 'src="passkey.js"'), 'passkey sign-in carries a CAPTCHA token');
  for (const f of ['dashboard.html', 'admin.html']) {
    const s = pub(f);
    assert.ok(before(s, 'src="passkey.js"', 'src="reauth.js"'), `${f}: passkey.js before reauth.js`);
    assert.ok(before(s, 'src="auth-features.js"', 'src="passkey.js"'), `${f}: auth-features.js first`);
    assert.ok(s.indexOf('src="passkey.js"') < s.indexOf('admin-security.js'), `${f}: passkey.js before the Security UI`);
  }
});

function features(settings) {
  const win = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon' };
  let calls = 0;
  const fetch = async (url) => { calls += 1; assert.equal(url, 'https://x.supabase.co/auth/v1/settings'); return settings === 'down' ? { ok: false } : { ok: true, json: async () => settings }; };
  vm.runInNewContext(pub('auth-features.js'), { window: win, fetch });
  return { win, calls: () => calls };
}

test('auth-features.js reads passkeys from Supabase Auth /settings once; no Google field', async () => {
  const on = features({ external: { google: true }, passkeys_enabled: true });
  assert.equal(JSON.stringify(await on.win.cpayAuthFeatures()), JSON.stringify({ passkeys: true }));
  await on.win.cpayAuthFeatures();
  assert.equal(on.calls(), 1, 'cached per page');
  const off = features({ external: {} });
  assert.equal(JSON.stringify(await off.win.cpayAuthFeatures()), JSON.stringify({ passkeys: false }));
  const down = features('down');
  assert.equal(JSON.stringify(await down.win.cpayAuthFeatures()), JSON.stringify({ passkeys: false }));
});

function passkeyApi(win) {
  vm.runInNewContext(pub('passkey.js'), { window: win, navigator: win.navigator });
  return win.cpayPasskey;
}

test('passkey.js: shown only with browser support and the setting on; cancel is silent; errors are plain', async () => {
  const navigator = { credentials: { get() {}, create() {} } };
  const base = { PublicKeyCredential: function () {}, navigator };
  const api = (over) => passkeyApi({ ...base, cpayAuthFeatures: async () => ({ passkeys: true }), ...over });
  assert.equal(await api({}).available(), true);
  assert.equal(await api({ cpayAuthFeatures: async () => ({ passkeys: false }) }).available(), false);
  assert.equal(await passkeyApi({ navigator, cpayAuthFeatures: async () => ({ passkeys: true }) }).available(), false, 'no WebAuthn');

  let opts = null;
  const client = (result) => ({ auth: { signInWithPasskey: async (o) => { opts = o; return result; } } });
  const withCaptcha = { cpayCaptchaOptions: async () => ({ captchaToken: 'tok' }), cpayIsCaptchaError: () => false };
  let r = await api({ ...withCaptcha, supabaseClient: client({ data: { user: { id: 'u1' } }, error: null }) }).signIn();
  assert.equal(r.user.id, 'u1');
  assert.equal(opts.options.captchaToken, 'tok', 'CAPTCHA token on the challenge request');
  r = await api({ ...withCaptcha, supabaseClient: client({ data: null, error: { name: 'NotAllowedError', code: 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY' } }) }).signIn();
  assert.equal(r.cancelled, true);
  r = await api({ ...withCaptcha, supabaseClient: client({ data: null, error: { name: 'AuthApiError', code: 'webauthn_credential_not_found' } }) }).signIn();
  assert.match(r.error, /not set up for CPAY/);
  r = await api({ ...withCaptcha, supabaseClient: client({ data: null, error: { name: 'AuthApiError', code: 'email_not_confirmed' } }) }).signIn();
  assert.equal(r.code, 'email_not_confirmed');
  r = await api({ cpayCaptchaOptions: async () => { throw new Error('The security check did not pass.'); }, supabaseClient: client({}) }).signIn();
  assert.equal(r.code, 'captcha_failed');
});

test('the passkey scripts never log, store or send credentials elsewhere', () => {
  const code = (t) => t.replace(/^\s*\/\/.*$/gm, '');
  for (const f of ['passkey.js', 'auth-features.js', 'reauth.js']) {
    assert.doesNotMatch(code(pub(f)), /console\.|localStorage|sessionStorage/, f);
  }
  assert.doesNotMatch(code(pub('passkey.js')), /fetch\(/, 'only supabase-js talks to Auth');
});

test('a re-confirm passkey must be the same account, and adding a second or removing one needs a passkey', () => {
  const r = pub('reauth.js');
  assert.match(r, /async function samePerson\(beforeId, user\) \{\s*if \(user && user\.id === beforeId\) return true;\s*await sb\(\)\.auth\.signOut\(\);/);
  assert.match(r, /samePerson\(user\.id, r\.user\)\)\) return;\s*await finish\(\);/);
  const s = pub('admin-security.js');
  assert.match(s, /if \(keys\.length && !\(await confirmStrong\([^)]*\)\)\) return;\s*const r = await window\.cpayPasskey\.register\(\)/);
  assert.match(s, /if \(adminDesk && count <= 1\) return;\s*if \(!\(await confirmStrong\([\s\S]*?cpayPasskey\.remove\(/);
  assert.match(s, /if \(adminDesk && keys\.length <= 1\) \{\s*rm\.disabled = true;/, 'an admin keeps the last passkey');
  // mfa.js: the same account, or sign out.
  assert.match(pub('mfa.js'), /if \(!r\.user \|\| r\.user\.id !== before\) \{ await sb\(\)\.auth\.signOut\(\);/);
  // A passkey sign-in finishes like a password one: code, then status.
  assert.match(pub('login.html'), /cpayPasskey\.signIn\([\s\S]*?await go\(r\.user\.id\)/);
});
