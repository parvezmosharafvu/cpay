import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('../../public/', import.meta.url);
const read = (name) => readFileSync(new URL(name, root), 'utf8');

test('cpay.css exposes Chat 2 design tokens and components', () => {
  const css = read('cpay.css');
  for (const token of ['--space-1', '--touch', '--z-modal', '.skeleton', '.status-timeline', '.alert-danger', '.skip-link']) {
    assert.match(css, new RegExp(token.replace('.', '\\.')), `missing ${token}`);
  }
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /max-width:\s*320px/);
});

test('a11y.css keeps 44px touch targets', () => {
  const css = read('a11y.css');
  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /prefers-reduced-motion/);
});

test('public journey pages link design system and a11y', () => {
  for (const page of ['index.html', 'login.html', 'register.html', 'reset.html', 'store.html', '404.html', 'invoice-cpay-v2.html']) {
    const html = read(page);
    assert.match(html, /cpay\.css/, `${page} missing cpay.css`);
    assert.match(html, /a11y\.css/, `${page} missing a11y.css`);
    assert.match(html, /color-scheme/, `${page} missing color-scheme`);
    assert.match(html, /skip-link/, `${page} missing skip link`);
  }
});

test('invoice page has timeline, QR download, share and copy controls', () => {
  const html = read('invoice-cpay-v2.html');
  assert.match(html, /id="statusTimeline"/);
  assert.match(html, /id="downloadQrBtn"/);
  assert.match(html, /id="shareInvoiceBtn"/);
  assert.match(html, /id="copyBtn"/);
  assert.match(html, /id="timerPill"/);
  assert.match(html, /function downloadQr/);
  assert.match(html, /function updateTimeline/);
  // Must not leak processor or traditional payout ads
  assert.doesNotMatch(html, /breez/i);
  assert.doesNotMatch(html, /bkash|nagad|binance|\bbank\b/i);
});

test('payment slug page keeps reserved routing and retry', () => {
  const html = read('404.html');
  assert.match(html, /RESERVED/);
  assert.match(html, /id="loadRetryBtn"/);
  assert.match(html, /get_link_preview/);
  assert.doesNotMatch(html, /breez/i);
});

test('auth alerts use role=alert and hidden attribute', () => {
  for (const page of ['login.html', 'register.html', 'reset.html']) {
    const html = read(page);
    assert.match(html, /role="alert"/, `${page} missing role=alert`);
    assert.match(html, /id="errorMsg"[^>]*\bhidden\b|\bhidden\b[^>]*id="errorMsg"/, `${page} errorMsg should use hidden`);
  }
});

test('public HTML files do not embed stack traces or wallet secrets', () => {
  const dir = new URL('../../public/', import.meta.url).pathname;
  for (const name of readdirSync(dir)) {
    if (!/\.(html|js|css)$/.test(name)) continue;
    const src = readFileSync(join(dir, name), 'utf8');
    assert.doesNotMatch(src, /BREEZ_MNEMONIC|PAYMENT_SERVICE_SECRET|service_role/i, name);
    assert.doesNotMatch(src, /at Object\.<anonymous>|Error: ENOENT/, name);
  }
});
