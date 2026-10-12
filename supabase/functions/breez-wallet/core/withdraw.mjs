// Instant stablecoin withdrawals: route catalog, quotes, confirm and
// reconcile. `breez` is the connected SDK (or a fake in tests), `db` a pg
// Pool, `btcUsdRate` an async function returning USD per BTC.

import { randomUUID } from 'node:crypto';
import { decimalToCents, formatCents, parseUsdCents, splitFeeCents, usdCentsToSats } from './money.mjs';

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
    minUsdCents: btc.limits?.minUsdCents ?? null,
    maxUsdCents: btc.limits?.maxUsdCents ?? null,
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
// Exact decimal arithmetic in money.mjs: no Number(feePercent) * 100.
export function splitFee(amountCents, feePercent) {
  return splitFeeCents(amountCents, feePercent);
}

// sendUsd minus the coins the destination gets, exact to the coin's base
// unit. 1 USDT/USDC is taken as $1, as everywhere else here. This is the one
// fee a user pays on an instant withdrawal (swap plus network), shown to
// them as the network fee.
export function networkFeeUsd(sendCents, estimatedOutBase, decimals) {
  const sendBase = decimals >= 2
    ? BigInt(sendCents) * 10n ** BigInt(decimals - 2)
    : BigInt(sendCents) / 10n ** BigInt(2 - decimals);
  const fee = sendBase - BigInt(estimatedOutBase);
  return fromBaseUnits(fee < 0n ? 0n : fee, decimals);
}

// "12.34" -> 1234, exactly (BigInt digits, never Number(s) * 100).
export function parseAmountCents(amount) {
  try { return parseUsdCents(amount); } catch { return null; }
}

const cents = (c) => formatCents(c);

// The withdrawal outcome a Breez payment implies. 'stuck' means the
// cross-chain leg failed without a refund: the row stays 'sending' for a
// human, because the sats have left the wallet.
export function outcomeOf(payment) {
  if (payment.status === 'failed') return { status: 'failed', note: 'Send failed; balance returned' };
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

// A process that exits during the SDK's automatic leaf-optimization swap
// leaves a 'Swap' reservation in the local tree store. Until a sync after
// the store's 5-minute reservation timeout clears it, every send fails
// with this, while leaves are selected and before any transfer.
export const isLeafError = (error) => /Failed to select leaves/.test(String(error?.message ?? error));

// Errors the SDK raises before any transfer leaves the wallet.
export function failedBeforeSend(error) {
  return /^(Insufficient funds|Invalid input|Invalid UUID|Cross-chain route)/.test(String(error?.message ?? error)) || isLeafError(error);
}

export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

export const LEAF_RETRY_MS = 6 * 60 * 1000;

// attempt() is a send with a fixed idempotency key. While it fails with the
// leaf error: back off, sync, ask Breez whether the last attempt made a
// payment after all (if so, that is the result and nothing is sent again),
// and try again, until the next try would start after deadlineMs.
export async function retryLeafErrors({ breez, key, attempt, existing, deadlineMs, now, sleep, log }) {
  for (let delay = 5_000, n = 1; ; delay = Math.min(delay * 2, 60_000), n++) {
    try {
      return await attempt();
    } catch (e) {
      if (!isLeafError(e) || now() + delay >= deadlineMs) throw e;
      log({ event: 'leaf-retry', key, attempt: n, delayMs: delay });
      await sleep(delay);
      await breez.syncWallet({}).catch((s) => log({ event: 'leaf-retry-sync-failed', key, error: String(s?.message ?? s) }));
      const payment = await existing();
      if (payment) return { payment };
    }
  }
}

// confirmWaitMs: how long confirm waits for the send before answering with
// the row still 'sending'. The send carries on either way, registered with
// track() so a shutdown waits for it.
export function createWithdrawals({ breez, db, btcUsdRate, now = () => Date.now(), sleep = wait, log = () => {}, confirmWaitMs = 25_000, track = (p) => p }) {
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
      // The fee is the account's own override, else the global default:
      // resolve_withdrawal_fee() is the one place that decides
      // (20261005020000), and reserve checks against it again.
      `select p.account_status, resolve_withdrawal_fee(p.id)::text as fee_percent,
              b.available::text as available
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

  // The Breez side of a stablecoin send, with no ledger in it: re-list the
  // routes for the real address so the route and its limits are the ones the
  // provider will accept, check the platform wallet covers the sats, and
  // prepare. Creator withdrawals and admin wallet sends both quote through here.
  // A prepare error is logged; the caller gets failMessage, plus the SDK's own
  // text only when showDetail is set (the admin wallet). Creator-facing
  // messages never carry SDK text.
  async function prepareCrossChain({ route, address, amountSat, lowBalanceMessage, failMessage, showDetail = false }) {
    const pairs = await breez.getCrossChainRoutes({ type: 'send', addressDetails: { address, addressFamily: route.family } });
    const pair = pairs.find((p) => routeId(p) === route.id);
    if (!pair) throw new UserError(422, 'That coin and network is not available for this address right now');
    const { balanceSats } = await breez.getInfo({ ensureSynced: false });
    if (Number(balanceSats) < amountSat) {
      log({ event: 'quote', error: 'platform wallet balance too low', balanceSats: Number(balanceSats), amountSat });
      throw new UserError(503, lowBalanceMessage);
    }
    let prepared;
    try {
      prepared = await breez.prepareSendPayment({
        paymentRequest: { type: 'crossChain', address, route: pair, maxSlippageBps: MAX_SLIPPAGE_BPS },
        amount: BigInt(amountSat),
        feePolicy: 'feesIncluded',
      });
    } catch (e) {
      const detail = String(e?.message ?? e);
      log({ event: 'quote', error: 'prepare failed', route: route.id, detail });
      throw new UserError(422, showDetail ? `${failMessage}: ${detail}` : failMessage);
    }
    const m = prepared.paymentMethod;
    if (m?.type !== 'crossChainAddress') throw new Error(`unexpected quote type ${m?.type}`);
    const receiveMinBase = (BigInt(m.estimatedOut) * BigInt(10000 - MAX_SLIPPAGE_BPS)) / 10000n;
    return {
      pair, prepared,
      expiresAtMs: Date.parse(m.expiresAt),
      receive: fromBaseUnits(m.estimatedOut, pair.decimals),
      estimatedOutBase: m.estimatedOut,
      receiveMin: fromBaseUnits(receiveMinBase, pair.decimals),
      providerFee: { amount: fromBaseUnits(m.feeAmount, pair.decimals), asset: pair.asset },
    };
  }

  async function quote({ userId, routeId: id, address, amountUsd }) {
    const amountCents = parseAmountCents(amountUsd);
    if (amountCents === null) throw new UserError(400, 'Enter an amount in dollars and cents');
    if (amountCents < 500) throw new UserError(422, 'Minimum withdrawal is $5');
    const profile = await profileFor(userId);
    if (!profile || profile.account_status !== 'active') throw new UserError(403, 'Account approval is required before requesting withdrawals');
    // Floor, not round: $10.005 available allows $10.00, never $10.01.
    // reserve_stablecoin_withdrawal() checks again in numeric.
    const availableCents = decimalToCents(profile.available, 'floor');
    if (amountCents > availableCents) {
      throw new UserError(422, `Insufficient balance. Available: $${formatCents(Math.max(0, availableCents))}`);
    }
    const route = (await listRoutes()).find((r) => r.id === id);
    if (!route) throw new UserError(422, 'That coin and network is not available right now');
    const dest = await validateAddress(String(address ?? '').trim(), route.family);
    await requireReadyDestination(userId, dest);
    const { sendCents, feeCents } = splitFee(amountCents, profile.fee_percent);
    if (route.minUsdCents != null && sendCents < route.minUsdCents) {
      throw new UserError(422, `The minimum for ${route.asset} on ${route.chain} is $${route.minUsd.toFixed(2)} after the platform fee`);
    }
    if (route.maxUsdCents != null && sendCents > route.maxUsdCents) {
      throw new UserError(422, `The maximum for ${route.asset} on ${route.chain} is $${route.maxUsd.toFixed(2)}`);
    }

    const rate = await btcUsdRate();
    const amountSat = usdCentsToSats(sendCents, rate, 'floor');
    const { pair, prepared, expiresAtMs, receive, receiveMin, providerFee, estimatedOutBase } = await prepareCrossChain({
      route, address: dest, amountSat,
      lowBalanceMessage: 'Instant withdrawals are temporarily unavailable. Try again later.',
      failMessage: 'This withdrawal could not be quoted right now. Try another amount or network.',
    });
    const fee = networkFeeUsd(sendCents, estimatedOutBase, pair.decimals);
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
      networkFeeUsd: fee,
      providerFee,
      receive,
      receiveMin,
      asset: pair.asset,
      maxSlippageBps: MAX_SLIPPAGE_BPS,
    };
    quotes.set(quoteId, { userId, request: { userId, routeId: id, address: dest, amountUsd: cents(amountCents) }, prepared, expiresAtMs, view });
    for (const [k, q] of quotes) if (q.expiresAtMs < now() - 60_000) quotes.delete(k);
    return view;
  }

  // 20261009010000: a payout goes only to an address the account saved at
  // least 24 hours ago. Checked at quote and again right before reserving,
  // so an address deleted or changed after the quote cannot be paid.
  async function requireReadyDestination(userId, address) {
    const { rows } = await db.query('select withdraw_destination_status($1, $2) as s', [userId, address]);
    const s = rows[0]?.s ?? { ok: false, reason: 'not_saved' };
    if (s.ok === true) return;
    if (s.reason === 'cooling_down') {
      const until = new Date(s.usable_after).toISOString().replace('T', ' ').slice(0, 16);
      throw new UserError(403, `This address was saved less than 24 hours ago. For your safety, withdrawals to it open at ${until} UTC.`, { code: 'address_cooling_down', usableAfter: new Date(s.usable_after).toISOString() });
    }
    throw new UserError(403, 'Save this address in Profile first. Withdrawals only go to an address saved at least 24 hours ago.', { code: 'address_not_saved' });
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
          v.networkFeeUsd, v.receive, v.amountSat, v.expiresAt],
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
    if (o.status === 'stuck') log({ event: 'withdrawal-stuck', withdrawalId: row.id, paymentId: payment.id });
    return 'sending';
  }

  async function send(row, prepared) {
    let payment = null;
    let error = null;
    try {
      // A retry stops at the quote's expiry too: after it the SDK refuses the send.
      ({ payment } = await retryLeafErrors({
        breez, key: row.id, now, sleep, log,
        deadlineMs: Math.min(now() + LEAF_RETRY_MS, new Date(row.quote_expires_at).getTime() - QUOTE_MARGIN_MS),
        attempt: () => breez.sendPayment({ prepareResponse: prepared, idempotencyKey: row.id }),
        existing: () => findPayment(row.id),
      }));
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
        await requireReadyDestination(userId, q.view.address);
        const row = await reserve(q);
        quotes.delete(quoteId);
        if (row.status !== 'sending') return row;
        sendingIds.add(row.id);
        const sending = track(send(row, q.prepared).catch((e) => {
          log({ event: 'send-crash', withdrawalId: row.id, error: String(e?.message ?? e) });
          return 'sending';
        }).finally(() => sendingIds.delete(row.id)));
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
      const payment = await findPayment(row.payout_ref ?? row.id);
      if (payment) {
        result = await apply(row, payment);
      } else if (synced && now() > new Date(row.quote_expires_at).getTime() + ORPHAN_GRACE_MS && !sendingIds.has(row.id)) {
        result = await finalize(row.id, 'failed', { note: 'No payment found after the quote expired; balance returned' });
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
      `select * from withdrawals where status = 'sending' and method = 'stablecoin' and (id::text = $1 or payout_ref = $1)`,
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
      amountOut: row.amount_out != null ? String(row.amount_out) : null, payoutRef: row.payout_ref,
      note: row.admin_note, requestedAt: row.requested_at, processedAt: row.processed_at,
    };
  }

  return {
    listRoutes, quote, confirm, reconcile, onPayment, validateAddress, prepareCrossChain, findPayment,
    routeCacheInfo: () => ({ at: routeCache.at ? new Date(routeCache.at).toISOString() : null, count: routeCache.routes.length, error: routeCache.error }),
  };
}
