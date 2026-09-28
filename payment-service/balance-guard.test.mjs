import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

// Migration 0103: the database refuses any withdrawal that would take a
// balance below zero, whichever path writes it. Runs against a database
// with every migration applied; each test uses a fresh user.
const url = process.env.DATABASE_URL;
const db = new pg.Pool({ connectionString: url, max: 6 });
const users = [];
const TRON = 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL';

after(async () => {
  if (users.length) await db.query('delete from auth.users where id = any($1::uuid[])', [users]);
  await db.end();
});

async function makeUser(earned) {
  const id = randomUUID();
  users.push(id);
  await db.query(`insert into auth.users(id, email) values ($1, $2)`, [id, `guard-${id}@test.invalid`]);
  await db.query(`update profiles set account_status = 'active', withdrawal_fee_percent = 0 where id = $1`, [id]);
  await db.query(
    `insert into payments(user_id, amount_requested, amount_settled, status, settled_at, expires_at)
     values ($1, $2, $2, 'settled', now(), now() + interval '1 hour')`, [id, earned]);
  return id;
}

const available = async (id) => (await db.query('select available::text from get_balance_for($1)', [id])).rows[0].available;

// A raw insert, as the service role or an admin edit would write it: none
// of the checks the withdrawal functions make.
const INSERT = `insert into withdrawals(user_id, amount_requested, fee_percent, amount_after_fee, method, destination, status)
                values ($1, $2, 0, $2, 'bank', 'acct-1', 'pending') returning id`;

test('a raw insert past the balance is refused, one inside it is accepted', async () => {
  const user = await makeUser(100);
  await assert.rejects(db.query(INSERT, [user, 100.01]), /Insufficient balance. Available: \$100.00/);
  await db.query(INSERT, [user, 100]);
  assert.equal(await available(user), '0.00000000');
  await assert.rejects(db.query(INSERT, [user, 0.01]), /Insufficient balance. Available: \$0.00/);
});

test('two concurrent raw inserts that fit alone but not together: exactly one commits', async () => {
  const user = await makeUser(100);
  const a = new pg.Client({ connectionString: url });
  const b = new pg.Client({ connectionString: url });
  await a.connect();
  await b.connect();
  try {
    await a.query('begin');
    await b.query('begin');
    await a.query(INSERT, [user, 60]);
    // b's trigger waits on the profile row lock a holds.
    const bInsert = b.query(INSERT, [user, 60]).then(() => 'inserted', (e) => e.message);
    const early = await Promise.race([bInsert, new Promise((r) => setTimeout(() => r('waiting'), 300))]);
    assert.equal(early, 'waiting');
    await a.query('commit');
    assert.match(await bInsert, /Insufficient balance. Available: \$40.00/);
    await b.query('rollback');
  } finally {
    await a.end();
    await b.end();
  }
  assert.equal(await available(user), '40.00000000');
  const { rows } = await db.query('select amount_requested::text from withdrawals where user_id = $1', [user]);
  assert.deepEqual(rows.map((r) => r.amount_requested), ['60.00000000']);
});

test('two concurrent stablecoin reservations for different quotes: one is refused and the balance never goes negative', async () => {
  const user = await makeUser(100);
  const expires = new Date(Date.now() + 60_000).toISOString();
  const reserve = () => db.query(
    'select id from reserve_stablecoin_withdrawal($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [user, randomUUID(), '70.00', '0.00', '70.00', 'USDT', 'tron', TRON, '0.5', '69.5', 70_000, expires],
  ).then(() => 'reserved', (e) => e.message);
  const results = await Promise.all([reserve(), reserve(), reserve()]);
  assert.equal(results.filter((r) => r === 'reserved').length, 1, results.join(' | '));
  for (const r of results.filter((x) => x !== 'reserved')) assert.match(r, /Insufficient balance/);
  assert.equal(await available(user), '30.00000000');
});

test('reopening a failed withdrawal is checked again; lowering an amount or paying one is not blocked', async () => {
  const user = await makeUser(100);
  const { rows: [first] } = await db.query(INSERT, [user, 80]);
  await db.query(`update withdrawals set status = 'failed' where id = $1`, [first.id]);
  await db.query(INSERT, [user, 50]);
  await assert.rejects(db.query(`update withdrawals set status = 'pending' where id = $1`, [first.id]), /Insufficient balance/);
  await assert.rejects(db.query(`update withdrawals set amount_requested = 100.01 where status = 'pending' and user_id = $1`, [user]), /Insufficient balance/);
  await db.query(`update withdrawals set amount_requested = 40, amount_after_fee = 40 where status = 'pending' and user_id = $1`, [user]);
  await db.query(`update withdrawals set status = 'paid' where status = 'pending' and user_id = $1`, [user]);
  assert.equal(await available(user), '60.00000000');
});
