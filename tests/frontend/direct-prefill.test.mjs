// node --test tests/frontend/direct-prefill.test.mjs
//
// public/direct-settlement.js: CPAY Wallet opens dashboard.html#direct=<address>.
// Only a plain Lightning address is taken, it is removed from the address
// bar, and it survives one trip through the login page (this tab, 10 min).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../../public/direct-settlement.js', import.meta.url), 'utf8');

function load(hash, store = new Map(), now = Date.now()) {
  const replaced = [];
  const window = {};
  const ctx = {
    window,
    location: { hash, pathname: '/dashboard.html', search: '' },
    history: { replaceState: (_s, _t, url) => replaced.push(url) },
    sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
    Date: { now: () => now },
  };
  vm.runInNewContext(src, ctx);
  return { direct: window.cpayDirect, replaced, store };
}

test('a plain address is taken, lowercased, and removed from the address bar', () => {
  const r = load('#direct=Alice.Shop%40Pay-Cashapp.Buzz');
  assert.equal(r.direct.hasPrefill(), true);
  assert.deepEqual(r.replaced, ['/dashboard.html']);
  assert.equal(JSON.parse(r.store.get('cpay-direct-prefill')).a, 'alice.shop@pay-cashapp.buzz');
});

test('anything else is ignored (and still removed from the address bar)', () => {
  for (const h of ['#direct=%3Cimg%20src%3Dx%3E%40a.com', '#direct=alice', '#direct=a%40b', '#direct=%E0%A4%A', '#direct=a@b.com&x=1', '#direct=javascript%3Aalert(1)%40a.com']) {
    const r = load(h);
    assert.equal(r.direct.hasPrefill(), false, h);
    assert.equal(r.store.size, 0, h);
  }
  assert.equal(load('').direct.hasPrefill(), false);
  assert.equal(load('#pay').replaced.length, 0, 'other hashes are left alone');
});

test('it survives the login page for 10 minutes in this tab, not longer', () => {
  const store = new Map();
  const t0 = 1_800_000_000_000;
  load('#direct=bob%40pay.example.com', store, t0);
  assert.equal(load('', store, t0 + 60_000).direct.hasPrefill(), true);
  assert.equal(load('', store, t0 + 601_000).direct.hasPrefill(), false);
  assert.equal(store.size, 0, 'expired: removed');
});
