// Instant stablecoin withdrawals: route catalog, quotes, confirm and
// reconcile. `breez` is the connected SDK (or a fake in tests), `db` a pg
// Pool, `btcUsdRate` an async function returning USD per BTC.

import { randomUUID } from 'node:crypto';

export const ROUTE_CACHE_MS = 10 * 60 * 1000;
// A 'sending' row with no Breez payment is refunded only once its quote has
// expired by this much: after expiry the SDK refuses to start the send, so
// a payment that has not appeared by then never will.
export const ORPHAN_GRACE_MS = 10 * 60 * 1000;
const QUOTE_MARGIN_MS = 5_000;
const MAX_SLIPPAGE_BPS = 100;

// For a send, Orchestra lists routes by address family alone and Boltz only
// checks the address is well formed, so one placeholder per family lists
// every route.
const PLACEHOLDER = {
  evm: '0x000000000000000000000000000000000000dEaD',
  solana: '11111111111111111111111111111111',
  tron: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb',
};
const SHAPE = {
  evm: /^0x[0-9a-fA-F]{40}$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
};

export class UserError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function routeId(r) {
  return `${r.provider}:${r.chain}:${r.asset}`.toLowerCase();
}

function toRouteView(r, family) {
  const btc = r.acceptedAssets.find((a) => a.asset.type === 'bitcoin');
  if (!btc) return null;
  return {
    id: routeId(r), provider: r.provider, asset: r.asset, chain: r.chain, chainId: r.chainId ?? null,
    family, decimals: r.decimals, contractAddress: r.contractAddress ?? null,
    minUsd: btc.limits?.minUsdCents != null ? btc.limits.minUsdCents / 100 : null,
    maxUsd: btc.limits?.maxUsdCents != null ? btc.limits.maxUsdCents / 100 : null,
  };
}

// Base units to a decimal string, exact.
export function fromBaseUnits(value, decimals) {
  const v = BigInt(value);
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return (neg ? '-' : '') + whole + (frac ? '.' + frac : '');
}

// Same rounding as the database: amount_after_fee = round(amount * (1 - fee/100), 2).
export function splitFee(amountCents, feePercent) {
  const feeBps = Math.round(Number(feePercent) * 100);
  const sendCents = Math.floor((amountCents * (10000 - feeBps) + 5000) / 10000);
  return { sendCents, feeCents: amountCents - sendCents };
}

export function parseAmountCents(amount) {
  const s = String(amount ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

const cents = (c) => (c / 100).toFixed(2);

// The withdrawal outcome a Breez payment implies. 'stuck' means the
// cross-chain leg failed without a refund: the row stays 'sending' for a
// human, because the sats have left the wallet.
export function outcomeOf(payment) {
  if (payment.status === 'failed') return { status: 'failed', note: 'Breez send failed; balance returned' };
  if (payment.status !== 'completed') return { status: 'sending' };
  const conv = payment.conversionDetails?.status;
  if (conv === 'completed') return { status: 'paid', delivered: deliveredAmount(payment) };
  if (conv === 'refunded') return { status: 'failed', note: 'Swap refunded to the platform wallet; balance returned' };
  if (conv === 'failed') return { status: 'stuck' };
  return { status: 'sending' };
}

function deliveredAmount(payment) {
  const conversions = payment.conversionDetails?.conversions ?? [];
  const external = conversions.filter((c) => c.to?.chain?.type === 'external');
  const last = external[external.length - 1];
  if (!last || last.to.amount == null) return null;
  return fromBaseUnits(last.to.amount, last.to.asset.decimals);
}

// Errors the SDK raises before any transfer leaves the wallet.
export function failedBeforeSend(error) {
  return /^(Insufficient funds|Invalid input|Invalid UUID|Cross-chain route)/.test(String(error?.message ?? error));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

// confirmWaitMs: how long confirm waits for the send before answering with
// the row still 'sending'. The send carries on either way.
export function createWithdrawals({ breez, db, btcUsdRate, now = () => Date.now(), log = () => {}, confirmWaitMs = 25_000 }) {
  let routeCache = { at: 0, routes: [], error: null };
  const quotes = new Map();
  const inflight = new Map();
  const sendingIds = new Set();

  async function listRoutes() {
    if (now() - routeCache.at < ROUTE_CACHE_MS && routeCache.routes.length) return routeCache.routes;
    const found = new Map();
    const errors = [];
    for (const family of Object.keys(PLACEHOLDER)) {
      try {
        const pairs = await breez.getCrossChainRoutes({
          type: 'send', addressDetails: { address: PLACEHOLDER[family], addressFamily: family },
        });
        for (const p of pairs) {
          const view = toRouteView(p, family);
          if (view && !found.has(view.id)) found.set(view.id, view);
        }
      } catch (e) {
        errors.push(`${family}: ${e?.message ?? e}`);
      }
    }
    const routes = [...found.values()];
    if (routes.length || !routeCache.routes.length) {
      routeCache = { at: now(), routes, error: errors.join('; ') || null };
    }
    if (errors.length) log({ event: 'routes', errors });
    return routeCache.routes;
  }

  async function profileFor(userId) {
    const { rows } = await db.query(
      `select p.account_status, coalesce(p.withdrawal_fee_percent, 3.0)::text as fee_percent, b.available::text as available
         from profiles p cross join lateral get_balance_for(p.id) b where p.id = $1`,
      [userId],
    );
    return rows[0] ?? null;
  }

  async function validateAddress(address, family) {
    if (!SHAPE[family]?.test(address)) throw new UserError(422, `That is not a valid ${family.toUpperCase()} address`);
    let parsed;
    try { parsed = await breez.parse(address); } catch { parsed = null; }
    if (parsed?.type !== 'crossChainAddress' || parsed.addressFamily !== family) {
      throw new UserError(422, `That is not a valid ${family.toUpperCase()} address`);
    }
    return parsed.address;
  }

  async function quote({ userId, routeId: id, address, amountUsd }) {
    const amountCents = parseAmountCents(amountUsd);
    if (amountCents === null) throw new UserError(400, 'Enter an amount in dollars and cents');
    if (amountCents < 500) throw new UserError(422, 'Minimum withdrawal is $5');
    const profile = await profileFor(userId);
    if (!profile || profile.account_status !== 'active') throw new UserError(403, 'Account approval is required before requesting withdrawals');
    if (amountCents > Math.round(Number(profile.available) * 100)) {
      throw new UserError(422, `Insufficient balance. Available: $${Number(profile.available).toFixed(2)}`);
    }
    const route = (await listRoutes()).find((r) => r.id === id);
    if (!route) throw new UserError(422, 'That coin and network is not available right now');
    const dest = await validateAddress(String(address ?? '').trim(), route.family);
    const { sendCents, feeCents } = splitFee(amountCents, profile.fee_percent);
    if (route.minUsd != null && sendCents < route.minUsd * 100) {
      throw new UserError(422, `The minimum for ${route.asset} on ${route.chain} is $${route.minUsd.toFixed(2)} after the platform fee`);
    }
    if (route.maxUsd != null && sendCents > route.maxUsd * 100) {
      throw new UserError(422, `The maximum for ${route.asset} on ${route.chain} is $${route.maxUsd.toFixed(2)}`);
    }

    // Re-list for the real address so the route and its limits are the ones
    // the provider will accept for it.
    const pairs = await breez.getCrossChainRoutes({ type: 'send', addressDetails: { address: dest, addressFamily: route.family } });
    const pair = pairs.find((p) => routeId(p) === id);
    if (!pair) throw new UserError(422, 'That coin and network is not available for this address right now');

    const rate = await btcUsdRate();
    const amountSat = Math.floor((sendCents * 1e6) / rate);
    const { balanceSats } = await breez.getInfo({ ensureSynced: false });
    if (Number(balanceSats) < amountSat) {
      log({ event: 'quote', error: 'platform wallet balance too low', balanceSats: Number(balanceSats), amountSat });
      throw new UserError(503, 'Instant withdrawals are temporarily unavailable. Try again later.');
    }
    let prepared;
    try {
      prepared = await breez.prepareSendPayment({
        paymentRequest: { type: 'crossChain', address: dest, route: pair, maxSlippageBps: MAX_SLIPPAGE_BPS },
        amount: BigInt(amountSat),
        feePolicy: 'feesIncluded',
      });
    } catch (e) {
      throw new UserError(422, `Breez could not quote this withdrawal: ${e?.message ?? e}`);
    }
    const m = prepared.paymentMethod;
    if (m?.type !== 'crossChainAddress') throw new Error(`unexpected quote type ${m?.type}`);

    const receive = fromBaseUnits(m.estimatedOut, pair.decimals);
    const receiveMinBase = (BigInt(m.estimatedOut) * BigInt(10000 - MAX_SLIPPAGE_BPS)) / 10000n;
    const breezFeeUsd = (sendCents / 100 - Number(receive)).toFixed(6);
    const expiresAtMs = Date.parse(m.expiresAt);
    const quoteId = randomUUID();
    const view = {
      quoteId,
      expiresAt: new Date(expiresAtMs).toISOString(),
      route: { id, asset: pair.asset, chain: pair.chain, family: route.family, provider: pair.provider },
      address: dest,
      amountUsd: cents(amountCents),
      feePercent: profile.fee_percent,
      platformFeeUsd: cents(feeCents),
      sendUsd: cents(sendCents),
      amountSat,
      btcUsdRate: rate,
      breezFeeUsd,
      providerFee: { amount: fromBaseUnits(m.feeAmount, pair.decimals), asset: pair.asset },
      receive,
      receiveMin: fromBaseUnits(receiveMinBase, pair.decimals),
      asset: pair.asset,
      maxSlippageBps: MAX_SLIPPAGE_BPS,
    };
    quotes.set(quoteId, { userId, request: { userId, routeId: id, address: dest, amountUsd: cents(amountCents) }, prepared, expiresAtMs, view });
    for (const [k, q] of quotes) if (q.expiresAtMs < now() - 60_000) quotes.delete(k);
    return view;
  }

  async function rowByQuote(quoteId, userId) {
    const { rows } = await db.query('select * from withdrawals where quote_id = $1 and user_id = $2', [quoteId, userId]);
    return rows[0] ?? null;
  }

  async function reserve(q) {
    const v = q.view;
    try {
      const { rows } = await db.query(
        `select * from reserve_stablecoin_withdrawal($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [q.userId, v.quoteId, v.amountUsd, v.feePercent, v.sendUsd, v.asset, v.route.chain, v.address,
          v.breezFeeUsd, v.receive, v.amountSat, v.expiresAt],
      );
      return rows[0];
    } catch (e) {
      if (e.code === 'P0001') throw new UserError(422, e.message);
      throw e;
    }
  }

  async function finalize(id, outcome, { paymentId = null, amountOut = null, note = null } = {}) {
    const { rows } = await db.query('select finalize_stablecoin_withdrawal($1, $2, $3, $4, $5) as result', [id, outcome, paymentId, amountOut, note]);
    log({ event: 'finalize', withdrawalId: id, outcome, result: rows[0].result, note });
    return rows[0].result;
  }

  async function findPayment(id) {
    try {
      return (await breez.getPayment({ paymentId: id })).payment ?? null;
    } catch (e) {
      if (/not found/i.test(String(e?.message ?? e))) return null;
      throw e;
    }
  }

  async function apply(row, payment) {
    const o = outcomeOf(payment);
    if (o.status === 'paid') return finalize(row.id, 'paid', { paymentId: payment.id, amountOut: o.delivered });
    if (o.status === 'failed') return finalize(row.id, 'failed', { paymentId: payment.id, note: o.note });
    if (o.status === 'stuck') log({ event: 'withdrawal-stuck', withdrawalId: row.id, breezPaymentId: payment.id });
    return 'sending';
  }

  async function send(row, prepared) {
    let payment = null;
    let error = null;
    try {
      ({ payment } = await breez.sendPayment({ prepareResponse: prepared, idempotencyKey: row.id }));
    } catch (e) {
      error = e;
      log({ event: 'send-error', withdrawalId: row.id, error: String(e?.message ?? e) });
      payment = await findPayment(row.id).catch(() => null);
    }
    if (payment) return apply(row, payment);
    if (error && failedBeforeSend(error)) {
      return finalize(row.id, 'failed', { note: `Send failed before any transfer: ${String(error.message ?? error).slice(0, 300)}` });
    }
    // Unknown: the transfer may or may not exist yet. reconcile() decides.
    return 'sending';
  }

  async function currentRow(id) {
    const { rows } = await db.query('select * from withdrawals where id = $1', [id]);
    return rows[0];
  }

  async function confirm({ userId, quoteId }) {
    const existing = await rowByQuote(quoteId, userId);
    if (existing) return rowView(existing);
    const q = quotes.get(quoteId);
    if (!q || q.userId !== userId) throw new UserError(404, 'Quote not found. Get a new quote.');
    if (now() >= q.expiresAtMs - QUOTE_MARGIN_MS) {
      quotes.delete(quoteId);
      const fresh = await quote(q.request);
      throw new UserError(409, 'The quote expired. Review the new quote and confirm again.', { quote: fresh });
    }
    if (!inflight.has(quoteId)) {
      const run = (async () => {
        const row = await reserve(q);
        quotes.delete(quoteId);
        if (row.status !== 'sending') return row;
        sendingIds.add(row.id);
        const sending = send(row, q.prepared).catch((e) => {
          log({ event: 'send-crash', withdrawalId: row.id, error: String(e?.message ?? e) });
          return 'sending';
        }).finally(() => sendingIds.delete(row.id));
        await Promise.race([sending, wait(confirmWaitMs)]);
        return currentRow(row.id);
      })().then(
        (row) => { setTimeout(() => inflight.delete(quoteId), 60_000).unref?.(); return row; },
        (e) => { inflight.delete(quoteId); throw e; },
      );
      inflight.set(quoteId, run);
    }
    return rowView(await inflight.get(quoteId));
  }

  // Settle every 'sending' row against Breez. Called at startup, on payment
  // events and on the catch-up timer.
  async function reconcile({ synced = false } = {}) {
    const { rows } = await db.query(`select * from withdrawals where status = 'sending' and method = 'stablecoin' order by requested_at`);
    const outcomes = {};
    for (const row of rows) {
      let result;
      const payment = await findPayment(row.breez_payment_id ?? row.id);
      if (payment) {
        result = await apply(row, payment);
      } else if (synced && now() > new Date(row.quote_expires_at).getTime() + ORPHAN_GRACE_MS && !sendingIds.has(row.id)) {
        result = await finalize(row.id, 'failed', { note: 'No Breez payment found after the quote expired; balance returned' });
      } else {
        result = 'sending';
      }
      outcomes[result] = (outcomes[result] ?? 0) + 1;
    }
    return outcomes;
  }

  async function onPayment(payment) {
    if (payment?.paymentType !== 'send') return null;
    const { rows } = await db.query(
      `select * from withdrawals where status = 'sending' and method = 'stablecoin' and (id::text = $1 or breez_payment_id = $1)`,
      [payment.id],
    );
    if (!rows[0]) return null;
    const fresh = (await findPayment(payment.id)) ?? payment;
    return apply(rows[0], fresh);
  }

  function rowView(row) {
    return {
      withdrawalId: row.id, status: row.status, amountUsd: String(row.amount_requested), feePercent: String(row.fee_percent),
      sendUsd: String(row.amount_after_fee), asset: row.coin, chain: row.chain, address: row.destination,
      amountOut: row.amount_out != null ? String(row.amount_out) : null, breezPaymentId: row.breez_payment_id,
      note: row.admin_note, requestedAt: row.requested_at, processedAt: row.processed_at,
    };
  }

  return {
    listRoutes, quote, confirm, reconcile, onPayment,
    routeCacheInfo: () => ({ at: routeCache.at ? new Date(routeCache.at).toISOString() : null, count: routeCache.routes.length, error: routeCache.error }),
  };
}
