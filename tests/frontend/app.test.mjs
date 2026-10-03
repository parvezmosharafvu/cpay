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
