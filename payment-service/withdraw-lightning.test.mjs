import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { fakeBreez } from './fake-breez.mjs';
import { createWithdrawals, LIGHTNING_ROUTE_ID } from './withdraw.mjs';

// Manual Lightning withdrawal (20261021010000) against a migrated database:
// saved Lightning address or a Lightning invoice, one send per quote,
// a failed send returns the balance once, an unsaved address is refused,
// two confirms cannot spend one balance twice.
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const users = [];
const RATE = 100_000; // $1 = 1000 sats
const LNADDR = 'me@pay.example.com';

// fakeBreez() knows test Lightning invoices (lnbcrt<N>n1...) and addresses.
const lightningBreez = (opts = {}) => fakeBreez(opts);

async function makeUser({ earned = 50, fee = 2, savedLn = true } = {}) {
  const id = randomUUID();
  users.push(id);
  await db.query(`insert into auth.users(id, email) values ($1, $2)`, [id, `ln-${id}@test.invalid`]);
  await db.query(`update profiles set account_status = 'active', withdrawal_fee_percent = $2 where id = $1`, [id, fee]);
  await db.query(`insert into payments(user_id, amount_requested, amount_settled, status, settled_at, expires_at)
                  values ($1, $2, $2, 'settled', now(), now() + interval '1 hour')`, [id, earned]);
  if (savedLn) {
    const c = await db.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      await c.query(`insert into settlement_destinations(user_id, address, callback_host, min_sendable_msat, max_sendable_msat, checked_at, ready_at)
                     values ($1, $2, 'pay.example.com', 1000, 100000000000, now(), now() - interval '1 minute')`, [id, LNADDR]);
      await c.query('commit');
    } finally { c.release(); }
  }
  return id;
}
const available = async (id) => Number((await db.query('select available from get_balance_for($1)', [id])).rows[0].available);
const rowsFor = async (id) => (await db.query('select * from withdrawals where user_id = $1 order by requested_at', [id])).rows;
const svc = (breez) => createWithdrawals({ breez, db, btcUsdRate: async () => RATE, confirmWaitMs: 200 });

before(async () => { await db.query('select 1'); });
after(async () => {
  if (users.length) {
    await db.query('delete from withdrawals where user_id = any($1::uuid[])', [users]).catch(() => {});
    await db.query('delete from auth.users where id = any($1::uuid[])', [users]).catch(() => {});
  }
  await db.end();
});

test('saved Lightning address: quote shows one "you receive", confirm sends once and debits the balance', async () => {
  const user = await makeUser();
  const breez = lightningBreez();
  const w = svc(breez);
  const q = await w.quote({ userId: user, routeId: LIGHTNING_ROUTE_ID, address: LNADDR.toUpperCase(), amountUsd: '10.00' });
  assert.equal(q.amountUsd, '10.00');
  assert.equal(q.platformFeeUsd, '0.20');
  assert.equal(q.sendUsd, '9.80');
  assert.equal(q.amountSat, 9800);
  assert.equal(q.receive, '9800');
  const a = await w.confirm({ userId: user, quoteId: q.quoteId });
  const b = await w.confirm({ userId: user, quoteId: q.quoteId });
  assert.equal(a.withdrawalId, b.withdrawalId);
  assert.equal(breez.calls.send, 1);
  const [row] = await rowsFor(user);
  assert.equal(row.method, 'lightning');
  assert.equal(row.status, 'paid');
  assert.equal(await available(user), 40);
});

test('an unsaved Lightning address is refused; a Lightning invoice works without saving', async () => {
  const user = await makeUser({ savedLn: false });
  const w = svc(lightningBreez());
  await assert.rejects(w.quote({ userId: user, routeId: LIGHTNING_ROUTE_ID, address: 'thief@evil.example', amountUsd: '5' }), /Save this Lightning address/);
  // 5000 sats = $5.00 invoice; at 2% the balance pays $5.11.
  const q = await w.quote({ userId: user, routeId: LIGHTNING_ROUTE_ID, address: 'lnbcrt50000n1invoice', amountUsd: '' });
  assert.equal(q.amountSat, 5000);
  assert.ok(Number(q.sendUsd) >= 5);
  await w.confirm({ userId: user, quoteId: q.quoteId });
  assert.equal((await rowsFor(user))[0].status, 'paid');
});

test('a failed send returns the balance once', async () => {
  const user = await makeUser();
  const w = svc(lightningBreez({ mode: 'spark-failed' }));
  const q = await w.quote({ userId: user, routeId: LIGHTNING_ROUTE_ID, address: LNADDR, amountUsd: '20' });
  await w.confirm({ userId: user, quoteId: q.quoteId });
  assert.equal((await rowsFor(user))[0].status, 'failed');
  assert.equal(await available(user), 50);
});

test('two quotes for the whole balance: only one can be confirmed', async () => {
  const user = await makeUser({ earned: 30 });
  const w = svc(lightningBreez());
  const q1 = await w.quote({ userId: user, routeId: LIGHTNING_ROUTE_ID, address: LNADDR, amountUsd: '30' });
  const q2 = await w.quote({ userId: user, routeId: LIGHTNING_ROUTE_ID, address: LNADDR, amountUsd: '30' });
  const results = await Promise.allSettled([w.confirm({ userId: user, quoteId: q1.quoteId }), w.confirm({ userId: user, quoteId: q2.quoteId })]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.match(String(results.find((r) => r.status === 'rejected').reason.message), /Insufficient balance/);
  assert.equal(await available(user), 0);
});

test('amount over the balance and under the minimum are refused at quote', async () => {
  const user = await makeUser({ earned: 5 });
  const w = svc(lightningBreez());
  await assert.rejects(w.quote({ userId: user, routeId: LIGHTNING_ROUTE_ID, address: LNADDR, amountUsd: '6' }), /Insufficient balance/);
  await assert.rejects(w.quote({ userId: user, routeId: LIGHTNING_ROUTE_ID, address: LNADDR, amountUsd: '0.50' }), /Minimum Lightning withdrawal/);
});
