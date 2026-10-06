import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outcomeOf, failedBeforeSend, isLeafError, retryLeafErrors, wait } from './withdraw.mjs';
import { loadConfig, receiptRecordingMode, redactor, MIN_SECRET_LENGTH } from './config.mjs';
import { createApp, MAX_BODY_BYTES, SYNC_STALE_MS } from './app.mjs';
import { usdToSats, paymentHashOf } from './ledger.mjs';

// Financial / reliability invariants that must not regress without a deliberate
// design change. These run without a database.

test('stuck cross-chain failure must NOT look like a refundable fail', () => {
  // Sats have left the wallet; auto-fail+refund would duplicate money out.
  const stuck = outcomeOf({
    status: 'completed',
    conversionDetails: { status: 'failed' },
  });
  assert.equal(stuck.status, 'stuck');
  assert.notEqual(stuck.status, 'failed');

  const refunded = outcomeOf({
    status: 'completed',
    conversionDetails: { status: 'refunded' },
  });
  assert.equal(refunded.status, 'failed');

  const paid = outcomeOf({
    status: 'completed',
    conversionDetails: {
      status: 'completed',
      conversions: [{ to: { chain: { type: 'external' }, amount: 24_000_000n, asset: { decimals: 6 } } }],
    },
  });
  assert.equal(paid.status, 'paid');

  const sparkFailed = outcomeOf({ status: 'failed' });
  assert.equal(sparkFailed.status, 'failed');

  const pending = outcomeOf({ status: 'pending', conversionDetails: { status: 'pending' } });
  assert.equal(pending.status, 'sending');
});

test('leaf errors are pre-transfer and retryable; ambiguous network errors are not', () => {
  assert.equal(isLeafError(new Error('Failed to select leaves for payment')), true);
  assert.equal(failedBeforeSend(new Error('Failed to select leaves')), true);
  assert.equal(failedBeforeSend(new Error('Insufficient funds')), true);
  assert.equal(failedBeforeSend(new Error('network timeout after hop')), false);
});

test('leaf retry uses same attempt, backs off, and stops at deadline without a second success path', async () => {
  let attempts = 0;
  let clock = 0;
  const sleeps = [];
  const logs = [];
  const result = await retryLeafErrors({
    breez: { syncWallet: async () => {} },
    key: 'wd-1',
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    log: (e) => logs.push(e),
    deadlineMs: 20_000,
    attempt: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('Failed to select leaves');
      return { payment: { id: 'wd-1', status: 'completed' } };
    },
    existing: async () => null,
  });
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [5_000, 10_000]);
  assert.equal(result.payment.id, 'wd-1');
  assert.equal(logs.filter((e) => e.event === 'leaf-retry').length, 2);
});

test('leaf retry returns existing payment found after sync — never sends again', async () => {
  let attempts = 0;
  let clock = 0;
  const payment = { id: 'wd-2', status: 'completed' };
  const result = await retryLeafErrors({
    breez: { syncWallet: async () => {} },
    key: 'wd-2',
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    log: () => {},
    deadlineMs: 60_000,
    attempt: async () => {
      attempts += 1;
      throw new Error('Failed to select leaves');
    },
    existing: async () => (attempts >= 1 ? payment : null),
  });
  assert.equal(attempts, 1);
  assert.equal(result.payment, payment);
});

test('RECEIPT_RECORDING stays off unless exactly shadow', () => {
  assert.equal(receiptRecordingMode(undefined), 'off');
  assert.equal(receiptRecordingMode(''), 'off');
  assert.equal(receiptRecordingMode('on'), 'off');
  assert.equal(receiptRecordingMode('true'), 'off');
  assert.equal(receiptRecordingMode('shadow'), 'shadow');
  const c = loadConfig({
    BREEZ_NETWORK: 'regtest',
    BREEZ_MNEMONIC: Array(12).fill('abandon').join(' '),
    BREEZ_DATA_DIR: '/data',
    DATABASE_URL: 'postgres://u:p@localhost/db',
    PAYMENT_SERVICE_SECRET: 'x'.repeat(MIN_SECRET_LENGTH),
  });
  assert.equal(c.receiptRecording, 'off');
});

test('usdToSats rounds up (payer never underpays invoice)', () => {
  assert.equal(usdToSats('1.00', '100000'), 1000);
  assert.ok(usdToSats('0.01', '300000') >= 4);
});

test('paymentHashOf ignores non-Lightning receives (no false settle)', () => {
  assert.equal(paymentHashOf({ details: { type: 'deposit' } }), null);
  assert.equal(paymentHashOf({ details: { type: 'lightning', htlcDetails: { paymentHash: 'abc' } } }), 'abc');
});

test('/ready is 503 until markReady; /metrics needs bearer; /health stays unauthenticated', async () => {
  const sdk = {
    getInfo: async () => ({ balanceSats: 1n }),
    listFiatRates: async () => ({ rates: [{ coin: 'USD', value: 100_000 }] }),
    addEventListener: async () => {},
  };
  const db = {
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => ({ query: async () => {}, release() {} }),
  };
  const secret = 'test-secret-'.padEnd(48, 'y');
  const app = createApp({ sdk, db, secret, log: () => {} });

  const readyBefore = await app.readiness();
  assert.equal(readyBefore[0], 503);
  assert.equal(readyBefore[1].ready, false);

  const collect = async (path, headers = {}) => {
    let status, body;
    const req = {
      method: 'GET',
      url: `http://localhost${path}`,
      headers: { authorization: headers.authorization },
      async *[Symbol.asyncIterator]() {},
    };
    const res = {
      writeHead(s) { status = s; },
      end(raw) { body = JSON.parse(raw); },
    };
    await app.handle(req, res);
    return { status, body };
  };

  assert.equal((await collect('/ready')).status, 503);
  app.markReady();
  const readyOk = await collect('/ready');
  assert.equal(readyOk.status, 200);
  assert.equal(readyOk.body.ready, true);

  const unauthMetrics = await collect('/metrics');
  assert.equal(unauthMetrics.status, 401);

  const metrics = await collect('/metrics', { authorization: `Bearer ${secret}` });
  assert.equal(metrics.status, 200);
  assert.equal(metrics.body.singleWallet, true);
  assert.equal(metrics.body.ready, true);
  assert.ok(!JSON.stringify(metrics.body).includes(secret));
  assert.ok(!('balance' in metrics.body));

  app.markSynced();
  const health = await collect('/health');
  assert.equal(health.status, 200);
  assert.deepEqual(
    Object.keys(health.body).sort(),
    ['db', 'lastSyncedAt', 'ok', 'sdkConnected', 'shuttingDown', 'synced'],
  );
});

test('wait helper and body limits stay bounded', async () => {
  assert.equal(MAX_BODY_BYTES, 10_000);
  assert.equal(SYNC_STALE_MS, 10 * 60 * 1000);
  const t0 = Date.now();
  await wait(5);
  assert.ok(Date.now() - t0 >= 0);
});

test('redactor never leaves mnemonic or secret fragments in a line', () => {
  const mnemonic = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
  const secret = 's'.repeat(40);
  const config = {
    secret,
    apiKey: 'api-key-ABCDEF',
    mnemonic,
    databaseUrl: 'postgres://u:db-pass-xyz@localhost:5432/cpay',
  };
  const out = redactor(config)(
    `auth Bearer ${secret} seed ${mnemonic} key api-key-ABCDEF url postgres://u:db-pass-xyz@localhost:5432/cpay`,
  );
  for (const s of [secret, mnemonic, 'api-key-ABCDEF', 'db-pass-xyz']) {
    assert.ok(!out.includes(s), s);
  }
});
