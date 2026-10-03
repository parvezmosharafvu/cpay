function decimalFraction(value) {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(String(value ?? '').trim());
  if (!match) throw new RangeError('Invalid decimal amount');
  const exponent = Number(match[4] ?? 0);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 100) throw new RangeError('Decimal exponent is out of range');
  const fractionDigits = match[3] ?? '';
  let numerator = BigInt(`${match[2]}${fractionDigits}`);
  let scale = fractionDigits.length - exponent;
  if (scale < 0) {
    numerator *= 10n ** BigInt(-scale);
    scale = 0;
  }
  if (match[1] === '-') numerator = -numerator;
  return { numerator, denominator: 10n ** BigInt(scale) };
}

function divideRounded(numerator, denominator, mode) {
  if (denominator <= 0n) throw new RangeError('Denominator must be positive');
  if (numerator < 0n) {
    if (mode === 'floor') {
      const positive = -numerator;
      return -((positive + denominator - 1n) / denominator);
    }
    return -divideRounded(-numerator, denominator, mode);
  }
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (mode === 'ceil') return quotient + (remainder === 0n ? 0n : 1n);
  if (mode === 'half-up') return quotient + (remainder * 2n >= denominator ? 1n : 0n);
  return quotient;
}

export function decimalToScaledInteger(value, scale, mode = 'half-up') {
  const { numerator, denominator } = decimalFraction(value);
  return divideRounded(numerator * 10n ** BigInt(scale), denominator, mode);
}

export function decimalToCents(value) {
  const cents = decimalToScaledInteger(value, 2);
  const result = Number(cents);
  if (!Number.isSafeInteger(result)) throw new RangeError('Dollar amount is out of range');
  return result;
}

export function formatCents(value) {
  const cents = BigInt(value);
  const sign = cents < 0n ? '-' : '';
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

export function usdToSats(usd, btcUsdRate) {
  const amount = decimalFraction(usd);
  const rate = decimalFraction(btcUsdRate);
  if (amount.numerator < 0n || rate.numerator <= 0n) throw new RangeError('Amount and BTC/USD rate must be nonnegative and positive');
  const sats = divideRounded(amount.numerator * rate.denominator * 100_000_000n, amount.denominator * rate.numerator, 'ceil');
  const result = Number(sats);
  if (!Number.isSafeInteger(result)) throw new RangeError('Satoshi amount is out of range');
  return result;
}

export function usdCentsToSats(cents, btcUsdRate, mode = 'floor') {
  const amountCents = BigInt(cents);
  const rate = decimalFraction(btcUsdRate);
  if (amountCents < 0n || rate.numerator <= 0n) throw new RangeError('Amount and BTC/USD rate must be nonnegative and positive');
  const sats = divideRounded(amountCents * 1_000_000n * rate.denominator, rate.numerator, mode);
  const result = Number(sats);
  if (!Number.isSafeInteger(result)) throw new RangeError('Satoshi amount is out of range');
  return result;
}

export function satsToUsdCents(sats, btcUsdRate) {
  const amountSats = BigInt(sats);
  const rate = decimalFraction(btcUsdRate);
  if (amountSats < 0n || rate.numerator <= 0n) throw new RangeError('Amount and BTC/USD rate must be nonnegative and positive');
  return decimalToSafeNumber(divideRounded(amountSats * rate.numerator * 100n, rate.denominator * 100_000_000n, 'half-up'));
}

function decimalToSafeNumber(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RangeError('Dollar amount is out of range');
  return result;
}
