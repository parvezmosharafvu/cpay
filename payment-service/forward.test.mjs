import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createForwarder } from './forward.mjs';

// Instant forward worker against a database with every migration applied and
// a fake wallet. The mode is switched on for this file only and restored.
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const users = [];
const ADDR = 'me@pay.example.com';

before(async () => {
  await db.query(`delete from platform_settings where key like 'instant_forward_%' or key = 'payment_mode'`);
  await db.query(`insert into platform_settings(key, value) values ('payment_mode', '"instant_forward"')`);
});
after(async () => {
  await db.query(`delete from platform_settings where key like 'instant_forward_%' or key = 'payment_mode'`);
  await db.end();
});

function fakeWallet({ fee = 5, balanceSats = 10_000_000 } = {}) {
  const sent = new Map();
  const calls = [];
  const w = {
    calls, sent, fee, balanceSats, mode: 'ok',
    async parse(input) {
      if (input === ADDR) return { type: 'lightningAddress', address: input, payRequest: { callback: 'https://pay.example.com/cb', minSendable: 1000, maxSendable: 1e11 } };
      throw new Error('unrecognized');
    },
    async prepareLnurlPay({ amount, payRequest }) { calls.push(['prepare', Number(amount)]); return { amountSats: Number(amount), feeSats: w.fee, payRequest }; },
    async getInfo() { return { balanceSats: w.balanceSats }; },
    async syncWallet() { return {}; },
    async lnurlPay({ prepareResponse, idempotencyKey }) {
      calls.push(['pay', idempotencyKey]);
      if (w.mode === 'fail') throw new Error('no route');
      const p = sent.get(idempotencyKey) ?? { id: `pay-${idempotencyKey}`, status: 'completed', amount: BigInt(prepareResponse.amountSats), fees: BigInt(w.fee) };
      sent.set(idempotencyKey, p);
      if (w.mode === 'lost-reply') throw new Error('Network error: connection reset');
      return { payment: p };
    },
    async getPayment({ paymentId }) {
      if (!sent.has(paymentId)) throw new Error('Invalid input: Not found');
      return { payment: sent.get(paymentId) };
    },
  };
  return w;
}

async function makeUser() {
  const id = randomUUID();
  users.push(id);
  await db.query(`insert into auth.users(id, email) values ($1, $2)`, [id, `fwd-${id}@test.invalid`]);
  await db.query(`update profiles set account_status = 'active', platform_fee_percent = 3 where id = $1`, [id]);
  await db.query(`select system_set_settlement_destination($1, $2, 'pay.example.com', 1000, 100000000000)`, [id, ADDR]);
  const c = await db.connect();
  try {
    await c.query('begin');
    await c.query('alter table settlement_destinations disable trigger trg_guard_settlement_destination_changes');
    await c.query(`update settlement_destinations set ready_at = now() - interval '1 minute' where user_id = $1`, [id]);
    await c.query('alter table settlement_destinations enable trigger trg_guard_settlement_destination_changes');
    await c.query('commit');
  } finally { c.release(); }
  return id;
}

async function pay(user, usd, sat) {
  const { rows } = await db.query(
    `insert into payments(user_id, amount_requested, method, status, expires_at) values ($1, $2, 'lightning', 'new', now() + interval '15 min') returning id`, [user, usd]);
  await db.query(`update payments set status = 'settled', amount_settled = $2, amount_sat = $3, settled_at = now() where id = $1`, [rows[0].id, usd, sat]);
  return (await db.query('select * from payment_forwards where payment_id = $1', [rows[0].id])).rows[0];
}
const row = async (id) => (await db.query('select * from payment_forwards where id = $1', [id])).rows[0];
const quiet = { log: () => {}, sleep: async () => {} };

test('forwards fee-deducted amount once; network fee from the forward; never twice', async () => {
  const u = await makeUser();
  const f = await pay(u, 10, 10_000);
  assert.equal(f.status, 'queued');
  assert.equal(Number(f.forward_sat), 9_700);
  const w = fakeWallet();
  const fw = createForwarder({ breez: w, db, ...quiet });
  await fw.run({ synced: true });
  const r = await row(f.id);
  assert.equal(r.status, 'forwarded');
  assert.equal(Number(r.sent_sat) + Number(r.routing_fee_sat) + Number(r.remainder_sat), 9_700);
  assert.equal(Number(r.sent_sat), 9_695);
  await fw.run({ synced: true });
  await fw.run({ synced: true });
  assert.equal(w.calls.filter((c) => c[0] === 'pay' && c[1] === f.id).length, 1, 'one send');
  const inv = (await db.query('select instant_forward_invariants() as r')).rows[0].r;
  assert.equal(inv.ok, true);
});

test('two workers at once: one claims, the other gets nothing', async () => {
  const u = await makeUser();
  const f = await pay(u, 5, 5_000);
  const w = fakeWallet();
  const a = createForwarder({ breez: w, db, ...quiet });
  const b = createForwarder({ breez: w, db, ...quiet });
  await Promise.all([a.run({ synced: true }), b.run({ synced: true })]);
  assert.equal(w.calls.filter((c) => c[0] === 'pay' && c[1] === f.id).length, 1);
  assert.equal((await row(f.id)).status, 'forwarded');
});

test('lost reply after the transfer: found by key, forwarded, not resent', async () => {
  const u = await makeUser();
  const f = await pay(u, 4, 4_000);
  const w = fakeWallet();
  w.mode = 'lost-reply';
  await createForwarder({ breez: w, db, ...quiet }).run({ synced: true });
  assert.equal((await row(f.id)).status, 'forwarded');
  assert.equal(w.calls.filter((c) => c[0] === 'pay').length, 1);
});

test('partial failure: retry with backoff, then owed after max attempts', async () => {
  await db.query(`insert into platform_settings(key, value) values ('instant_forward_max_attempts', '2') on conflict (key) do update set value = excluded.value`);
  try {
    const u = await makeUser();
    const f = await pay(u, 3, 3_000);
    const w = fakeWallet();
    w.mode = 'fail';
    const fw = createForwarder({ breez: w, db, ...quiet });
    await fw.run({ synced: true });
    let r = await row(f.id);
    assert.equal(r.status, 'retry');
    assert.match(r.last_error, /no route/);
    await db.query(`update payment_forwards set next_attempt_at = now() - interval '1 second' where id = $1`, [f.id]);
    await fw.run({ synced: true });
    r = await row(f.id);
    assert.equal(r.status, 'owed');
    assert.equal(r.reason, 'failed');
  } finally {
    await db.query(`delete from platform_settings where key = 'instant_forward_max_attempts'`);
  }
});

test('network fee over the cap: not sent, retried', async () => {
  const u = await makeUser();
  const f = await pay(u, 2, 2_000);
  const w = fakeWallet({ fee: 500 });
  await createForwarder({ breez: w, db, ...quiet }).run({ synced: true });
  assert.equal((await row(f.id)).status, 'retry');
  assert.equal(w.calls.filter((c) => c[0] === 'pay').length, 0);
});

test('wallet too low: not sent, retried', async () => {
  const u = await makeUser();
  const f = await pay(u, 2, 2_000);
  const w = fakeWallet({ balanceSats: 10 });
  await createForwarder({ breez: w, db, ...quiet }).run({ synced: true });
  assert.equal((await row(f.id)).status, 'retry');
  assert.equal(w.calls.filter((c) => c[0] === 'pay').length, 0);
});

test('crash while sending: recovered from the wallet record, or retried after a sync', async () => {
  const u = await makeUser();
  const f1 = await pay(u, 6, 6_000);
  const f2 = await pay(u, 7, 7_000);
  // Simulate a crash: both claimed, one sent, no finish recorded.
  await db.query(`update payment_forwards set status = 'sending', attempts = 1 where id = any($1)`, [[f1.id, f2.id]]);
  const w = fakeWallet();
  w.sent.set(f1.id, { id: 'pay-x', status: 'completed', amount: 5_800n, fees: 4n });
  const fw = createForwarder({ breez: w, db, ...quiet });
  // updated_at is reset by the guard trigger; age it with the trigger off.
  const c = await db.connect();
  try {
    await c.query('begin');
    await c.query('alter table payment_forwards disable trigger trg_payment_forwards_guard');
    await c.query(`update payment_forwards set updated_at = now() - interval '10 minutes' where id = any($1)`, [[f1.id, f2.id]]);
    await c.query('alter table payment_forwards enable trigger trg_payment_forwards_guard');
    await c.query('commit');
  } finally { c.release(); }
  await fw.recover(false);
  assert.equal((await row(f1.id)).status, 'forwarded');
  assert.equal((await row(f2.id)).status, 'sending', 'not trusted before a sync');
  await fw.recover(true);
  assert.equal((await row(f2.id)).status, 'retry');
  assert.equal(w.calls.filter((c) => c[0] === 'pay').length, 0, 'recovery never sends');
});

test('balance mode: nothing is claimed or sent', async () => {
  const u = await makeUser();
  const f = await pay(u, 2, 2_000);
  await db.query(`update platform_settings set value = '"balance"' where key = 'payment_mode'`);
  try {
    const w = fakeWallet();
    await createForwarder({ breez: w, db, ...quiet }).run({ synced: true });
    assert.equal((await row(f.id)).status, 'queued');
    assert.equal(w.calls.length, 0);
  } finally {
    await db.query(`update platform_settings set value = '"instant_forward"' where key = 'payment_mode'`);
  }
});
