import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../public/invoice-view.js', import.meta.url), 'utf8');
const fixture = source.replace('window.cpayInvoice = { start };',
  'window.cpayInvoice = { start, test: { bolt11ExpiryMs, effectiveInvoiceExpiryMs } };');
const context = {
  window: { CPAY_INVOICE_EMBEDDED: true },
  document: { addEventListener() {} },
};
vm.runInNewContext(fixture, context);
const { bolt11ExpiryMs, effectiveInvoiceExpiryMs } = context.window.cpayInvoice.test;

const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const intWords = (n, count) => Array.from({ length: count }, (_, i) =>
  Math.floor(n / (32 ** (count - i - 1))) % 32);
function polymod(words) {
  let chk = 1;
  for (const word of words) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ word;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= generators[i];
  }
  return chk >>> 0;
}
function makeInvoice(timestamp, expirySeconds, hrp = 'lnbc') {
  const words = intWords(timestamp, 7);
  if (expirySeconds !== null) words.push(6, 0, 4, ...intWords(expirySeconds, 4));
  words.push(...Array(104).fill(0)); // Dummy signature: tests only parse BOLT11 metadata.
  const chars = [...hrp].map((c) => c.charCodeAt(0));
  const expansion = [...chars.map((c) => c >> 5), 0, ...chars.map((c) => c & 31)];
  const checksum = polymod([...expansion, ...words, ...Array(6).fill(0)]) ^ 1;
  const check = Array.from({ length: 6 }, (_, i) => (checksum >>> (5 * (5 - i))) & 31);
  return hrp + '1' + [...words, ...check].map((w) => alphabet[w]).join('');
}

test('Blink BOLT11 with 240s expiry overrides the CPAY 300s timer', () => {
  const start = 1793200000;
  const invoice = makeInvoice(start, 240);
  const server = new Date((start + 300) * 1000).toISOString();
  assert.equal(bolt11ExpiryMs(invoice), (start + 240) * 1000);
  assert.equal(effectiveInvoiceExpiryMs(server, invoice), (start + 240) * 1000);
});

test('earlier server expiration is retained; no invoice extension', () => {
  const start = 1793200000;
  const invoice = makeInvoice(start, 3600);
  assert.equal(effectiveInvoiceExpiryMs(new Date((start + 300) * 1000).toISOString(), invoice),
    (start + 300) * 1000);
});

test('BOLT11 default expiry is one hour when x tag is absent', () => {
  const start = 1793200000;
  assert.equal(bolt11ExpiryMs(makeInvoice(start, null)), (start + 3600) * 1000);
});

test('valid mixed case prefix is accepted but mixed case Bech32 is rejected', () => {
  const start = 1793200000;
  const invoice = makeInvoice(start, 240);
  assert.equal(bolt11ExpiryMs('lightning:' + invoice), (start + 240) * 1000);
  assert.equal(bolt11ExpiryMs(invoice.slice(0, 10).toUpperCase() + invoice.slice(10)), null);
});

test('broken checksum and non-BOLT11 source fall back to server deadline', () => {
  const invoice = makeInvoice(1793200000, 240);
  const server = '2026-10-28T20:00:00.000Z';
  const broken = invoice.slice(0, -1) + (invoice.endsWith('q') ? 'p' : 'q');
  assert.equal(bolt11ExpiryMs(broken), null);
  assert.equal(effectiveInvoiceExpiryMs(server, broken), Date.parse(server));
  assert.equal(effectiveInvoiceExpiryMs(server, 'not-an-invoice'), Date.parse(server));
});

test('the checkout timer uses the effective BOLT11 expiration, not server time alone', () => {
  assert.match(source, /const expiryMs = effectiveInvoiceExpiryMs\(expiresAt, currentPayCode\);/);
});
