import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import * as ledger from './ledger.mjs';
import { fakeBreez } from './fake-breez.mjs';
import { createApp } from './app.mjs';
import { createService } from './service.mjs';
import {
  createReceiptRecorder, settleWithReceipt, sanitizePayload, receiptArgs, failureClass,
  PAYLOAD_KEYS, MAX_PAYLOAD_BYTES,
} from './receipts.mjs';

// F1 PR 1: the receipt log is record-only, and settlement behaves exactly
// as on main whatever happens to recording. Real database with every
// migration applied; rows are committed (recording uses its own pool, as in
// production) and removed afterwards.
const url = process.env.DATABASE_URL;
const db = new pg.Pool({ connectionString: url, max: 4 });
const recordPool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 1_000, options: '-c statement_timeout=2000' });
const run = `rt${randomBytes(4).toString('hex')}`;
const users = [];
const ids = [];

after(async () => {
  await db.query('delete from lightning_receipts where provider_payment_id like $1', [`${run}%`]);
  await db.query('delete from webhook_events where delivery_id like $1', [`breez:${run}%`]);
  if (users.length) {
    await db.query(`delete from audit_log where actor_id = any($1::uuid[]) and set_config('cpay.audit_maintenance', 'on', true) = 'on'`, [users]);
    await db.query('delete from auth.users where id = any($1::uuid[])', [users]);
  }
  await recordPool.end();
  await db.end();
});

const newId = (tag = 'p') => { const id = `${run}-${tag}-${ids.length}`; ids.push(id); return id; };
const newHash = () => randomBytes(32).toString('hex');

function receive(id, amountSat, paymentHash, extra = {}) {
  return {
    id, paymentType: 'receive', status: 'completed', amount: BigInt(amountSat), fees: 0n, timestamp: 1_760_000_000,
    method: 'lightning',
    details: paymentHash === null ? { type: 'spark' } : { type: 'lightning', invoice: 'lnbcrt1secretinvoice', description: 'tip', preimage: 'ff'.repeat(32), htlcDetails: { paymentHash, status: 'preimageShared', expiryTime: 1_760_003_600 } },
    ...extra,
  };
}

async function makeUser() {
  const id = randomUUID();
  users.push(id);
  await db.query(`insert into auth.users(id, email) values ($1, $2)`, [id, `rt-${id}@test.invalid`]);
  await db.query(`update profiles set role = 'creator', account_status = 'active' where id = $1`, [id]);
  return id;
}

async function invoice(userId, { sat = 10_000, usd = 10, status = 'new', expired = false } = {}) {
  const hash = newHash();
  await db.query(
    `insert into payments(user_id, invoice_ref, lightning_invoice, amount_requested, amount_sat, btc_usd_rate, status, expires_at)
     values ($1, $2, 'lnbcrt1x', $3, $4, 100000, $5, now() + ($6 || ' minutes')::interval)`,
    [userId, hash, usd, sat, status, expired ? '-5' : '60'],
  );
  return hash;
}

async function paymentsOf(userId) {
  const { rows } = await db.query(
    `select invoice_ref, status, amount_settled::text, (settled_at is not null) as settled
       from payments where user_id = $1 order by amount_requested, invoice_ref`, [userId]);
  return rows;
}
const balance = async (userId) => (await db.query('select earned::text, available::text from get_balance_for($1)', [userId])).rows[0];
const receiptRow = async (id) => (await db.query('select * from lightning_receipts where provider_payment_id = $1', [id])).rows[0];
const receiptCount = async () => Number((await db.query('select count(*) from lightning_receipts where provider_payment_id like $1', [`${run}%`])).rows[0].count);

function recorder(recordDb, opts = {}) {
  const logs = [];
  const r = createReceiptRecorder({ mode: 'shadow', recordDb, log: (e) => logs.push(e), ...opts });
  return { r, logs };
}

// The fixture set: one creator, one delivery per scenario, in a fixed order.
// Returns what settlement answered and the resulting state, with hashes and
// ids replaced by scenario names so two runs can be compared.
async function scenarios(settleOne) {
  const user = await makeUser();
  const exact = await invoice(user, { usd: 10 });
  const under = await invoice(user, { usd: 11 });
  const over = await invoice(user, { usd: 12 });
  const late = await invoice(user, { usd: 13, status: 'expired', expired: true });
  const cancelled = await invoice(user, { usd: 14, status: 'invalid' });
  const names = { [exact]: 'exact', [under]: 'under', [over]: 'over', [late]: 'late', [cancelled]: 'cancelled' };
  const exactId = newId('exact');
  const deliveries = [
    ['exact', receive(exactId, 10_000, exact)],
    ['under', receive(newId('under'), 9_500, under)],
    ['over', receive(newId('over'), 12_500, over)],
    ['late', receive(newId('late'), 10_000, late)],
    ['cancelled', receive(newId('cancelled'), 10_000, cancelled)],
    ['unknown', receive(newId('unknown'), 10_000, newHash())],
    ['no_hash', receive(newId('nohash'), 10_000, null)],
    ['replay', receive(exactId, 10_000, exact)],
    ['second_receipt', receive(newId('second'), 10_000, exact)],
    ['send', { ...receive(newId('send'), 10_000, newHash()), paymentType: 'send' }],
    ['pending', { ...receive(newId('pending'), 10_000, newHash()), status: 'pending' }],
  ];
  const outcomes = {};
  for (const [name, p] of deliveries) outcomes[name] = await settleOne(p);
  const payments = (await paymentsOf(user)).map((r) => ({ ...r, invoice_ref: names[r.invoice_ref] }));
  const events = Number((await db.query(
    `select count(*) from webhook_events where delivery_id = any($1::text[])`, [deliveries.map(([, p]) => `breez:${p.id}`)])).rows[0].count);
  return { outcomes, payments, balance: await balance(user), events, deliveries };
}

// What main's settlement answers for the fixture set (ledger.settlePayment
// and settle_breez_payment are unchanged by this PR).
const GOLDEN = {
  exact: 'settled', under: 'underpaid', over: 'settled', late: 'settled', cancelled: 'not_settleable',
  unknown: 'unknown', no_hash: 'no_hash', replay: 'duplicate', second_receipt: 'already_settled',
  send: 'ignored', pending: 'ignored',
};
const strip = ({ deliveries, ...rest }) => rest;

test('golden: shadow recording answers and changes exactly what main does', async () => {
  const main = await scenarios((p) => ledger.settlePayment(db, p));
  assert.deepEqual(main.outcomes, GOLDEN);
  const off = await scenarios((p) => settleWithReceipt({ db, recorder: createReceiptRecorder({ mode: 'off', recordDb: recordPool }), payment: p, source: 'event' }));
  const { r, logs } = recorder(recordPool);
  const shadow = await scenarios((p) => settleWithReceipt({ db, recorder: r, payment: p, source: 'event' }));
  assert.deepEqual(strip(off), strip(main));
  assert.deepEqual(strip(shadow), strip(main));
  assert.deepEqual(shadow.balance, { earned: '33.95000000', available: '33.95000000' });
  assert.equal(logs.filter((e) => e.event === 'receipt-record-failed').length, 0);

  // Shadow recorded every completed receive (not the send or the pending
  // one) with the legacy outcome next to it.
  for (const [name, p] of shadow.deliveries) {
    const row = await receiptRow(p.id);
    if (name === 'send' || name === 'pending') { assert.equal(row, undefined, name); continue; }
    assert.ok(row, name);
    assert.equal(row.state, 'recorded');
    assert.equal(row.amount_sat, String(p.amount));
  }
  const exactRow = await receiptRow(shadow.deliveries[0][1].id);
  assert.equal(exactRow.legacy_outcome, 'settled');
  assert.equal(exactRow.last_legacy_outcome, 'duplicate');
  assert.equal(exactRow.seen_count, 2);
  assert.equal((await receiptRow(shadow.deliveries[1][1].id)).legacy_outcome, 'underpaid');
  assert.equal((await receiptRow(shadow.deliveries[6][1].id)).payment_hash, null);
  assert.equal((await receiptRow(shadow.deliveries[6][1].id)).legacy_outcome, 'no_hash');
  // Off and main recorded nothing.
  for (const [, p] of [...off.deliveries, ...main.deliveries]) assert.equal(await receiptRow(p.id), undefined);
});

test('repeat delivery (events, catch-up, concurrent) records one receipt', async () => {
  const user = await makeUser();
  const hash = await invoice(user);
  const p = receive(newId('repeat'), 10_000, hash);
  const { r } = recorder(recordPool);
  const outcomes = await Promise.all([
    settleWithReceipt({ db, recorder: r, payment: p, source: 'event' }),
    settleWithReceipt({ db, recorder: r, payment: p, source: 'catch-up' }),
    settleWithReceipt({ db, recorder: r, payment: p, source: 'event' }),
  ]);
  assert.deepEqual(outcomes.sort(), ['duplicate', 'duplicate', 'settled']);
  outcomes.length = 0;
  outcomes.push(await settleWithReceipt({ db, recorder: r, payment: p, source: 'catch-up' }));
  assert.deepEqual(outcomes, ['duplicate']);
  const { rows } = await db.query('select * from lightning_receipts where provider_payment_id = $1', [p.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].seen_count, 4);
  assert.equal(rows[0].conflict_count, 0);
  assert.equal(rows[0].legacy_outcome, 'settled');
  assert.deepEqual(r.stats().failed, 0);
  assert.equal((await balance(user)).earned, '9.70000000');
});

test('recording only: no balances, spendable, payments or other ledger tables change', async () => {
  const user = await makeUser();
  const hash = await invoice(user);
  const app = createApp({ sdk: fakeBreez(), db, secret: 'x'.repeat(48), log: () => {} });
  const snapshot = async () => (await db.query(
    `select (select md5(string_agg(t::text, ',' order by t.id)) from payments t) as payments,
            (select md5(coalesce(string_agg(t::text, ',' order by t.id), '')) from withdrawals t) as withdrawals,
            (select md5(string_agg(t::text, ',' order by t.id)) from profiles t) as profiles,
            (select count(*) from webhook_events) as events,
            (select count(*) from audit_log) as audit`)).rows[0];
  const before = { snap: await snapshot(), bal: await balance(user), health: await app.health() };
  const { r } = recorder(recordPool);
  // Every kind of receipt, recorded without settling: matched, overpaid,
  // underpaid, unknown, hash-less, conflicting replay.
  const id = newId('only');
  for (const p of [
    receive(id, 10_000, hash), receive(id, 99_999, hash), receive(newId('only'), 12_000, hash),
    receive(newId('only'), 1, hash), receive(newId('only'), 5_000, newHash()), receive(newId('only'), 5_000, null),
  ]) assert.equal(await r.recordReceipt(p, 'event'), true);
  await r.noteLegacyOutcome(receive(id, 10_000, hash), 'settled');
  assert.equal((await receiptRow(id)).conflict_count, 1);
  assert.deepEqual(await snapshot(), before.snap);
  assert.deepEqual(await balance(user), before.bal);
  const health = await app.health();
  assert.deepEqual({ ...health, lastSyncedAt: 0 }, { ...before.health, lastSyncedAt: 0 });
  assert.equal((await db.query('select status from payments where invoice_ref = $1', [hash])).rows[0].status, 'new');
});

// The five failure modes from the design (plus a broken recorder and an
// exhausted recording pool). In every one, settlement answers and changes
// exactly what it does on main, and the failure is logged.
async function settlesDespite(recordDb, failure, { opts = {}, mutate = (p) => p, recorderOverride } = {}) {
  const user = await makeUser();
  const hash = await invoice(user);
  const id = newId(failure);
  const { r, logs } = recorder(recordDb, opts);
  const started = Date.now();
  const outcome = await settleWithReceipt({ db, recorder: recorderOverride?.(r) ?? r, payment: mutate(receive(id, 10_000, hash)), source: 'event' });
  const elapsed = Date.now() - started;
  assert.equal(outcome, 'settled', failure);
  assert.deepEqual((await paymentsOf(user)).map((x) => x.status), ['settled']);
  assert.equal((await balance(user)).earned, '9.70000000');
  assert.equal(await receiptRow(id), undefined);
  if (!recorderOverride) {
    const failed = logs.filter((e) => e.event === 'receipt-record-failed');
    assert.equal(failed.length, 1, JSON.stringify(logs));
    assert.equal(failed[0].failure, failure);
    assert.equal(r.stats().failed, 1);
    assert.doesNotMatch(JSON.stringify(logs), /ff{16}|secretinvoice/);
  }
  return elapsed;
}

test('failure 1: record function missing', async () => {
  const missing = { query: (text, values) => recordPool.query(text.replace('record_lightning_receipt', 'record_lightning_receipt_missing'), values) };
  await settlesDespite(missing, 'function_missing');
});

test('failure 2: constraint violation', async () => {
  const bad = { query: (text, values) => recordPool.query(text, values.map((v, i) => (i === 6 ? { preimage: 'ff'.repeat(32) } : v))) };
  await settlesDespite(bad, 'constraint');
});

test('failure 3: statement timeout', async () => {
  const slowPool = new pg.Pool({ connectionString: url, max: 1, options: '-c statement_timeout=200' });
  try {
    const slow = { query: (text, values) => slowPool.query(`select pg_sleep(5), (${text.replace(' as outcome', '')}) as outcome`, values) };
    const elapsed = await settlesDespite(slow, 'timeout');
    assert.ok(elapsed < 2_000, `settled after ${elapsed}ms`);
  } finally { await slowPool.end(); }
});

test('failure 3b: client-side timeout when the server never answers', async () => {
  const hang = { query: () => new Promise(() => {}) };
  const elapsed = await settlesDespite(hang, 'timeout', { opts: { timeoutMs: 300 } });
  assert.ok(elapsed >= 300 && elapsed < 2_000, `settled after ${elapsed}ms`);
});

test('failure 4: connection error on the record call only', async () => {
  const dead = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:1/postgres', max: 1, connectionTimeoutMillis: 500 });
  try { await settlesDespite(dead, 'connection'); } finally { await dead.end(); }
});

test('failure 5: exception while mapping the payment', async () => {
  await settlesDespite(recordPool, 'mapping', {
    mutate: (p) => { Object.defineProperty(p.details, 'txId', { enumerable: true, get() { throw new Error('exotic SDK field'); } }); return p; },
  });
  // An id the receipt log cannot store faithfully (the legacy path can).
  await settlesDespite(recordPool, 'mapping', { mutate: (p) => ({ ...p, id: `${p.id} with space` }) });
});

test('failure 5b: a recorder that throws itself cannot stop settlement', async () => {
  await settlesDespite(recordPool, 'broken', {
    recorderOverride: (r) => ({ ...r, recordReceipt: () => { throw new Error('boom'); }, noteLegacyOutcome: () => { throw new Error('boom'); } }),
  });
  await settlesDespite(recordPool, 'broken', {
    recorderOverride: (r) => ({ ...r, recordReceipt: async () => true, noteLegacyOutcome: async () => { throw new Error('boom'); } }),
  });
});

test('recording pool exhausted: settlement waits at most the timeout and does not use it', async () => {
  const tiny = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 0 });
  const held = await tiny.connect();
  try {
    const elapsed = await settlesDespite(tiny, 'timeout', { opts: { timeoutMs: 300 } });
    assert.ok(elapsed < 2_000, `settled after ${elapsed}ms`);
  } finally { held.release(); await tiny.end(); }
});

test('the app settles through a dead recording database (catch-up path)', async () => {
  const user = await makeUser();
  const hash = await invoice(user);
  const id = newId('app');
  const dead = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:1/postgres', max: 1, connectionTimeoutMillis: 500 });
  const fake = fakeBreez();
  fake.received.push(receive(id, 10_000, hash));
  const logs = [];
  const app = createApp({ sdk: fake, db, secret: 'x'.repeat(48), log: (e) => logs.push(e), receiptRecording: 'shadow', recordDb: dead });
  try {
    await app.catchUp();
    assert.deepEqual((await paymentsOf(user)).map((x) => x.status), ['settled']);
    assert.ok(logs.some((e) => e.event === 'settle' && e.breezPaymentId === id && e.outcome === 'settled'));
    assert.ok(logs.some((e) => e.event === 'receipt-record-failed' && e.failure === 'connection'));
    assert.equal(app.receiptStats().failed, 1);
  } finally { await dead.end(); }
});

test('flag off (default, explicit, unknown values) records nothing and never touches recordDb', async () => {
  let calls = 0;
  const spy = { query: (...a) => { calls++; return recordPool.query(...a); } };
  for (const receiptRecording of [undefined, 'off', 'SHADOW', 'on', 'true', '']) {
    const user = await makeUser();
    const hash = await invoice(user);
    const id = newId('off');
    const fake = fakeBreez();
    fake.received.push(receive(id, 10_000, hash));
    const app = createApp({ sdk: fake, db, secret: 'x'.repeat(48), log: () => {}, recordDb: spy, ...(receiptRecording === undefined ? {} : { receiptRecording }) });
    await app.catchUp();
    assert.deepEqual((await paymentsOf(user)).map((x) => x.status), ['settled'], String(receiptRecording));
    assert.equal(await receiptRow(id), undefined);
  }
  assert.equal(calls, 0);
  // Shadow without a recording pool is off too.
  assert.equal(createReceiptRecorder({ mode: 'shadow' }).enabled, false);
});

test('the new migration leaves main\'s settlement path untouched (old service, new schema)', async () => {
  // ledger.settlePayment is main's code unchanged; run it with the M1
  // schema present and check it neither records nor behaves differently.
  // (CI also runs main's own payment-service tests against this schema.)
  const before = await receiptCount();
  const result = await scenarios((p) => ledger.settlePayment(db, p));
  assert.deepEqual(result.outcomes, GOLDEN);
  assert.equal(await receiptCount(), before);
});

test('payload allowlist: secrets and unknown fields never stored, sizes bounded', async () => {
  const hash = newHash();
  const p = {
    ...receive(`${run}-allow`, 10_000, hash),
    mnemonic: 'abandon '.repeat(12).trim(), seed: 'aa'.repeat(64), privateKey: 'bb'.repeat(32), preimage: 'cc'.repeat(32),
    conversionDetails: { from: 'x' }, lnurlPayInfo: { comment: 'hi' }, fees: 'free', timestamp: -5,
  };
  p.details.htlcDetails.preimage = 'dd'.repeat(32);
  p.details.htlcDetails.status = 'somethingNew';
  const out = sanitizePayload(p);
  for (const k of Object.keys(out)) assert.ok(PAYLOAD_KEYS.includes(k), k);
  const json = JSON.stringify(out);
  assert.doesNotMatch(json, /abandon|aaaa|bbbb|cccc|dddd|ffff|secretinvoice|tip|lnurl|conversion|from/);
  assert.equal(out.paymentHash, hash);
  assert.equal(out.droppedFields, 3); // fees, timestamp, htlcStatus failed validation
  for (const v of Object.values(out)) assert.ok(['string', 'number'].includes(typeof v));
  assert.ok(Buffer.byteLength(json) <= MAX_PAYLOAD_BYTES);
  // Oversized values are dropped, not truncated.
  const big = sanitizePayload({ ...receive('x'.repeat(5_000), 1, hash), amount: 10n ** 30n });
  assert.equal(big.id, undefined);
  assert.equal(big.amount, undefined);
  assert.equal(big.droppedFields, 2);
  assert.throws(() => receiptArgs({ ...receive('x'.repeat(201), 1, hash) }, 'event'), /id/);
  assert.throws(() => receiptArgs({ ...receive('has space', 1, hash) }, 'event'), /id/);
  // The database accepts what sanitizePayload builds and stores nothing else.
  const { r } = recorder(recordPool);
  assert.equal(await r.recordReceipt(p, 'catch-up'), true);
  const row = await receiptRow(p.id);
  assert.deepEqual(row.provider_payload, out);
  assert.equal(row.record_source, 'catch_up');
  // And refuses a payload with anything outside the allowlist.
  await assert.rejects(recordPool.query(
    'select public.record_lightning_receipt($1, $2, $3, $4, $5, $6, $7, $8)',
    [`${run}-allow2`, hash, 'lightning', 1, 0, null, { mnemonic: 'x' }, 'event']), (e) => failureClass(e) === 'constraint');
});

test('the service wires RECEIPT_RECORDING: shadow records on its own pool, off records nothing', async () => {
  for (const mode of ['shadow', 'off']) {
    const user = await makeUser();
    const hash = await invoice(user);
    const id = newId(`svc-${mode}`);
    const fake = fakeBreez();
    fake.received.push(receive(id, 10_000, hash));
    const logs = [];
    const config = {
      network: 'regtest', apiKey: '', mnemonic: Array(12).fill('abandon').join(' '), dataDir: '/nonexistent', databaseUrl: url,
      secret: 'x'.repeat(48), port: 0, catchUpMs: 3_600_000, shutdownTimeoutMs: 5_000, receiptRecording: mode,
    };
    const service = createService({ config, breez: { defaultConfig: (network) => ({ network }), connect: async () => fake }, log: (e) => logs.push(e) });
    try {
      await service.started;
      assert.deepEqual((await paymentsOf(user)).map((x) => x.status), ['settled'], mode);
      assert.ok(logs.some((e) => e.event === 'receipt-recording' && e.mode === mode));
      const row = await receiptRow(id);
      if (mode === 'shadow') {
        assert.equal(row.legacy_outcome, 'settled');
        assert.equal(row.record_source, 'catch_up');
      } else assert.equal(row, undefined);
      assert.doesNotMatch(JSON.stringify(logs), /abandon/);
    } finally { await service.stop('test-end'); }
  }
});
