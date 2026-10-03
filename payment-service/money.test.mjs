import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decimalToCents, formatCents, satsToUsdCents, usdCentsToSats, usdToSats } from './money.mjs';

test('USD cents convert to sats with exact decimal rates and explicit floor rounding', () => {
  assert.equal(usdCentsToSats(250001, '80000.32', 'floor'), 3_125_000);
  assert.equal(usdCentsToSats(11640, '100000.5', 'floor'), 116399);
  assert.equal(usdToSats('2.67500000', '100000'), 2675);
});

test('satoshi and decimal USD values round to cents without floating point', () => {
  assert.equal(formatCents(satsToUsdCents(1015, '100000')), '1.02');
  assert.equal(formatCents(satsToUsdCents(2675, '100000')), '2.68');
  assert.equal(formatCents(satsToUsdCents(5015, '100000')), '5.02');
  assert.equal(formatCents(decimalToCents('2.67500000')), '2.68');
});
