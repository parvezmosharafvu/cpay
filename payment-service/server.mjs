import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import pg from 'pg';
import * as ledger from './ledger.mjs';

const breez = createRequire(import.meta.url)('@breeztech/breez-sdk-spark');

function env(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

const NETWORK = env('BREEZ_NETWORK', 'regtest');
const SECRET = env('PAYMENT_SERVICE_SECRET');
const PORT = Number(env('PORT', '8080'));
const CATCH_UP_MS = Number(env('CATCH_UP_INTERVAL_SECS', '300')) * 1000;
const SYNC_STALE_MS = 10 * 60 * 1000;

const db = new pg.Pool({ connectionString: env('DATABASE_URL') });
db.on('error', (e) => console.error('idle database client error:', e.message));

const config = breez.defaultConfig(NETWORK);
if (process.env.BREEZ_API_KEY) config.apiKey = process.env.BREEZ_API_KEY;
if (NETWORK === 'mainnet' && !config.apiKey) throw new Error('BREEZ_API_KEY is required on mainnet');

const sdk = await breez.connect({
  config,
  seed: { type: 'mnemonic', mnemonic: env('BREEZ_MNEMONIC') },
  storageDir: env('BREEZ_DATA_DIR', './.data'),
});

let lastSyncedAt = 0;
let lastCatchUp = null;

async function settle(payment, source) {
  const outcome = await ledger.settlePayment(db, payment);
  console.log(JSON.stringify({ event: 'settle', source, breezPaymentId: payment.id, amountSat: String(payment.amount), outcome }));
  return outcome;
}

await sdk.addEventListener({
  onEvent: (event) => {
    if (event.type === 'synced') lastSyncedAt = Date.now();
    if (event.type === 'paymentSucceeded') {
      settle(event.payment, 'event').catch((e) => console.error('settle failed:', e));
    }
  },
});

async function catchUp() {
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
  lastCatchUp = { at: new Date().toISOString(), since, outcomes, expired };
  console.log(JSON.stringify({ event: 'catch-up', ...lastCatchUp }));
}

let rate = { value: 0, at: 0 };
async function btcUsdRate() {
  if (Date.now() - rate.at > 60_000) {
    const { rates } = await sdk.listFiatRates();
    const usd = rates.find((r) => r.coin === 'USD');
    if (!usd || !(usd.value > 0)) throw new Error('no BTC/USD rate');
    rate = { value: usd.value, at: Date.now() };
  }
  return rate.value;
}

async function createInvoice(paymentId) {
  const row = await ledger.invoiceRow(db, paymentId);
  if (!row) return [404, { error: 'payment not found' }];
  if (row.lightning_invoice) {
    return [200, { bolt11: row.lightning_invoice, paymentHash: row.invoice_ref, amountSat: Number(row.amount_sat) }];
  }
  if (row.status !== 'new') return [409, { error: `payment is ${row.status}` }];
  const expirySecs = Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000);
  if (expirySecs < 60) return [409, { error: 'payment expires too soon' }];

  const btcUsd = await btcUsdRate();
  const amountSat = ledger.usdToSats(row.amount_requested, btcUsd);
  const { paymentRequest } = await sdk.receivePayment({
    paymentMethod: { type: 'bolt11Invoice', description: 'cpay payment', amountSats: amountSat, expirySecs },
  });
  const parsed = await sdk.parse(paymentRequest);
  const attached = await ledger.attachInvoice(db, {
    paymentId, paymentHash: parsed.paymentHash, bolt11: paymentRequest, amountSat, btcUsdRate: btcUsd,
  });
  if (!attached) {
    const again = await ledger.invoiceRow(db, paymentId);
    if (!again?.lightning_invoice) return [409, { error: 'payment is no longer open' }];
    return [200, { bolt11: again.lightning_invoice, paymentHash: again.invoice_ref, amountSat: Number(again.amount_sat) }];
  }
  return [200, { bolt11: paymentRequest, paymentHash: parsed.paymentHash, amountSat }];
}

async function health() {
  let dbOk = false;
  try { await db.query('select 1'); dbOk = true; } catch (e) { console.error('health db:', e.message); }
  const synced = Date.now() - lastSyncedAt < SYNC_STALE_MS;
  const { balanceSats } = await sdk.getInfo({ ensureSynced: false });
  const ok = dbOk && synced;
  return [ok ? 200 : 503, {
    ok, network: NETWORK, db: dbOk, synced, balanceSats,
    lastSyncedAt: lastSyncedAt ? new Date(lastSyncedAt).toISOString() : null, lastCatchUp,
  }];
}

const expectedAuth = createHash('sha256').update(`Bearer ${SECRET}`).digest();
function authorised(req) {
  return timingSafeEqual(createHash('sha256').update(req.headers.authorization ?? '').digest(), expectedAuth);
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10_000) throw new Error('body too large');
  }
  return JSON.parse(body || '{}');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const server = http.createServer(async (req, res) => {
  let status = 404, body = { error: 'not found' };
  try {
    if (!authorised(req)) {
      [status, body] = [401, { error: 'unauthorized' }];
    } else if (req.method === 'POST' && req.url === '/invoices') {
      const { paymentId } = await readJson(req);
      [status, body] = UUID.test(String(paymentId)) ? await createInvoice(paymentId) : [400, { error: 'paymentId must be a uuid' }];
    } else if (req.method === 'GET' && req.url === '/health') {
      [status, body] = await health();
    }
  } catch (e) {
    console.error(`${req.method} ${req.url} failed:`, e);
    [status, body] = [500, { error: 'internal error' }];
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
});

await sdk.getInfo({ ensureSynced: true });
lastSyncedAt = Date.now();
await catchUp();
setInterval(() => catchUp().catch((e) => console.error('catch-up failed:', e)), CATCH_UP_MS);
server.listen(PORT, () => console.log(JSON.stringify({ event: 'listening', port: PORT, network: NETWORK })));

async function shutdown() {
  server.close();
  await sdk.disconnect().catch(() => {});
  await db.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
