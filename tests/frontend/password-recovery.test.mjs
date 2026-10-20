// Password recovery (public/auth-link.js, reset.html, login.html): reset
// links that land on the home page reach reset.html, broken links get a
// clear "request a new one" state, the reset request never reveals whether
// an account exists, and an account with an authenticator must enter its
// code before the new password is saved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const pub = (f) => readFileSync(`public/${f}`, 'utf8');
const SRC = pub('auth-link.js');

function run(href, client) {
  const u = new URL(href);
  const replaced = [];
  const location = {
    pathname: u.pathname, search: u.search, hash: u.hash, origin: u.origin,
    replace: (to) => replaced.push(to),
  };
  const window = { supabaseClient: client };
  vm.runInNewContext(SRC, { window, location, setTimeout: () => {}, URLSearchParams, decodeURIComponent });
  return { link: window.cpayAuthLink, req: window.cpayResetRequest, replaced };
}

test('a recovery link on the home page is forwarded to reset.html unchanged', () => {
  const hash = '#access_token=a.b.c&refresh_token=r&expires_in=3600&token_type=bearer&type=recovery';
  for (const path of ['/', '/index.html']) {
    const { link, replaced } = run(`https://pay.example${path}${hash}`);
    assert.equal(link.kind, 'recovery');
    assert.deepEqual(replaced, [`/reset.html${hash}`], path);
  }
});

test('an expired, used or malformed link is forwarded and reported as expired', () => {
  const hash = '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired';
  const { link, replaced } = run(`https://pay.example/${hash}`);
  assert.equal(link.kind, 'expired');
  assert.equal(link.error, 'otp_expired');
  assert.deepEqual(replaced, [`/reset.html${hash}`]);
  assert.equal(run('https://pay.example/?error=server_error').link.kind, 'expired');
});

test('a sign-up confirmation that fell back to the home page finishes on log in', () => {
  const conf = run('https://pay.example/#access_token=a.b.c&refresh_token=r&type=signup');
  assert.deepEqual(conf.replaced, ['/login.html?confirmed=1#access_token=a.b.c&refresh_token=r&type=signup']);
  const g = run('https://pay.example/#access_token=a.b.c&refresh_token=r&provider_token=p');
  assert.deepEqual(g.replaced, ['/login.html#access_token=a.b.c&refresh_token=r&provider_token=p'], 'no Google path');
  // On the log-in page itself nothing is forwarded.
  assert.deepEqual(run('https://pay.example/login.html#access_token=a.b.c&type=signup').replaced, []);
});

test('reset.html reads the link without forwarding; other pages and plain visits do nothing', () => {
  const r = run('https://pay.example/reset.html#type=recovery&access_token=x');
  assert.equal(r.link.kind, 'recovery');
  assert.deepEqual(r.replaced, []);
  assert.deepEqual(run('https://pay.example/login.html#type=recovery').replaced, []);
  const plain = run('https://pay.example/');
  assert.equal(plain.link.kind, '');
  assert.deepEqual(plain.replaced, []);
  assert.equal(run('https://pay.example/#features').link.kind, '');
});

test('branded-template links carry a one-time hash that is only read, never used, on load', () => {
  const r = run('https://pay.example/reset.html?token_hash=aaaabbbbccccdddd&type=recovery');
  assert.equal(r.link.kind, 'recovery');
  assert.equal(r.link.tokenHash, 'aaaabbbbccccdddd');
  assert.deepEqual(r.replaced, []);
  // Forwarded intact from the home page.
  const home = run('https://pay.example/?token_hash=aaaabbbbccccdddd&type=recovery');
  assert.deepEqual(home.replaced, ['/reset.html?token_hash=aaaabbbbccccdddd&type=recovery']);
  // Malformed or wrong-type hashes are ignored.
  assert.equal(run('https://pay.example/reset.html?token_hash=<x>&type=recovery').link.tokenHash, '');
  assert.equal(run('https://pay.example/reset.html?token_hash=aaaabbbbccccdddd&type=signup').link.kind, '');
  // type=recovery without tokens is not a recovery link.
  assert.equal(run('https://pay.example/reset.html?type=recovery').link.kind, '');
  assert.equal(run('https://pay.example/reset.html#type=recovery').link.kind, '');
  assert.match(pub('reset.html'), /continueBtn'\)\.onclick[\s\S]*verifyOtp\(\{ token_hash: window\.cpayAuthLink\.tokenHash, type: 'recovery' \}\)/);
});

test('the reset request never reveals whether an account exists', async () => {
  const calls = [];
  const client = (result) => ({ auth: { resetPasswordForEmail: async (email, opts) => { calls.push([email, opts.redirectTo]); return result; } } });
  // Unknown address (Supabase answers 200), per-address rate limit (only real
  // accounts hit it), and a server-side failure all look the same.
  for (const result of [{ error: null }, { error: { status: 429, code: 'over_email_send_rate_limit' } }, { error: { status: 500 } }]) {
    const { req } = run('https://pay.example/login.html', client(result));
    assert.equal(await req.requestReset('someone@example.com'), 'sent', JSON.stringify(result));
  }
  assert.equal(calls[0][1], 'https://pay.example/reset.html', 'redirect goes to this origin\'s reset page');
  const { req } = run('https://pay.example/login.html', client({ error: { name: 'AuthRetryableFetchError', status: 0 } }));
  assert.equal(await req.requestReset('someone@example.com'), 'network');
  assert.equal(await req.requestReset('not-an-email'), 'invalid');
  assert.equal(calls.length, 4, 'a malformed address is not sent to the server');
  assert.match(req.SENT, /^If an account uses that email/);
  assert.equal(req.COOLDOWN, 60);
});

test('auth-link.js loads before supabase-js on the pages that receive links', () => {
  for (const f of ['index.html', 'reset.html', 'login.html']) {
    const s = pub(f);
    const a = s.indexOf('src="auth-link.js"');
    assert.ok(a >= 0 && a < s.indexOf('supabase-js@'), `${f}: auth-link.js must load before supabase-js`);
  }
  assert.match(pub('index.html'), /cpayAuthLink\?\.forwarding\) return;/, 'home page does not redirect a forwarded link to the desk');
});

test('reset.html: states, passkey step before saving, global sign-out, recovery sessions only', () => {
  const s = pub('reset.html');
  for (const st of ['checking', 'form', 'link', 'done']) assert.ok(s.includes(`data-state="${st}"`), st);
  assert.ok(s.includes('src="mfa.js"'));
  assert.match(s, /ensureStrong\([\s\S]*?updateUser\(\{ password: a \}\)/, 'passkey before updateUser');
  assert.ok(s.indexOf('src="passkey.js"') >= 0 && s.indexOf('src="passkey.js"') < s.indexOf('src="mfa.js"'));
  assert.match(s, /updateUser[\s\S]*signOut\(\{ scope: 'global' \}\)/);
  assert.match(s, /link\.kind === 'recovery' \|\| fromResetLink\(session\)/);
  assert.match(s, /m\.method === 'recovery'/);
  assert.ok(s.includes('name="robots" content="noindex"'));
  assert.ok(s.includes('name="referrer" content="no-referrer"'));
});

test('login.html: forgot password uses the safe request and never shows the server answer', () => {
  const s = pub('login.html');
  assert.match(s, /forgotBtn'\)\.onclick[\s\S]*cpayResetRequest\.requestReset\(email[,)][\s\S]*cpayResetRequest\.cooldown/);
  assert.doesNotMatch(s, /resetPasswordForEmail/, 'only auth-link.js calls the reset endpoint');
  assert.ok(s.includes("get('reset') === 'done'"));
});

test('the recovery scripts never log, store or send the link elsewhere', () => {
  const code = (t) => t.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code(SRC), /console\.|localStorage|sessionStorage|fetch\(/);
  const inline = pub('reset.html').match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotMatch(code(inline), /console\.|localStorage|sessionStorage|fetch\(/);
});

test('the Freelancer desk has a Security tab for passkeys', () => {
  const s = pub('dashboard.html');
  assert.ok(s.includes('data-tab="security"'));
  assert.ok(s.includes('<section id="security" hidden></section>'));
  const m = s.indexOf('src="mfa.js"');
  assert.ok(m >= 0 && m < s.indexOf('src="admin-security.js"'), 'mfa.js before the Security UI');
  // The admin-only rule (last passkey kept) does not apply on the Freelancer desk.
  assert.match(pub('admin-security.js'), /if \(adminDesk && keys\.length <= 1\)/);
});
