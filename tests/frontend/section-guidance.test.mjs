import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../../public/shell.js', import.meta.url), 'utf8');
function desk(admin) {
  const events = {};
  const observers = [];
  let tab = 'home';
  let label = 'Overview';
  let bangla = false;
  const title = { textContent: '' };
  const hint = { textContent: '', hidden: true };
  const side = {
    querySelector: () => ({ dataset: { tab }, querySelector: () => ({ textContent: label }) }),
    querySelectorAll: () => [],
  };
  const document = {
    querySelector: (selector) => selector === '.shell' ? {} : selector === '.side' ? side : null,
    querySelectorAll: () => [],
    getElementById: (id) => ({ pageTitle: title, sectionHint: hint, adminMain: admin ? {} : null })[id],
    addEventListener: (name, fn) => { events[name] = fn; },
  };
  vm.runInNewContext(script, {
    document,
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }),
      cpayI18n: { t: (text) => bangla && text ? `bn:${text}` : text } },
    MutationObserver: class { constructor(fn) { observers.push(fn); } observe() {} },
  });
  return { title, hint, route(next, text = next) { tab = next; label = text; observers[0](); },
    language() { bangla = true; events['cpay:lang'](); }, sync() { observers[0](); } };
}

test('every desk section has context; admin and member overview use their own copy', () => {
  for (const admin of [false, true]) {
    const d = desk(admin);
    const routes = admin
      ? ['home','daily','people','apps','chat','payments','payouts','locations','forwards','links','wallet','health','receipts','system','audit','settings','security','guide']
      : ['home','links','pay','cash','chat','profile','security'];
    for (const route of routes) {
      d.route(route);
      assert.ok(d.hint.textContent, route);
      assert.equal(d.hint.hidden, false, route);
    }
    d.route('home');
    assert.match(d.hint.textContent, admin ? /platform activity/ : /Your balance/);
  }
});

test('language changes update context and translated navigation updates the heading', () => {
  const d = desk(false);
  d.route('pay', 'Payments (2)');
  assert.equal(d.title.textContent, 'Payments');
  d.language();
  assert.match(d.hint.textContent, /^bn:/);
  d.route('pay', 'পেমেন্ট');
  assert.equal(d.title.textContent, 'পেমেন্ট');
  const text = d.hint.textContent;
  d.sync();
  assert.equal(d.hint.textContent, text);
  d.route('future-route');
  assert.equal(d.hint.hidden, true);
});
