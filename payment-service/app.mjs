// The payment service without its process wiring: HTTP routes, payment
// events, catch-up, health and the shutdown drain. server.mjs connects the
// real SDK and database and hands them in; tests hand in fakes.

import * as ledger from './ledger.mjs';
import { createReceiptRecorder, settleWithReceipt } from './receipts.mjs';
import { createWithdrawals, UserError, wait } from './withdraw.mjs';
import { createWallet, createAdminWalletRoute } from './wallet.mjs';
import { createRequestAuth, resolveAdmin } from './auth.mjs';

export const MAX_BODY_BYTES = 10_000;
export const SYNC_STALE_MS = 10 * 60 * 1000;
const HEALTH_PROBE_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAYMENT_EVENTS = new Set(['paymentSucceeded', 'paymentFailed', 'paymentPending', 'paymentMetadataUpdated']);
// AutoOptimizationEvent types that end a leaf optimization run.
const OPTIMIZATION_DONE = new Set(['completed', 'cancelled', 'failed', 'skipped']);

// One JSON line per entry. redact() strips secret values from the line, so
// an error message that happens to quote one never reaches the log.
export const logJson = (entry, redact = (line) => line) => console.log(redact(JSON.stringify({ at: new Date().toISOString(), ...entry })));
const errorText = (e) => String(e?.message ?? e).slice(0, 300);
// Settle outcomes worth a look by an admin (20261007130000). 'settled' is
// included only so the database can spot an overpayment; it flags nothing
// for an exact one. 'duplicate' and 'ignored' never flag.
const REVIEW_OUTCOMES = new Set(['underpaid', 'unknown', 'not_settleable', 'no_hash', 'already_settled', 'settled']);
const REVIEW_TIMEOUT_MS = 2_500;

function timeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function readRaw(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new UserError(413, 'body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseJson(raw) {
  if (!raw.length) return {};
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { throw new UserError(400, 'body must be JSON'); }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new UserError(400, 'body must be a JSON object');
  return body;
}

export function createApp({
  sdk, db, secret, log: logRaw = logJson, confirmWaitMs, now = () => Date.now(),
  // F1 PR 1 receipt log: 'off' (default) or 'shadow'. recordDb is a separate
  // small pool so recording can never take the settlement path's connections.
  receiptRecording = 'off', recordDb = null, recordTimeoutMs,
  // Caller authentication (see auth.mjs). Defaults keep the legacy bearer
  // and body adminId working so a deploy can never lock the Edge Functions out.
  requestAuthMode = 'any', adminJwtMode = 'optional', verifyAdminToken = null,
}) {
  let lastSyncedAt = 0;
  let optimizing = false;
  let draining = false;
  let ready = false;
  const inflight = new Set();
  // Process counters only: no balances, user ids, invoices or secrets.
  // Single platform wallet: one Breez mnemonic / one Spark tree for all
  // creators (documented in README). Metrics do not claim otherwise.
  const metrics = {
    invoicesAttached: 0,
    invoiceIdempotentHits: 0,
    settles: Object.create(null),
    catchUps: 0,
    lastCatchUpAt: null,
    withdrawalsFinalized: Object.create(null),
    withdrawalStuck: 0,
    authRejected: 0,
    authSigned: 0,
    authBearer: 0,
    adminTokenVerified: 0,
    adminLegacy: 0,
    adminRejected: 0,
    requestErrors: 0,
    leafRetries: 0,
    receiptReviews: Object.create(null),
    receiptReviewFailed: 0,
  };
  function bump(bucket, key) {
    bucket[key] = (bucket[key] ?? 0) + 1;
  }
  const log = (entry) => {
    if (entry?.event === 'leaf-retry') metrics.leafRetries += 1;
    if (entry?.event === 'withdrawal-stuck') metrics.withdrawalStuck += 1;
    return logRaw(entry);
  };

  // Work that must finish before the SDK disconnects: requests, settles,
  // catch-up passes and sends that outlive their request.
  function track(promise) {
    inflight.add(promise);
    promise.then(() => inflight.delete(promise), () => inflight.delete(promise));
    return promise;
  }

  let rate = { value: 0, at: 0 };
  async function btcUsdRate() {
    if (now() - rate.at > 60_000) {
      const { rates } = await sdk.listFiatRates();
      const usd = rates.find((r) => r.coin === 'USD');
      if (!usd || !(usd.value > 0)) throw new Error('no BTC/USD rate');
      rate = { value: usd.value, at: now() };
    }
    return rate.value;
  }

  const withdrawals = createWithdrawals({ breez: sdk, db, btcUsdRate, log, track, ...(confirmWaitMs ? { confirmWaitMs } : {}) });
  const wallet = createWallet({ breez: sdk, db, btcUsdRate, withdrawals, log, track });
  const adminWalletRoute = createAdminWalletRoute({ wallet, withdrawals });
  const requestAuth = createRequestAuth({ secret, mode: requestAuthMode, now });
  if (adminJwtMode === 'required' && !verifyAdminToken) throw new Error('ADMIN_JWT_MODE=required needs an admin token verifier');
  const receipts = createReceiptRecorder({
    mode: receiptRecording, recordDb, log, ...(recordTimeoutMs ? { timeoutMs: recordTimeoutMs } : {}),
  });

  // Recording (shadow only) runs first and can never stop the legacy
  // settlement: see settleWithReceipt() in receipts.mjs. The settlement
  // call itself is ledger.settlePayment(), unchanged from main.
  async function settle(payment, source) {
    const outcome = await settleWithReceipt({ db, recorder: receipts, payment, source });
    bump(metrics.settles, outcome);
    log({ event: 'settle', source, breezPaymentId: payment.id, amountSat: String(payment.amount), outcome });
    await flagForReview(payment, outcome);
    return outcome;
  }

  // Flag-only review queue: runs after settlement has already answered, as
  // its own statement, and never throws, so it cannot change, undo or delay
  // a settlement beyond REVIEW_TIMEOUT_MS. Independent of RECEIPT_RECORDING.
  // Each provider payment is flagged at most once per process; the database
  // deduplicates across restarts.
  const reviewed = new Set();
  async function flagForReview(payment, outcome) {
    if (!REVIEW_OUTCOMES.has(outcome) || payment?.paymentType !== 'receive' || payment?.status !== 'completed') return;
    const id = typeof payment.id === 'string' ? payment.id.slice(0, 200) : '';
    if (!id || reviewed.has(id)) return;
    let amount;
    try { amount = BigInt(payment.amount).toString(); } catch { amount = null; }
    try {
      const { rows } = await timeout(
        db.query('select public.system_flag_receipt($1, $2, $3, $4) as kind', [id, ledger.paymentHashOf(payment), amount, outcome]),
        REVIEW_TIMEOUT_MS,
      );
      reviewed.add(id);
      if (reviewed.size > 10_000) reviewed.clear();
      const kind = rows[0]?.kind;
      if (kind) {
        bump(metrics.receiptReviews, kind);
        log({ event: 'receipt-review', breezPaymentId: id, kind, outcome });
      }
    } catch (e) {
      metrics.receiptReviewFailed += 1;
      log({ event: 'receipt-review-failed', breezPaymentId: id, outcome, error: errorText(e) });
    }
  }

  function onEvent(event) {
    if (event.type === 'synced') lastSyncedAt = now();
    if (event.type === 'autoOptimization') {
      const type = event.optimizationEvent?.type;
      optimizing = !OPTIMIZATION_DONE.has(type);
      log({ event: 'leaf-optimization', type });
      return;
    }
    if (!PAYMENT_EVENTS.has(event.type)) return;
    if (event.payment.paymentType === 'send') {
      track(withdrawals.onPayment(event.payment)
        .then((outcome) => outcome && log({ event: 'withdrawal', source: event.type, breezPaymentId: event.payment.id, outcome }))
        .catch((e) => log({ event: 'withdrawal-update-failed', breezPaymentId: event.payment.id, error: errorText(e) })));
    } else if (event.type === 'paymentSucceeded') {
      track(settle(event.payment, 'event')
        .catch((e) => log({ event: 'settle-failed', breezPaymentId: event.payment.id, error: errorText(e) })));
    }
  }

  async function catchUpOnce() {
    const since = await ledger.catchUpSince(db);
    const outcomes = {};
    if (since !== null) {
      const limit = 100;
      for (let offset = 0; ; offset += limit) {
        const { payments } = await sdk.listPayments({
          typeFilter: ['receive'], statusFilter: ['completed'], fromTimestamp: since, offset, limit, sortAscending: true,
        });
        for (const p of payments) {
          const outcome = await settle(p, 'catch-up');
          outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
        }
        if (payments.length < limit) break;
      }
    }
    const expired = await ledger.expireUnpaid(db);
    // An unanswered send is only refunded right after a completed sync, so a
    // transfer made before a crash is always seen first.
    const synced = await sdk.getInfo({ ensureSynced: true }).then(() => true, (e) => {
      log({ event: 'sync-failed', error: errorText(e) });
      return false;
    });
    if (synced) lastSyncedAt = now();
    const withdrawalOutcomes = await withdrawals.reconcile({ synced });
    metrics.catchUps += 1;
    metrics.lastCatchUpAt = new Date(now()).toISOString();
    // reconcile() returns { outcome: count }; add the count, not 1 per pass.
    for (const [k, n] of Object.entries(withdrawalOutcomes ?? {})) {
      if (k === 'sending' || !(n > 0)) continue;
      metrics.withdrawalsFinalized[k] = (metrics.withdrawalsFinalized[k] ?? 0) + n;
    }
    log({
      event: 'catch-up', since, outcomes, expired, withdrawals: withdrawalOutcomes,
      ...(receipts.enabled ? { receipts: receipts.stats() } : {}),
    });
  }

  let catchUpRunning = null;
  // One pass at a time, none once shutdown has begun.
  function catchUp() {
    if (draining) return Promise.resolve();
    catchUpRunning ??= track(catchUpOnce().finally(() => { catchUpRunning = null; }));
    return catchUpRunning;
  }

  async function createInvoice(paymentId) {
    const client = await db.connect();
    let transactionStarted = false;
    try {
      await client.query('begin');
      transactionStarted = true;
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [paymentId]);
      const row = await ledger.invoiceRow(client, paymentId);
      if (!row) return [404, { error: 'payment not found' }];
      if (row.lightning_invoice) {
        metrics.invoiceIdempotentHits += 1;
        return [200, { ...invoiceLinks(row.lightning_invoice), paymentHash: row.invoice_ref, amountSat: Number(row.amount_sat) }];
      }
      if (row.status !== 'new') return [409, { error: `payment is ${row.status}` }];
      const expirySecs = Math.floor((new Date(row.expires_at).getTime() - now()) / 1000);
      if (expirySecs < 60) return [409, { error: 'payment expires too soon' }];

      const btcUsd = await btcUsdRate();
      const amountSat = ledger.usdToSats(row.amount_requested, btcUsd);
      const { paymentRequest } = await sdk.receivePayment({
        paymentMethod: { type: 'bolt11Invoice', description: 'cpay payment', amountSats: amountSat, expirySecs },
      });
      const parsed = await sdk.parse(paymentRequest);
      const attached = await ledger.attachInvoice(client, {
        paymentId, paymentHash: parsed.paymentHash, bolt11: paymentRequest, amountSat, btcUsdRate: btcUsd,
      });
      if (!attached) {
        await client.query('commit');
        transactionStarted = false;
        const again = await ledger.invoiceRow(db, paymentId);
        if (!again?.lightning_invoice) return [409, { error: 'payment is no longer open' }];
        return [200, { ...invoiceLinks(again.lightning_invoice), paymentHash: again.invoice_ref, amountSat: Number(again.amount_sat) }];
      }
      await client.query('commit');
      transactionStarted = false;
      metrics.invoicesAttached += 1;
      return [200, { ...invoiceLinks(paymentRequest), paymentHash: parsed.paymentHash, amountSat }];
    } finally {
      if (transactionStarted) await client.query('rollback').catch(() => {});
      client.release();
    }
  }

  // Unauthenticated, for the host's health check: booleans and one
  // timestamp, no balances, ids or configuration.
  function invoiceLinks(bolt11) {
    const raw = String(bolt11 || '').replace(/^lightning:/i, '');
    return {
      bolt11: raw,
      lightningUri: `lightning:${raw}`,
      cashAppUrl: `https://cash.app/launch/lightning/${encodeURIComponent(raw)}`,
    };
  }

  async function health() {
    const [dbOk, sdkConnected] = await Promise.all([
      timeout(db.query('select 1'), HEALTH_PROBE_MS).then(() => true, () => false),
      timeout(sdk.getInfo({ ensureSynced: false }), HEALTH_PROBE_MS).then(() => true, () => false),
    ]);
    const synced = lastSyncedAt > 0 && now() - lastSyncedAt < SYNC_STALE_MS;
    const ok = dbOk && sdkConnected && synced && !draining;
    return [ok ? 200 : 503, {
      ok, sdkConnected, synced, lastSyncedAt: lastSyncedAt ? new Date(lastSyncedAt).toISOString() : null,
      db: dbOk, shuttingDown: draining,
    }];
  }

  // Readiness: startup catch-up finished and not draining. Unauthenticated,
  // like /health — hosts may probe it before sending traffic. No balances.
  function readiness() {
    const isReady = ready && !draining;
    return [isReady ? 200 : 503, { ready: isReady, shuttingDown: draining }];
  }

  function metricsSnapshot() {
    return {
      ready,
      shuttingDown: draining,
      inflight: inflight.size,
      invoicesAttached: metrics.invoicesAttached,
      invoiceIdempotentHits: metrics.invoiceIdempotentHits,
      settles: { ...metrics.settles },
      catchUps: metrics.catchUps,
      lastCatchUpAt: metrics.lastCatchUpAt,
      withdrawalsFinalized: { ...metrics.withdrawalsFinalized },
      withdrawalStuck: metrics.withdrawalStuck,
      authRejected: metrics.authRejected,
      authSigned: metrics.authSigned,
      authBearer: metrics.authBearer,
      adminTokenVerified: metrics.adminTokenVerified,
      adminLegacy: metrics.adminLegacy,
      adminRejected: metrics.adminRejected,
      requestAuthMode,
      adminJwtMode,
      requestErrors: metrics.requestErrors,
      leafRetries: metrics.leafRetries,
      receiptReviews: { ...metrics.receiptReviews },
      receiptReviewFailed: metrics.receiptReviewFailed,
      // Custody model reminder for operators reading the scrape:
      singleWallet: true,
    };
  }

  async function withdrawRoute(method, path, readBody) {
    if (method === 'GET' && path === '/withdraw/routes') {
      return [200, { routes: await withdrawals.listRoutes(), cache: withdrawals.routeCacheInfo() }];
    }
    if (method !== 'POST' || (path !== '/withdraw/quote' && path !== '/withdraw/confirm')) return [404, { error: 'not found' }];
    const body = await readBody();
    if (!UUID.test(String(body.userId))) return [400, { error: 'userId must be a uuid' }];
    if (path === '/withdraw/quote') {
      const { userId, routeId, address, amountUsd } = body;
      return [200, await withdrawals.quote({ userId, routeId: String(routeId ?? ''), address, amountUsd })];
    }
    if (!UUID.test(String(body.quoteId))) return [400, { error: 'quoteId must be a uuid' }];
    return [200, await withdrawals.confirm({ userId: body.userId, quoteId: body.quoteId })];
  }

  // /admin/wallet/*: the admin id comes from the admin's verified Supabase
  // session when one is forwarded (always, once ADMIN_JWT_MODE=required).
  async function adminRoute(method, path, req, readBody) {
    if (method !== 'POST') return adminWalletRoute(method, path, null);
    const body = await readBody();
    const tokenHeader = req.headers['x-cpay-admin-token'];
    const who = await resolveAdmin({
      mode: adminJwtMode, verifyToken: verifyAdminToken,
      token: typeof tokenHeader === 'string' ? tokenHeader : undefined, bodyAdminId: body.adminId,
    });
    if (who.refused) {
      metrics.adminRejected += 1;
      log({ event: 'admin-auth-refused', path, reason: who.reason });
      return who.refused;
    }
    if (who.via === 'token') metrics.adminTokenVerified += 1; else metrics.adminLegacy += 1;
    return adminWalletRoute(method, path, { ...body, adminId: who.adminId });
  }

  async function route(req) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const method = req.method;
    if (path === '/health') return method === 'GET' ? health() : [405, { error: 'method not allowed' }];
    if (path === '/ready') return method === 'GET' ? readiness() : [405, { error: 'method not allowed' }];
    // A signed request covers its body, so read it (bounded) first; a bearer
    // call is checked before any body is read, as before.
    const signed = req.headers['x-cpay-signature'] !== undefined || req.headers['x-cpay-timestamp'] !== undefined || req.headers['x-cpay-nonce'] !== undefined;
    let raw = signed ? await readRaw(req) : null;
    const verdict = requestAuth.check(req.headers, method, url.pathname + url.search, raw ?? Buffer.alloc(0));
    if (!verdict.ok) {
      metrics.authRejected += 1;
      if (verdict.reason !== 'bad-bearer') log({ event: 'auth-refused', path, reason: verdict.reason });
      return [401, { error: 'unauthorized' }];
    }
    if (verdict.kind === 'signed') metrics.authSigned += 1; else metrics.authBearer += 1;
    const readBody = async () => parseJson(raw ??= await readRaw(req));
    if (path === '/metrics') {
      if (method !== 'GET') return [405, { error: 'method not allowed' }];
      return [200, metricsSnapshot()];
    }
    if (draining) return [503, { error: 'shutting down' }];
    if (path === '/invoices') {
      if (method !== 'POST') return [405, { error: 'method not allowed' }];
      const { paymentId } = await readBody();
      return UUID.test(String(paymentId)) ? createInvoice(paymentId) : [400, { error: 'paymentId must be a uuid' }];
    }
    if (path.startsWith('/withdraw/')) return withdrawRoute(method, path, readBody);
    if (path.startsWith('/admin/wallet/')) return adminRoute(method, path, req, readBody);
    return [404, { error: 'not found' }];
  }

  async function handle(req, res) {
    let status, body;
    try {
      [status, body] = await route(req);
    } catch (e) {
      if (e instanceof UserError) {
        [status, body] = [e.status, { error: e.message, ...e.extra }];
      } else {
        metrics.requestErrors += 1;
        log({ event: 'request-failed', method: req.method, path: new URL(req.url, 'http://localhost').pathname, error: errorText(e) });
        [status, body] = [500, { error: 'internal error' }];
      }
    }
    const headers = { 'content-type': 'application/json' };
    // A body cut short (413) or a drain in progress: do not reuse this connection.
    if (status === 413 || draining) headers.connection = 'close';
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  }

  // Stop taking work and wait, up to timeoutMs, for tracked work and any
  // leaf optimization to finish. A process that exits mid-optimization
  // leaves a reservation that blocks sends for about 5 minutes after the
  // next start (see RUNBOOKS.md).
  async function drain(timeoutMs, sleep = wait) {
    draining = true;
    const deadline = now() + timeoutMs;
    log({ event: 'drain', inflight: inflight.size, optimizing });
    while ((inflight.size || optimizing) && now() < deadline) await sleep(100);
    const result = { drained: !inflight.size && !optimizing, inflight: inflight.size, optimizing };
    log({ event: 'drained', ...result });
    return result;
  }

  return {
    handle: (req, res) => track(handle(req, res)),
    onEvent, catchUp, drain, health, readiness, track,
    markSynced: () => { lastSyncedAt = now(); },
    markReady: () => { ready = true; },
    noteStuck: () => { metrics.withdrawalStuck += 1; },
    noteLeafRetry: () => { metrics.leafRetries += 1; },
    metrics: metricsSnapshot,
    receiptStats: () => receipts.stats(),
  };
}
