// Every database read and write the payment service makes. `db` is a pg
// Pool or Client.

function decimalFraction(value) {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(String(value).trim());
  if (!match) return null;
  const sign = match[1] === '-' ? -1n : 1n;
  const digits = BigInt(`${match[2]}${match[3] ?? ''}`) * sign;
  const scale = (match[3]?.length ?? 0) - Number(match[4] ?? 0);
  return scale >= 0
    ? { numerator: digits, denominator: 10n ** BigInt(scale) }
    : { numerator: digits * 10n ** BigInt(-scale), denominator: 1n };
}

export function usdToSats(usd, btcUsdRate) {
  const amount = decimalFraction(usd);
  const rate = decimalFraction(btcUsdRate);
  if (!amount || !rate || rate.numerator <= 0n) return NaN;
  const numerator = amount.numerator * 100_000_000n * rate.denominator;
  const denominator = amount.denominator * rate.numerator;
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return Number(quotient + (remainder > 0n ? 1n : 0n));
}

export async function invoiceRow(db, paymentId) {
  const { rows } = await db.query(
    `select id, status, amount_requested, expires_at, lightning_invoice, invoice_ref, amount_sat
       from payments where id = $1`,
    [paymentId],
  );
  return rows[0] ?? null;
}

// Returns false when the row already has an invoice (a concurrent request
// won) or no longer exists (create-invoice gave up and deleted it).
export async function attachInvoice(db, { paymentId, paymentHash, bolt11, amountSat, btcUsdRate }) {
  const { rowCount } = await db.query(
    `update payments
        set invoice_ref = $2, lightning_invoice = $3, amount_sat = $4, btc_usd_rate = $5
      where id = $1 and lightning_invoice is null and status = 'new'`,
    [paymentId, paymentHash, bolt11, amountSat, btcUsdRate],
  );
  return rowCount === 1;
}

// The Lightning payment hash of a received Breez payment, or null for
// receives that did not come through a cpay bolt11 (a plain Spark transfer
// or an on-chain deposit).
export function paymentHashOf(payment) {
  const d = payment.details;
  if (d?.type === 'lightning') return d.htlcDetails?.paymentHash ?? null;
  if (d?.type === 'spark') return d.htlcDetails?.paymentHash ?? null;
  return null;
}

export async function settlePayment(db, payment) {
  if (payment.paymentType !== 'receive' || payment.status !== 'completed') return 'ignored';
  const hash = paymentHashOf(payment);
  if (!hash) return 'no_hash';
  const { rows } = await db.query('select settle_breez_payment($1, $2, $3) as outcome', [
    payment.id,
    hash,
    String(payment.amount),
  ]);
  return rows[0].outcome;
}

// Lower bound, in unix seconds, for the catch-up scan: the oldest unsettled
// Breez invoice from the last 7 days, minus an hour in case the database
// clock runs ahead of Spark's. Null means nothing can be waiting.
export async function catchUpSince(db) {
  const { rows } = await db.query(
    `select extract(epoch from min(created_at) - interval '1 hour')::bigint as since
       from payments
      where status in ('new', 'pending', 'expired')
        and amount_sat is not null
        and created_at > now() - interval '7 days'`,
  );
  return rows[0].since == null ? null : Number(rows[0].since);
}

// The old provider flipped unpaid invoices to 'expired'. A payment that
// still arrives later settles anyway: settle_breez_payment accepts
// 'expired' rows, because the money is in the cpay wallet.
export async function expireUnpaid(db) {
  const { rowCount } = await db.query(
    `update payments set status = 'expired'
      where status = 'new' and amount_sat is not null and expires_at < now()`,
  );
  return rowCount;
}
