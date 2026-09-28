import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { TRON, fakeBreez } from './fake-breez.mjs';
import { createService } from './service.mjs';

// The whole service over real HTTP: a fake SDK, a real database with every
// migration applied, and createService() exactly as server.mjs calls it.
// Files run one at a time (npm test), because every service start runs a
// catch-up that looks at all 'sending' withdrawals.
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const SECRET = 'test-secret-'.padEnd(48, 'x');
const MNEMONIC = Array(12).fill('abandon').join(' ');
const users = [];
const running = [];

after(async () => {
  for (const s of running) await s.stop('test-end');
  if (users.length) {
    await db.query('delete from audit_log where actor_id = any($1::uuid[])', [users]);
    await db.query('delete from auth.users where id = any($1::uuid[])', [users]);
  }
  await db.end();
});

async function makeUser({ earned = 100, role = 'creator' } = {}) {
  const id = randomUUID();
  users.push(id);
  await db.query(`insert into auth.users(id, email) values ($1, $2)`, [id, `svc-${id}@test.invalid`]);
  await db.query(`update profiles set role = $2, account_status = 'active', withdrawal_fee_percent = 0 where id = $1`, [id, role]);
  if (earned) {
    await db.query(
      `insert into payments(user_id, amount_requested, amount_settled, status, settled_at, expires_at)
       values ($1, $2, $2, 'settled', now(), now() + interval '1 hour')`, [id, earned]);
  }
  return id;
}

async function available(userId) {
  return (await db.query('select available::text from get_balance_for($1)', [userId])).rows[0].available;
}

async function start(fake, overrides = {}) {
  const logs = [];
  const config = {
    network: 'regtest', apiKey: '', mnemonic: MNEMONIC, dataDir: '/nonexistent', databaseUrl: process.env.DATABASE_URL,
    secret: SECRET, port: 0, catchUpMs: 3_600_000, shutdownTimeoutMs: 5_000, ...overrides,
  };
  const breez = { defaultConfig: (network) => ({ network }), connect: async () => fake };
  const service = createService({ config, breez, log: (e) => logs.push(e) });
  running.push(service);
  const port = await service.started;
  const call = (path, { body, auth = `Bearer ${SECRET}`, method = body ? 'POST' : 'GET' } = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { ...(auth ? { authorization: auth } : {}), 'content-type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json(), connection: r.headers.get('connection') }));
  return { service, logs, call, port };
}

async function until(check, ms = 3_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const pending = (promise, ms = 300) => Promise.race([promise.then(() => 'settled'), new Promise((r) => setTimeout(() => r('pending'), ms))]);

test('health answers without the secret, with booleans and one sync time only', async () => {
  const { call } = await start(fakeBreez());
  const r = await call('/health', { auth: null });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['db', 'lastSyncedAt', 'ok', 'sdkConnected', 'shuttingDown', 'synced']);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.sdkConnected, true);
  assert.equal(r.body.synced, true);
  assert.equal(r.body.shuttingDown, false);
  assert.ok(!JSON.stringify(r.body).includes(SECRET));
  assert.equal((await call('/health', { body: {} })).status, 405);
});

test('every other route needs the exact secret, and a refused call reaches neither the SDK nor the database', async () => {
  const fake = fakeBreez();
  const { call } = await start(fake);
  const before = { ...fake.calls };
  for (const path of ['/invoices', '/withdraw/routes', '/withdraw/quote', '/withdraw/confirm', '/admin/wallet/info', '/nope']) {
    for (const auth of [null, '', `Bearer ${SECRET.slice(0, -1)}`, SECRET, `bearer ${SECRET}`, `Basic ${SECRET}`]) {
      const r = await call(path, { auth, body: {} });
      assert.equal(r.status, 401, `${path} with ${JSON.stringify(auth)}`);
      assert.deepEqual(r.body, { error: 'unauthorized' });
    }
  }
  assert.deepEqual(fake.calls, before);
});

test('malformed input gets a 4xx with a plain message, never a 500', async () => {
  const user = await makeUser();
  const { call, logs } = await start(fakeBreez());
  const cases = [
    ['/invoices', '{not json'], ['/invoices', '[1,2]'], ['/invoices', 'null'], ['/invoices', { paymentId: 42 }],
    ['/invoices', { paymentId: randomUUID() }], ['/invoices', { paymentId: `${randomUUID()}x` }],
    ['/withdraw/quote', { userId: 'x' }], ['/withdraw/quote', { userId: [user] }],
    ['/withdraw/quote', { userId: user, routeId: {}, address: TRON, amountUsd: '10' }],
    ['/withdraw/quote', { userId: user, routeId: 'orchestra:tron:usdt', address: { a: 1 }, amountUsd: '10' }],
    ['/withdraw/quote', { userId: user, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: { v: 10 } }],
    ['/withdraw/quote', { userId: user, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '-10' }],
    ['/withdraw/quote', { userId: user, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '1e3' }],
    ['/withdraw/confirm', { userId: user }], ['/withdraw/confirm', { userId: user, quoteId: 'abc' }],
    ['/withdraw/confirm', { userId: user, quoteId: randomUUID() }],
    ['/admin/wallet/info', { adminId: user }], ['/admin/wallet/send-confirm', { adminId: 'x', prepareId: 1 }],
    ['/withdraw/quote', JSON.stringify({ pad: 'x'.repeat(20_000) })],
  ];
  for (const [path, body] of cases) {
    const r = await call(path, { body });
    assert.ok(r.status >= 400 && r.status < 500, `${path} ${JSON.stringify(body).slice(0, 80)} -> ${r.status}`);
    assert.equal(typeof r.body.error, 'string');
  }
  assert.equal(logs.filter((e) => e.event === 'request-failed').length, 0);
});

test('a settled payment is credited once across replayed events and catch-up', async () => {
  const user = await makeUser({ earned: 0 });
  const hash = randomUUID().replaceAll('-', '').repeat(2);
  await db.query(
    `insert into payments(user_id, invoice_ref, lightning_invoice, amount_requested, amount_sat, btc_usd_rate, status, expires_at)
     values ($1, $2, 'lnbcrt1svc', 10.00, 10000, 100000, 'new', now() + interval '1 hour')`, [user, hash]);
  const fake = fakeBreez();
  const { service, logs } = await start(fake);
  const payment = {
    id: `svc-${hash.slice(0, 12)}`, paymentType: 'receive', status: 'completed', amount: 10000n, fees: 0n, timestamp: 0,
    method: 'lightning', details: { type: 'lightning', htlcDetails: { paymentHash: hash } },
  };
  fake.received.push(payment);
  // Catch-up finds it first (the event was missed), then the same event
  // arrives twice at once.
  await service.app.catchUp();
  fake.onEvent({ type: 'paymentSucceeded', payment });
  fake.onEvent({ type: 'paymentSucceeded', payment });
  await until(() => logs.filter((e) => e.event === 'settle' && e.breezPaymentId === payment.id).length === 3);
  const outcomes = logs.filter((e) => e.event === 'settle' && e.breezPaymentId === payment.id).map((e) => `${e.source}:${e.outcome}`);
  assert.deepEqual(outcomes, ['catch-up:settled', 'event:duplicate', 'event:duplicate']);
  const credited = (await db.query('select earned::text from get_balance_for($1)', [user])).rows[0].earned;
  assert.equal(credited, '9.70000000');
  const events = await db.query(`select count(*)::int as n from webhook_events where delivery_id = $1`, [`breez:${payment.id}`]);
  assert.equal(events.rows[0].n, 1);
});

test('SIGTERM mid-send: new connections are refused, the send finishes, then the SDK disconnects', async () => {
  const user = await makeUser({ earned: 100 });
  const fake = fakeBreez({ mode: 'hang' });
  const { service, call, port, logs } = await start(fake);
  const q = await call('/withdraw/quote', { body: { userId: user, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '30' } });
  assert.equal(q.status, 200);
  const confirming = call('/withdraw/confirm', { body: { userId: user, quoteId: q.body.quoteId } });
  await until(() => fake.calls.send === 1);

  const stopped = service.stop('SIGTERM');
  assert.equal(await pending(stopped), 'pending', 'stop waits for the send');
  assert.equal(fake.calls.disconnect, 0);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`), 'a new connection is refused');
  assert.equal(await available(user), '70.00000000');

  fake.releaseHang();
  const result = await stopped;
  assert.deepEqual(result, { ok: true, drained: true, disconnected: true });
  assert.deepEqual(fake.order, ['send-done', 'disconnect']);
  const confirmed = await confirming;
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.status, 'sending');
  assert.equal(confirmed.connection, 'close');
  assert.equal(fake.calls.send, 1);
  assert.equal(await available(user), '70.00000000');
  const drain = logs.find((e) => e.event === 'drain');
  assert.ok(drain.inflight >= 1);
});

test('shutdown waits for an admin send', async () => {
  const admin = await makeUser({ earned: 0, role: 'admin' });
  const fake = fakeBreez({ mode: 'hang' });
  const { service, call, logs } = await start(fake);
  const q = await call('/admin/wallet/stable-quote', { body: { adminId: admin, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '20' } });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  const sending = call('/admin/wallet/stable-confirm', { body: { adminId: admin, quoteId: q.body.quoteId ?? q.body.prepareId } });
  await until(() => fake.calls.send === 1);
  const stopped = service.stop('SIGTERM');
  assert.equal(await pending(stopped), 'pending');
  assert.equal(fake.calls.disconnect, 0);
  fake.releaseHang();
  assert.equal((await stopped).ok, true);
  assert.deepEqual(fake.order, ['send-done', 'disconnect']);
  assert.equal((await sending).status, 200);
  assert.equal(logs.filter((e) => e.event === 'request-failed').length, 0);
});

test('shutdown waits for a leaf optimization run to end', async () => {
  const fake = fakeBreez();
  const { service } = await start(fake);
  fake.onEvent({ type: 'autoOptimization', optimizationEvent: { type: 'started', totalRounds: 2 } });
  const stopped = service.stop('SIGINT');
  assert.equal(await pending(stopped), 'pending');
  fake.onEvent({ type: 'autoOptimization', optimizationEvent: { type: 'roundCompleted', currentRound: 1, totalRounds: 2 } });
  assert.equal(await pending(stopped), 'pending');
  fake.onEvent({ type: 'autoOptimization', optimizationEvent: { type: 'completed' } });
  assert.equal((await stopped).ok, true);
  assert.equal(fake.calls.disconnect, 1);
});

test('a send still running at the shutdown timeout: the SDK disconnects anyway and stop reports not ok', async () => {
  const user = await makeUser({ earned: 50 });
  const fake = fakeBreez({ mode: 'hang' });
  const { service, call } = await start(fake, { shutdownTimeoutMs: 300 });
  const q = await call('/withdraw/quote', { body: { userId: user, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '10' } });
  call('/withdraw/confirm', { body: { userId: user, quoteId: q.body.quoteId } }).catch(() => {});
  await until(() => fake.calls.send === 1);
  assert.deepEqual(await service.stop('SIGTERM'), { ok: false, drained: false, disconnected: true });
  // The row stays 'sending' with the money held; the next start's
  // reconcile settles it from the SDK (see withdraw.test.mjs crash tests).
  const { rows } = await db.query('select status from withdrawals where user_id = $1', [user]);
  assert.deepEqual(rows.map((r) => r.status), ['sending']);
  fake.releaseHang();
});

test('a confirm retried after a restart returns the same withdrawal and never sends again', async () => {
  const user = await makeUser({ earned: 100 });
  const first = fakeBreez();
  const a = await start(first);
  const q = await a.call('/withdraw/quote', { body: { userId: user, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '25' } });
  const c1 = await a.call('/withdraw/confirm', { body: { userId: user, quoteId: q.body.quoteId } });
  assert.equal(c1.status, 200);
  assert.equal((await a.service.stop('SIGTERM')).ok, true);

  // Same wallet after the restart: the SDK still knows the payment.
  const second = fakeBreez();
  for (const [k, v] of first.payments) second.payments.set(k, v);
  const b = await start(second);
  const c2 = await b.call('/withdraw/confirm', { body: { userId: user, quoteId: q.body.quoteId } });
  assert.equal(c2.status, 200);
  assert.equal(c2.body.withdrawalId, c1.body.withdrawalId);
  assert.equal(first.calls.send + second.calls.send, 1);
  assert.equal(await available(user), '75.00000000');
});

test('a request that arrives while draining is refused with 503', async () => {
  const fake = fakeBreez();
  const { service, call } = await start(fake);
  fake.onEvent({ type: 'autoOptimization', optimizationEvent: { type: 'started', totalRounds: 1 } });
  const agent = call('/withdraw/routes');
  assert.equal((await agent).status, 200);
  const stopped = service.stop('SIGTERM');
  await until(() => service.app && service.app.health().then(([, h]) => h.shuttingDown));
  const [status, health] = await service.app.health();
  assert.equal(status, 503);
  assert.equal(health.shuttingDown, true);
  fake.onEvent({ type: 'autoOptimization', optimizationEvent: { type: 'completed' } });
  await stopped;
});
