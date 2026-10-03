import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decimalToCents, decimalToScaledInteger, formatCents, satsToUsdCents, usdCentsToSats, usdToSats } from './money.mjs';

test('Lightning invoice sats use exact decimal conversion and round up', () => {
  assert.equal(usdToSats('10.00', '83948.8'), 11913);
  assert.equal(usdToSats('0.01', '83948.8'), 12);
});

test('withdrawal satoshi conversion uses integer cents and explicit floor rounding', () => {
  assert.equal(usdCentsToSats(11640, '100000', 'floor'), 116400);
  assert.equal(usdCentsToSats(11640, '100000.5', 'floor'), 116399);
  assert.equal(usdCentsToSats(1, '83948.8', 'ceil'), 12);
});

test('satoshi-to-dollar conversion rounds to cents without floating point', () => {
  assert.equal(satsToUsdCents(116400, '100000'), 11640);
  assert.equal(formatCents(satsToUsdCents(1, '100000')), '0.00');
  assert.equal(formatCents(satsToUsdCents(5, '100000')), '0.01');
});

test('decimal dollar and percentage parsing is exact and bounded to integer units', () => {
  assert.equal(decimalToCents('123.456'), 12346);
  assert.equal(decimalToCents('1e2'), 10000);
  assert.equal(decimalToScaledInteger('3.335', 2), 334n);
  assert.equal(formatCents(-5), '-0.05');
  assert.throws(() => decimalToCents('Infinity'), /Invalid decimal/);
});
