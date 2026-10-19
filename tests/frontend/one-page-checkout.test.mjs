import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// One-page checkout (20261020): the payment link page (404.html) shows the
// invoice view in place. Its <template> must carry exactly the markup of
// invoice-cpay-v2.html, which stays as the entry for older invoice links.
const read = (f) => readFileSync(new URL(`../../public/${f}`, import.meta.url), 'utf8');
const between = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i); return i < 0 || j < 0 ? null : s.slice(i, j + b.length); };
const START = '<!-- LOADING / ERROR / EXPIRED / FAILED';
const END = '<div id="toast" class="float-toast" role="status" aria-live="polite"></div>';

test('the link page template and the invoice page share one invoice markup', () => {
  const page = between(read('404.html'), START, END);
  const inv = between(read('invoice-cpay-v2.html'), START, END);
  assert.ok(page && inv, 'markers present on both pages');
  assert.equal(page, inv);
  assert.match(read('404.html'), /<template id="invoiceView">/);
});

test('both pages load the shared invoice script with pinned libraries', () => {
  for (const f of ['404.html', 'invoice-cpay-v2.html']) {
    const html = read(f);
    assert.match(html, /invoice-view\.js/);
    assert.match(html, /qrcode\.min\.js" integrity="sha384-/);
    assert.match(html, /supabase\.js" integrity="sha384-/);
    assert.match(html, /turnstile\.js/);
    assert.match(html, /wallets-config\.js/);
  }
  assert.match(read('404.html'), /CPAY_INVOICE_EMBEDDED = true/);
});

test('the invoice script keeps its names to itself and names no processor', () => {
  const js = read('invoice-view.js');
  assert.match(js, /^\/\/[^\n]*\n(\/\/[^\n]*\n)*\(function\(\)\{/);
  assert.match(js, /window\.cpayInvoice = \{ start \}/);
  assert.doesNotMatch(js + read('404.html'), /breez|bkash|nagad|binance|\bbank\b|boltpay/i);
});

test('the link page opens the invoice on its own address', () => {
  const html = read('404.html');
  assert.match(html, /function invoiceUrl\(id, settlement\)\{\n  return '\/' \+ encodeURIComponent\(slug\) \+ '\?id='/);
  assert.doesNotMatch(html, /window\.location\.href = invoiceUrl/);
});
