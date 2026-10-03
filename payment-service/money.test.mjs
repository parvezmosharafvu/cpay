import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decimalToCents, formatCents, satsToUsdCents, usdCentsToSats } from './money.mjs';

test('USD-cent to sat conversion uses exact decimal division and floor rounding', () => {
  assert.equal(usdCentsToSats(250_001, 80_000.32, 'floor'), 3_125_000);
  assert.equal(usdCentsToSats(112, 100_000, 'floor'), 1120);
});

test('money formatting preserves exact half-up rounding', () => {
  assert.equal(formatCents(satsToUsdCents(1015, 100_000)), '1.02');
  assert.equal(formatCents(decimalToCents('2.67500000')), '2.68');
  assert.equal(formatCents(satsToUsdCents(5015, 100_000)), '5.02');
});
