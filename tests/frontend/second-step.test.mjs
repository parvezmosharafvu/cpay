// Every desk page loads its profile through loadProfile() (public/app.js).
// A session that owes its two-step code (aal1 with a verified factor) must
// finish it there, or a reload / second tab would skip login.html's prompt.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function load({ mfa, profile = { id: 'u1', role: 'admin', account_status: 'active' } }) {
  const calls = { signOut: 0, profileReads: 0 };
  const location = { href: 'admin.html' };
  const query = { select() { return this; }, eq() { return this; }, async single() { calls.profileReads++; return { data: profile, error: null }; } };
  const window = {
    supabaseClient: {
      auth: { async getSession() { return { data: { session: { user: { id: 'u1' } } } }; }, async signOut() { calls.signOut++; } },
      from() { return query; },
    },
  };
  if (mfa) window.cpayMfa = mfa;
  const ctx = vm.createContext({ window, location, document: { getElementById: () => null }, alert() {} });
  vm.runInContext(readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8'), ctx);
  return { ctx, calls, location };
}

test('a session that owes its code and does not enter it gets no profile and is signed out', async () => {
  const { ctx, calls, location } = load({ mfa: { async ensureStrong() { return false; } } });
  const p = await vm.runInContext('loadProfile()', ctx);
  assert.equal(p, null);
  assert.equal(calls.profileReads, 0, 'no desk data is read before the code');
  assert.equal(calls.signOut, 1);
  assert.equal(location.href, 'login.html');
});

test('an MFA check that errors fails closed', async () => {
  const { ctx, calls } = load({ mfa: { async ensureStrong() { throw new Error('network'); } } });
  assert.equal(await vm.runInContext('loadProfile()', ctx), null);
  assert.equal(calls.signOut, 1);
});

test('an admin with a passkey session (or a user with no old factor) loads the profile as before', async () => {
  const { ctx, calls } = load({ mfa: { async ensureStrong() { return true; }, async strong() { return true; } } });
  const p = await vm.runInContext('loadProfile()', ctx);
  assert.equal(p.role, 'admin');
  assert.equal(calls.signOut, 0);
});

test('pages without mfa.js are unchanged', async () => {
  const { ctx, calls } = load({});
  assert.equal((await vm.runInContext('loadProfile()', ctx)).id, 'u1');
  assert.equal(calls.signOut, 0);
});

test('an admin signed in with only a password must confirm a passkey, or is signed out', async () => {
  let prompted = 0;
  const { ctx, calls, location } = load({ mfa: { async ensureStrong() { return true; }, async strong() { return false; }, async promptPasskey() { prompted++; return false; } } });
  assert.equal(await vm.runInContext('loadProfile()', ctx), null);
  assert.equal(prompted, 1);
  assert.equal(calls.signOut, 1);
  assert.equal(location.href, 'login.html');
});

test('a Freelancer with no old factor is not asked for a passkey to open the desk', async () => {
  let prompted = 0;
  const { ctx, calls } = load({ profile: { id: 'u1', role: 'creator', account_status: 'active' }, mfa: { async ensureStrong() { return true; }, async strong() { return false; }, async promptPasskey() { prompted++; return false; } } });
  assert.equal((await vm.runInContext('loadProfile()', ctx)).role, 'creator');
  assert.equal(prompted, 0);
  assert.equal(calls.signOut, 0);
});
