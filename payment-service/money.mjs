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

function safeInteger(value, message) {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RangeError(message);
  return result;
}

// Decimal dollars (string or numeric text) to integer cents. 'half-up'
// (default) matches Postgres round(x, 2) for non-negative amounts; 'floor'
// is for "how much of this balance may be spent".
export function decimalToCents(value, mode = 'half-up') {
  const { numerator, denominator } = decimalFraction(value);
  return safeInteger(divideRounded(numerator * 100n, denominator, mode), 'Dollar amount is out of range');
}

// A user-typed dollar amount with at most two decimals ("12", "12.3",
// "12.34") to integer cents, exactly. Anything else is null.
export function parseUsdCents(value) {
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return safeInteger(BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0')), 'Dollar amount is out of range');
}

// The database's amount_after_fee = round(amount * (1 - fee/100), 2), in
// integer cents with exact decimal fee arithmetic (no float bps rounding).
export function splitFeeCents(amountCents, feePercent) {
  const amount = BigInt(amountCents);
  const fee = decimalFraction(feePercent);
  if (amount < 0n || fee.numerator < 0n || fee.numerator > 100n * fee.denominator) {
    throw new RangeError('Amount must be nonnegative and the fee between 0 and 100 percent');
  }
  const send = divideRounded(amount * (100n * fee.denominator - fee.numerator), 100n * fee.denominator, 'half-up');
  const sendCents = safeInteger(send, 'Dollar amount is out of range');
  return { sendCents, feeCents: safeInteger(amount - send, 'Dollar amount is out of range') };
}

export function usdToSats(usd, btcUsdRate) {
  const amount = decimalFraction(usd);
  const rate = decimalFraction(btcUsdRate);
  if (amount.numerator < 0n || rate.numerator <= 0n) throw new RangeError('Amount and BTC/USD rate must be nonnegative and positive');
  const sats = divideRounded(amount.numerator * rate.denominator * 100_000_000n, amount.denominator * rate.numerator, 'ceil');
  return safeInteger(sats, 'Satoshi amount is out of range');
}

export function formatCents(value) {
  const cents = BigInt(value);
  const sign = cents < 0n ? '-' : '';
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

export function usdCentsToSats(cents, btcUsdRate, mode = 'floor') {
  const amountCents = BigInt(cents);
  const rate = decimalFraction(btcUsdRate);
  if (amountCents < 0n || rate.numerator <= 0n) throw new RangeError('Amount and BTC/USD rate must be nonnegative and positive');
  const sats = divideRounded(amountCents * 1_000_000n * rate.denominator, rate.numerator, mode);
  return safeInteger(sats, 'Satoshi amount is out of range');
}

export function satsToUsdCents(sats, btcUsdRate) {
  const amountSats = BigInt(sats);
  const rate = decimalFraction(btcUsdRate);
  if (amountSats < 0n || rate.numerator <= 0n) throw new RangeError('Amount and BTC/USD rate must be nonnegative and positive');
  return safeInteger(
    divideRounded(amountSats * rate.numerator * 100n, rate.denominator * 100_000_000n, 'half-up'),
    'Dollar amount is out of range',
  );
}
