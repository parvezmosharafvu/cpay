import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import * as ledger from './ledger.mjs';

// Runs against a database with every migration applied (CI's migrations
// job, or notes/run-ci-local.sh). Everything happens inside one
// transaction that is rolled back.
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const creator = '33333333-3333-3333-3333-333333333333';
const hash = 'ab'.repeat(32);

function receive(id, amountSat, paymentHash = hash) {
  return {
    id, paymentType: 'receive', status: 'completed', amount: BigInt(amountSat), fees: 0n, timestamp: 0,
    method: 'lightning', details: { type: 'lightning', invoice: 'lnbcrt1...', htlcDetails: { paymentHash } },
  };
}

async function earned() {
  const { rows } = await db.query('select earned::text from get_balance_for($1)', [creator]);
  return rows[0].earned;
}

async function statusOf(paymentHash) {
  const { rows } = await db.query('select status from payments where invoice_ref = $1', [paymentHash]);
  return rows[0].status;
}

before(async () => {
  await db.connect();
  await db.query('begin');
  await db.query(`insert into auth.users(id, email) values ($1, 'ledger-test@test.invalid')`, [creator]);
  await db.query(
    `insert into payments(user_id, invoice_ref, lightning_invoice, amount_requested, amount_sat, btc_usd_rate, status, expires_at)
     values ($1, $2, 'lnbcrt1a', 10.00, 11913, 83948.80, 'new', now() + interval '1 hour'),
            ($1, $3, 'lnbcrt1b', 5.00, 5957, 83948.80, 'new', now() + interval '1 hour'),
            ($1, $4, 'lnbcrt1c', 7.00, 8339, 83948.80, 'new', now() - interval '1 minute')`,
    [creator, hash, 'cd'.repeat(32), 'ef'.repeat(32)],
  );
});

after(async () => {
  await db.query('rollback');
  await db.end();
});

test('usdToSats rounds up so the invoice never undercharges', () => {
  assert.equal(ledger.usdToSats('10.00', 83948.8), 11913);
});

test('a received payment settles its row once, and replays credit nothing', async () => {
  assert.equal(await earned(), '0');
  assert.equal(await ledger.settlePayment(db, receive('breez-1', 11913)), 'settled');
  assert.equal(await statusOf(hash), 'settled');
  assert.equal(await earned(), '9.70000000');
  for (let i = 0; i < 3; i++) {
    assert.equal(await ledger.settlePayment(db, receive('breez-1', 11913)), 'duplicate');
  }
  assert.equal(await ledger.settlePayment(db, receive('breez-2', 11913)), 'already_settled');
  assert.equal(await earned(), '9.70000000');
});

test('a payment for an unknown hash credits nothing', async () => {
  assert.equal(await ledger.settlePayment(db, receive('breez-3', 1000, '00'.repeat(32))), 'unknown');
  assert.equal(await earned(), '9.70000000');
});

test('fewer sats than invoiced leaves the row unpaid', async () => {
  assert.equal(await ledger.settlePayment(db, receive('breez-4', 5956, 'cd'.repeat(32))), 'underpaid');
  assert.equal(await statusOf('cd'.repeat(32)), 'new');
  assert.equal(await earned(), '9.70000000');
});

test('an unpaid invoice past its expiry becomes expired and credits nothing', async () => {
  assert.equal(await ledger.expireUnpaid(db), 1);
  assert.equal(await statusOf('ef'.repeat(32)), 'expired');
  assert.equal(await statusOf('cd'.repeat(32)), 'new');
  assert.equal(await earned(), '9.70000000');
});

test('a payment that arrives after expiry still settles, because the sats are in the wallet', async () => {
  assert.equal(await ledger.settlePayment(db, receive('breez-7', 8339, 'ef'.repeat(32))), 'settled');
  assert.equal(await statusOf('ef'.repeat(32)), 'settled');
  assert.equal(await earned(), '16.49000000');
});

test('sends and non-lightning receives are ignored', async () => {
  assert.equal(await ledger.settlePayment(db, { ...receive('breez-5', 11913), paymentType: 'send' }), 'ignored');
  assert.equal(await ledger.settlePayment(db, { ...receive('breez-6', 11913), details: { type: 'deposit', txId: 'x', vout: 0 } }), 'no_hash');
});
