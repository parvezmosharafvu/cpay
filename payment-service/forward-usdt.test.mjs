import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createForwarder } from './forward.mjs';
import { UserError } from './withdraw.mjs';

// USDT instant forward: accumulate to the route minimum, one batch, the batch
// id as the idempotency key, retry/recover/hold. Fake wallet and routes.
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const TRON = 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL';
const ROUTE = { id: 'orchestra:tron:usdt', chain: 'tron', asset: 'USDT', family: 'tron', decimals: 6, minUsdCents: 1000, maxUsdCents: 1_000_000 };

before(async () => {
  await db.query(`delete from platform_settings where key like 'instant_forward_%' or key = 'payment_mode'`);
  await db.query(`insert into platform_settings(key, value) values ('payment_mode', '"instant_forward"')`);
});
after(async () => {
  await db.query(`delete from platform_settings where key like 'instant_forward_%' or key = 'payment_mode'`);
  await db.end();
});

function fakes({ address = TRON } = {}) {
  const sent = new Map();
  const calls = [];
  const breez = {
    calls, sent, mode: 'ok',
    async sendPayment({ prepareResponse, idempotencyKey }) {
      calls.push(['send', idempotencyKey, prepareResponse.amountSat]);
      if (breez.mode === 'expired') throw new Error('Invalid input: quote expired');
      const p = { id: `pay-${idempotencyKey}`, status: 'completed', conversionDetails: { status: 'completed', conversions: [] } };
      sent.set(idempotencyKey, p);
      if (breez.mode === 'lost-reply') throw new Error('Network error: connection reset');
      return { payment: p };
    },
    async getPayment({ paymentId }) {
      if (!sent.has(paymentId)) throw new Error('Invalid input: Not found');
      return { payment: sent.get(paymentId) };
    },
  };
  const withdrawals = {
    async listRoutes() { return [ROUTE]; },
    async validateAddress(a) { if (a !== address) throw new UserError(422, 'That is not a valid TRON address'); return a; },
    async prepareCrossChain({ amountSat }) {
      return { prepared: { amountSat }, expiresAtMs: Date.now() + 60_000, receive: (amountSat / 1000).toFixed(2) };
    },
  };
  return { breez, withdrawals };
}
// 1 sat = $0.001 here, so the $10 minimum (+2%) is 10,200 sats.
const rate = async () => 100_000;

async function makeUser(address = TRON) {
  const id = randomUUID();
  await db.query(`insert into auth.users(id, email) values ($1, $2)`, [id, `usdtf-${id}@test.invalid`]);
  await db.query(`update profiles set account_status = 'active', platform_fee_percent = 0 where id = $1`, [id]);
  await db.query(`insert into usdt_wallets(user_id, network, address) values ($1, 'tron', $2)`, [id, address]);
  await db.query(`insert into receive_settings(user_id, method, usdt_network) values ($1, 'usdt', 'tron')`, [id]);
  return id;
}
async function pay(user, usd, sat) {
  const { rows } = await db.query(
    `insert into payments(user_id, amount_requested, method, status, expires_at) values ($1, $2, 'lightning', 'new', now() + interval '15 min') returning id`, [user, usd]);
  await db.query(`update payments set status = 'settled', amount_settled = $2, amount_sat = $3, settled_at = now() where id = $1`, [rows[0].id, usd, sat]);
  return (await db.query('select * from payment_forwards where payment_id = $1', [rows[0].id])).rows[0];
}
const rowsOf = async (u) => (await db.query('select * from payment_forwards where user_id = $1 order by created_at', [u])).rows;
const batchesOf = async (u) => (await db.query('select * from forward_batches where user_id = $1 order by created_at', [u])).rows;
const quiet = { log: () => {}, sleep: async () => {}, btcUsdRate: rate };

test('under the minimum accumulates; reaching it sends one batch once', async () => {
  const u = await makeUser();
  const { breez, withdrawals } = fakes();
  const fw = createForwarder({ breez, db, withdrawals, ...quiet });
  const a = await pay(u, 6, 6_000);
  assert.equal(a.kind, 'usdt');
  await fw.run({ synced: true });
  assert.equal((await rowsOf(u))[0].reason, 'accumulating');
  assert.equal(breez.calls.length, 0);
  await pay(u, 6, 6_000);
  await fw.run({ synced: true });
  await fw.run({ synced: true });
  const [b] = await batchesOf(u);
  assert.equal(b.status, 'forwarded');
  assert.equal(Number(b.amount_sat), 12_000);
  assert.deepEqual(breez.calls, [['send', b.id, 12_000]], 'one send, keyed by the batch');
  for (const r of await rowsOf(u)) { assert.equal(r.status, 'forwarded'); assert.equal(r.batch_id, b.id); }
});

test('a send refused before anything left (expired quote) retries with a new batch', async () => {
  const u = await makeUser();
  const { breez, withdrawals } = fakes();
  breez.mode = 'expired';
  const fw = createForwarder({ breez, db, withdrawals, ...quiet });
  await pay(u, 20, 20_000);
  await fw.run({ synced: true });
  const [r] = await rowsOf(u);
  assert.equal(r.status, 'retry');
  assert.equal((await batchesOf(u))[0].status, 'failed');
  breez.mode = 'ok';
  await db.query('update payment_forwards set next_attempt_at = now() where user_id = $1', [u]);
  await fw.run({ synced: true });
  const bs = await batchesOf(u);
  assert.equal(bs.length, 2);
  assert.equal(bs[1].status, 'forwarded');
});

test('a lost reply stays sending, then is settled from the wallet record', async () => {
  const u = await makeUser();
  const { breez, withdrawals } = fakes();
  breez.mode = 'lost-reply';
  const fw = createForwarder({ breez, db, withdrawals, ...quiet });
  await pay(u, 20, 20_000);
  breez.getPaymentReal = breez.getPayment;
  breez.getPayment = async () => { throw new Error('Invalid input: Not found'); };
  await fw.run({ synced: false });
  const [b] = await batchesOf(u);
  assert.equal(b.status, 'sending');
  breez.getPayment = breez.getPaymentReal;
  await db.query(`update forward_batches set updated_at = now() - interval '10 minutes' where id = $1`, [b.id]);
  await fw.run({ synced: true });
  assert.equal((await batchesOf(u))[0].status, 'forwarded');
  assert.equal(breez.calls.filter((c) => c[0] === 'send').length, 1);
});

test('an address the wallet rejects holds the forwards for the owner', async () => {
  const u = await makeUser('TXinvalidButShapedLikeTron1234567');
  const { breez, withdrawals } = fakes();
  const fw = createForwarder({ breez, db, withdrawals, ...quiet });
  await pay(u, 20, 20_000);
  await fw.run({ synced: true });
  assert.equal((await batchesOf(u))[0].status, 'held');
  const [r] = await rowsOf(u);
  assert.equal(r.status, 'owed');
  assert.equal(r.reason, 'invalid_address');
  assert.equal(breez.calls.length, 0);
});
