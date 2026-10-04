import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const context = vm.createContext({ window: {} });
vm.runInContext(readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8'), context);
const escapeHtml = context.window.CPAY_APP.escapeHtml;

test('escapeHtml encodes HTML-significant characters', () => {
  assert.equal(escapeHtml('& < > " \''), '&amp; &lt; &gt; &quot; &#39;');
});

test('escapeHtml neutralizes markup in user-controlled text', () => {
  assert.equal(
    escapeHtml('<img src=x onerror="alert(1)">'),
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;',
  );
});

test('escapeHtml handles nullish and non-string values', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml(false), 'false');
});

test('admin payment rows render user-controlled values as DOM text', async () => {
  class Element {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.dataset = {};
    }
    set innerHTML(_) { throw new Error('innerHTML must not be used'); }
    set textContent(value) { this.text = String(value ?? ''); }
    append(child) { this.children.push(child); }
    replaceChildren(...children) { this.children = children; }
    querySelectorAll(selector) {
      const found = [];
      const visit = (node) => {
        if (selector === '[data-pay]' && Object.hasOwn(node.dataset, 'pay')) found.push(node);
        node.children.forEach(visit);
      };
      visit(this);
      return found;
    }
  }

  const root = new Element('root');
  const payload = '<img src=x onerror=alert(1)>';
  const context = vm.createContext({
    window: {},
    document: {
      createElement: (tagName) => new Element(tagName),
      getElementById: (id) => id === 'payments' ? root : null,
    },
    sb: { rpc: async () => ({ data: [{
      id: `"><${payload}`,
      status: payload,
      amount_requested: 1,
      creator_name: payload,
      link_slug: payload,
      invoice_ref: payload,
    }], error: null }) },
    setTimeout: () => {},
  });
  vm.runInContext(readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8'), context);
  vm.runInContext(readFileSync(new URL('../../public/admin-unify.js', import.meta.url), 'utf8'), context);
  await vm.runInContext('renderPayments()', context);

  const elements = [];
  const visit = (node) => {
    elements.push(node);
    node.children.forEach(visit);
  };
  visit(root);
  assert.equal(elements.some((element) => element.tagName === 'img'), false);
  assert.equal(elements.some((element) => element.text === payload), true);
  assert.equal(elements.some((element) => element.dataset.pay === `"><${payload}`), true);
});

// The admin-actions root has no handler (404); the wallet must go straight
// to the /admin-wallet route, once, with no root probe or fallback.
async function loadWalletRoute(responder) {
  const calls = [];
  const ctx = vm.createContext({
    window: {
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_ANON_KEY: 'anon',
      supabaseClient: { auth: { getSession: async () => ({ data: { session: { access_token: 't' } } }) } },
    },
    fetch: async (url, init) => { calls.push({ url, init }); return responder(url); },
  });
  vm.runInContext(readFileSync(new URL('../../public/admin-wallet-route.js', import.meta.url), 'utf8'), ctx);
  return { ctx, calls };
}

test('walletCall posts to admin-actions/admin-wallet directly', async () => {
  const { ctx, calls } = await loadWalletRoute(() => ({ ok: true, status: 200, json: async () => ({ balanceSats: 5 }) }));
  const data = await ctx.walletCall('info', { page: 2 });
  assert.equal(data.balanceSats, 5);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.supabase.co/functions/v1/admin-actions/admin-wallet');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { action: 'info', page: 2 });
  assert.equal(calls[0].init.headers.Authorization, 'Bearer t');
});

test('walletCall surfaces an error without retrying another path', async () => {
  const { ctx, calls } = await loadWalletRoute(() => ({ ok: false, status: 404, json: async () => ({ error: 'Not found' }) }));
  await assert.rejects(ctx.walletCall('info'), (e) => e.status === 404 && /Not found/.test(e.message));
  assert.equal(calls.length, 1);
});

test('no page script calls the bare admin-actions root', () => {
  for (const name of ['admin-wallet.js', 'admin-wallet-route.js', 'admin-unify.js', 'admin-home-live.js', 'app.js']) {
    const src = readFileSync(new URL(`../../public/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /['"`]admin-actions['"`]/, `${name} names the admin-actions root`);
    assert.doesNotMatch(src, /functions\/v1\/admin-actions['"`]/, `${name} fetches the admin-actions root`);
  }
});
