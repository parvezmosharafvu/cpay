import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = (f) => readFileSync(new URL(`../../public/${f}`, import.meta.url), 'utf8');

function fixture() {
  class Element {
    constructor() { this.dataset = {}; this.attrs = {}; this.events = {}; this.children = []; }
    append(child) { this.children.push(child); child.parentNode = this; }
    insertBefore(child) { this.children.unshift(child); child.parentNode = this; }
    setAttribute(k, v) { this.attrs[k] = v; }
    addEventListener(k, fn) { this.events[k] = fn; }
    closest() { return null; }
  }
  const input = new Element(); input.type = 'password'; input.id = 'password';
  // Presentation helpers must not read the password, log it, or send it.
  Object.defineProperty(input, 'value', { get() { throw new Error('password value read'); } });
  const field = new Element(); field.append(input);
  let clicks = 0, translated = false;
  const submit = new Element(); submit.click = () => { clicks++; };
  const events = {};
  vm.runInNewContext(read('auth-ui.js'), { window: { cpayI18n: { t: (s) => translated ? `bn:${s}` : s } }, document: {
    readyState: 'complete', querySelectorAll: () => [input], createElement: () => new Element(),
    addEventListener(k, fn) { events[k] = fn; }, getElementById: (id) => id === 'submitBtn' ? submit : null,
  }});
  return { input, submit, toggle: field.children[0].children[1], events,
    translated() { translated = true; events['cpay:lang'](); }, clicks: () => clicks };
}

test('password visibility toggles without inspecting the password and follows language changes', () => {
  const f = fixture();
  assert.equal(f.toggle.attrs['aria-controls'], 'password');
  assert.equal(f.toggle.attrs['aria-pressed'], 'false');
  assert.equal(f.input.type, 'password');
  f.toggle.events.click();
  assert.equal(f.input.type, 'text');
  assert.equal(f.toggle.attrs['aria-pressed'], 'true');
  assert.equal(f.toggle.attrs['aria-label'], 'Hide password');
  f.translated();
  assert.equal(f.toggle.textContent, 'bn:Hide');
  f.toggle.events.click();
  assert.equal(f.input.type, 'password');
  assert.equal(f.toggle.attrs['aria-label'], 'bn:Show password');
});

test('Enter uses the existing action; disabled, hidden, composition and modified keys cannot submit', () => {
  const f = fixture();
  const target = { dataset: { enterSubmit: 'submitBtn' } };
  const press = (extra = {}) => { let prevented = false; f.events.keydown({ key: 'Enter', target, preventDefault() { prevented = true; }, ...extra }); return prevented; };
  assert.equal(press(), true);
  assert.equal(f.clicks(), 1);
  for (const extra of [{ isComposing: true }, { defaultPrevented: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }, { metaKey: true }, { key: 'Escape' }]) assert.equal(press(extra), false);
  f.submit.disabled = true; assert.equal(press(), false);
  f.submit.disabled = false; f.submit.closest = () => ({}); assert.equal(press(), false);
  assert.equal(f.clicks(), 1);
});

test('lamp starts with the form available and can still be explicitly toggled', () => {
  const classes = new Set(), attrs = new Map([['inert', ''], ['aria-hidden', 'true']]), handlers = {};
  const chain = { dataset: {}, getAttribute: () => 'loginCard', setAttribute: (k,v) => attrs.set(k,v), addEventListener: (k,fn) => { handlers[k] = fn; }, focus() {} };
  const region = { removeAttribute: (k) => attrs.delete(k), setAttribute: (k,v) => attrs.set(k,v), contains: () => false, addEventListener() {}, querySelectorAll: () => [] };
  const lamp = { classList: { add() {}, remove() {} } };
  const window = { matchMedia: () => ({ matches: true }), addEventListener() {} };
  vm.runInNewContext(read('lamp.js'), { window, document: {
    readyState: 'complete', documentElement: { classList: { add: (k) => classes.add(k), remove: (k) => classes.delete(k), toggle: (k,on) => on ? classes.add(k) : classes.delete(k) } },
    getElementById: (id) => id === 'lampChain' ? chain : { closest: () => region }, querySelector: () => lamp,
  }, location: { hash: '', search: '' }, URLSearchParams, setTimeout() {} });
  assert.equal(window.cpayLamp.isOn(), true);
  assert.equal(attrs.has('inert'), false);
  assert.equal(attrs.has('aria-hidden'), false);
  assert.equal(classes.has('lamp-on'), true);
  handlers.click();
  assert.equal(window.cpayLamp.isOn(), false);
  assert.equal(attrs.get('inert'), '');
  window.cpayLamp.open();
  assert.equal(attrs.has('inert'), false);
});
