// Two-step sign-in wiring (public/mfa.js): every page that can ask for a
// payout step-up can also ask for the authenticator code, and the MFA code
// never logs or stores anything it handles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const pub = (f) => readFileSync(`public/${f}`, 'utf8');
const pages = readdirSync('public').filter((f) => f.endsWith('.html'));

test('every page that loads reauth.js loads mfa.js before it', () => {
  const withReauth = pages.filter((f) => pub(f).includes('src="reauth.js"'));
  assert.ok(withReauth.length >= 2, 'expected admin.html and dashboard.html');
  for (const f of withReauth) {
    const s = pub(f);
    const m = s.indexOf('src="mfa.js"');
    assert.ok(m >= 0 && m < s.indexOf('src="reauth.js"'), `${f}: mfa.js must load before reauth.js`);
  }
});

test('login finishes a sign-in with the passkey (admins always) and signs out on cancel', () => {
  const s = pub('login.html');
  assert.ok(s.includes('src="mfa.js"'));
  assert.match(s, /async function go\(id\)\{[\s\S]*?if \(!\(await finishSecondStep\(data\?\.role === 'admin' && data\?\.account_status === 'active'\)\)\) return;/);
  assert.match(s, /promptPasskey\(msg\)[\s\S]*?ensureStrong\(msg\)[\s\S]*?signOut\(\)/);
});

test('no authenticator-app (TOTP) enrolment or code entry is left in the pages', () => {
  for (const f of ['mfa.js', 'admin-security.js', 'reauth.js', 'login.html', 'reset.html', 'app.js']) {
    const s = pub(f);
    assert.doesNotMatch(s, /mfa\.enroll|challengeAndVerify|factorType: 'totp'|one-time-code/, f);
  }
});

test('reauth.js asks for the passkey after a password sign-in when the account needs the strong factor', () => {
  const s = pub('reauth.js');
  assert.match(s, /const finish = async \(\) => \{\s*if \(window\.cpayMfa && await window\.cpayMfa\.needsChallenge\(\)\) \{[\s\S]*?cpayMfa\.promptPasskey\(/);
  assert.doesNotMatch(s, /google|signInWithOAuth/i);
  assert.match(s, /signInWithPassword\([^)]*\);[\s\S]*?if \(error\) throw new Error\('That password is not right\.'\);\s*await finish\(\);/);
});

test('the MFA scripts never log, store or send codes and secrets elsewhere', () => {
  for (const f of ['mfa.js', 'admin-security.js', 'reauth.js']) {
    const s = pub(f).replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(s, /console\.|localStorage|sessionStorage|fetch\(/, `${f} must not log, persist or fetch`);
  }
  assert.doesNotMatch(pub('mfa.js'), /rpc\('(?!record_mfa_challenge_failure)/, 'mfa.js calls no RPC except the audit note');
});

test('admin desk has the Security tab, section and script', () => {
  const s = pub('admin.html');
  assert.ok(s.includes('data-tab="security"'));
  assert.ok(s.includes('<section id="security" hidden></section>'));
  assert.ok(s.includes('src="admin-security.js'));
});
