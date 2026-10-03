import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import * as ledger from './ledger.mjs';

// Runs against a database with every migration applied (CI's migrations
// job, or notes/run-ci-local.sh). Everything happens inside one
// transaction that is rolled back.
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const creator = '33333333-3333-3333-3333-333333333333';
const admin = '44444444-4444-4444-4444-444444444444';
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
  await db.query(`create or replace function auth.uid() returns uuid
    language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$`);
  await db.query('grant usage on schema auth to authenticated');
  await db.query('grant execute on function auth.uid() to authenticated');
  await db.query(`insert into auth.users(id, email) values ($1, 'ledger-test@test.invalid')`, [creator]);
  await db.query(`insert into auth.users(id, email) values ($1, 'ledger-admin@test.invalid')`, [admin]);
  await db.query(`update profiles set role = 'admin', account_status = 'active' where id = $1`, [admin]);
  await db.query(
    `insert into payments(user_id, invoice_ref, lightning_invoice, amount_requested, amount_sat, btc_usd_rate, status, expires_at)
     values ($1, $2, 'lnbcrt1a', 10.00, 11913, 83948.80, 'new', now() + interval '1 hour'),
            ($1, $3, 'lnbcrt1b', 5.00, 5957, 83948.80, 'new', now() + interval '1 hour'),
            ($1, $4, 'lnbcrt1c', 7.00, 8339, 83948.80, 'new', now() - interval '1 minute'),
            ($1, $5, 'lnbcrt1d', 3.00, 3570, 83948.80, 'new', now() + interval '1 hour')`,
    [creator, hash, 'cd'.repeat(32), 'ef'.repeat(32), '12'.repeat(32)],
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
  assert.equal((await db.query(`select settlement_outcome from webhook_events where delivery_id = 'breez:breez-2'`)).rows[0].settlement_outcome, 'already_settled');
});

test('a payment for an unknown hash credits nothing', async () => {
  assert.equal(await ledger.settlePayment(db, receive('breez-3', 1000, '00'.repeat(32))), 'unknown');
  assert.equal((await db.query(`select settlement_outcome, receipt_amount_sat from webhook_events where delivery_id = 'breez:breez-3'`)).rows[0].settlement_outcome, 'unknown');
  assert.equal(await earned(), '9.70000000');
});

test('fewer sats than invoiced leaves the row unpaid', async () => {
  assert.equal(await ledger.settlePayment(db, receive('breez-4', 5956, 'cd'.repeat(32))), 'underpaid');
  assert.equal(await statusOf('cd'.repeat(32)), 'new');
  assert.equal((await db.query(`select settlement_outcome, receipt_amount_sat from webhook_events where delivery_id = 'breez:breez-4'`)).rows[0].settlement_outcome, 'underpaid');
  assert.equal(await earned(), '9.70000000');
});

test('an overpaid receipt settles the invoice once and remains visible for reconciliation', async () => {
  assert.equal(await ledger.settlePayment(db, receive('breez-5', 3571, '12'.repeat(32))), 'overpaid');
  assert.equal(await statusOf('12'.repeat(32)), 'settled');
  assert.equal((await db.query(`select amount_settled::text from payments where invoice_ref = $1`, ['12'.repeat(32)])).rows[0].amount_settled, '3.00000000');
  assert.equal((await db.query(`select settlement_outcome, receipt_amount_sat from webhook_events where delivery_id = 'breez:breez-5'`)).rows[0].receipt_amount_sat, '3571');
  assert.equal(await earned(), '12.61000000');
});

test('Lightning receipts without a payment hash are persisted as unknown', async () => {
  assert.equal(await ledger.settlePayment(db, { ...receive('breez-no-hash', 1200), details: { type: 'lightning' } }), 'unknown');
  const { rows } = await db.query(`select invoice_id, settlement_outcome, receipt_amount_sat from webhook_events where delivery_id = 'breez:breez-no-hash'`);
  assert.deepEqual(rows[0], { invoice_id: null, settlement_outcome: 'unknown', receipt_amount_sat: '1200' });
});

test('only admins can view unreconciled Lightning receipts', async () => {
  await db.query('savepoint unauthorized_reconciliation');
  await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [creator]);
  await db.query('set local role authenticated');
  await assert.rejects(db.query('select * from admin_list_lightning_reconciliation(100)'), /Not authorized/);
  await db.query('rollback to savepoint unauthorized_reconciliation');

  await db.query('savepoint admin_reconciliation');
  await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [admin]);
  await db.query('set local role authenticated');
  const { rows } = await db.query('select * from admin_list_lightning_reconciliation(100)');
  assert.ok(rows.some((r) => r.settlement_outcome === 'unknown' && r.breez_payment_id === 'breez-3'));
  assert.ok(rows.some((r) => r.settlement_outcome === 'underpaid' && r.receipt_amount_sat === '5956'));
  assert.ok(rows.some((r) => r.settlement_outcome === 'overpaid' && r.invoice_amount_sat === '3570'));
  await db.query('rollback to savepoint admin_reconciliation');
});

test('webhook pruning retains financial reconciliation exceptions', async () => {
  await db.query(`update webhook_events set received_at = now() - interval '91 days'
    where delivery_id in ('breez:breez-1', 'breez:breez-3')`);
  await db.query('select prune_webhook_events()');
  const { rows } = await db.query(`select delivery_id from webhook_events
    where delivery_id in ('breez:breez-1', 'breez:breez-3') order by delivery_id`);
  assert.deepEqual(rows.map((r) => r.delivery_id), ['breez:breez-3']);
});

test('an unpaid invoice past its expiry becomes expired and credits nothing', async () => {
  assert.equal(await ledger.expireUnpaid(db), 1);
  assert.equal(await statusOf('ef'.repeat(32)), 'expired');
  assert.equal(await statusOf('cd'.repeat(32)), 'new');
  assert.equal(await earned(), '12.61000000');
});

test('a payment that arrives after expiry still settles, because the sats are in the wallet', async () => {
  assert.equal(await ledger.settlePayment(db, receive('breez-7', 8339, 'ef'.repeat(32))), 'settled');
  assert.equal(await statusOf('ef'.repeat(32)), 'settled');
  assert.equal(await earned(), '19.40000000');
});

test('catch-up starts an hour before the oldest unsettled invoice', async () => {
  const { rows } = await db.query(`select extract(epoch from now() - interval '1 hour')::bigint as expected`);
  assert.equal(await ledger.catchUpSince(db), Number(rows[0].expected));
});

test('sends and non-lightning receives are ignored', async () => {
  assert.equal(await ledger.settlePayment(db, { ...receive('breez-5', 11913), paymentType: 'send' }), 'ignored');
  assert.equal(await ledger.settlePayment(db, { ...receive('breez-6', 11913), details: { type: 'deposit', txId: 'x', vout: 0 } }), 'no_hash');
});
