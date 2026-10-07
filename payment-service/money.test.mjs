import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decimalToCents, formatCents, parseUsdCents, satsToUsdCents, splitFeeCents, usdCentsToSats, usdToSats } from './money.mjs';
import { parseAmountCents, splitFee } from './withdraw.mjs';

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

test('typed dollar amounts parse to integer cents exactly', () => {
  assert.equal(parseUsdCents('4.35'), 435); // 4.35 * 100 = 434.99999999999994 in floats
  assert.equal(parseUsdCents('1.1'), 110);
  assert.equal(parseUsdCents('  12 '), 1200);
  assert.equal(parseUsdCents('0.07'), 7);
  for (const bad of ['', '1.', '.5', '1.234', '-1', '1e3', 'NaN', 'Infinity', '0x10', '1,00', null, undefined]) {
    assert.equal(parseUsdCents(bad), null, String(bad));
  }
  assert.equal(parseAmountCents('9999999999999999'), null); // out of range -> null, never a float
  assert.equal(parseAmountCents('19.99'), 1999);
});

test('balances floor to cents for spending checks and half-up for display', () => {
  assert.equal(decimalToCents('10.00500000', 'floor'), 1000);
  assert.equal(decimalToCents('10.00500000'), 1001);
  assert.equal(decimalToCents('0.00999999', 'floor'), 0);
  assert.equal(decimalToCents('-0.01', 'floor'), -1);
});

test('fee split is exact decimal arithmetic and always sums to the amount', () => {
  assert.deepEqual(splitFeeCents(10000, '2.125'), { sendCents: 9788, feeCents: 212 }); // 97.875 -> 97.88
  assert.deepEqual(splitFeeCents(10000, '0.145'), { sendCents: 9986, feeCents: 14 }); // 99.855 -> 99.86
  assert.deepEqual(splitFee(500, '0'), { sendCents: 500, feeCents: 0 });
  assert.deepEqual(splitFee(500, '100'), { sendCents: 0, feeCents: 500 });
  assert.throws(() => splitFeeCents(500, '100.01'), RangeError);
  assert.throws(() => splitFeeCents(500, '-1'), RangeError);
  for (let c = 500; c <= 2000; c += 7) {
    const { sendCents, feeCents } = splitFeeCents(c, '3.33');
    assert.equal(sendCents + feeCents, c);
  }
});
