import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { TRON, EVM, BSC_USDT, LEAF_ERROR, fakeBreez } from './fake-breez.mjs';
import { createWithdrawals, splitFee, outcomeOf, fromBaseUnits, routeId, failedBeforeSend, networkFeeUsd, LEAF_RETRY_MS, SELF_WITHDRAW_OFF } from './withdraw.mjs';

// Runs against a database with every migration applied. Unlike
// ledger.test.mjs this commits, because confirm and crash recovery need
// several connections to see each other's rows. Each test uses fresh users,
// all removed in after().
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const users = [];
const RATE = 100_000; // USD per BTC, so $1 = 1000 sats

async function makeUser({ earned = 100, fee = 3, active = true, dailyLimit = null } = {}) {
  const id = randomUUID();
  users.push(id);
  await db.query(`insert into auth.users(id, email) values ($1, $2)`, [id, `w-${id}@test.invalid`]);
  await db.query(`update profiles set account_status = $2, withdrawal_fee_percent = $3 where id = $1`, [id, active ? 'active' : 'pending', fee]);
  await db.query(
    `insert into payments(user_id, amount_requested, amount_settled, status, settled_at, expires_at)
     values ($1, $2, $2, 'settled', now(), now() + interval '1 hour')`,
    [id, earned],
  );
  if (dailyLimit != null) await db.query(`insert into profile_limits(user_id, daily_withdrawal_limit) values ($1, $2)`, [id, dailyLimit]);
  return id;
}

async function balance(userId) {
  const { rows } = await db.query('select queued::text, withdrawn::text, available::text from get_balance_for($1)', [userId]);
  return rows[0];
}

async function rows(userId) {
  const r = await db.query('select * from withdrawals where user_id = $1 order by requested_at', [userId]);
  return r.rows;
}

function service(breez, opts = {}) {
  const log = [];
  const w = createWithdrawals({ breez, db, btcUsdRate: async () => RATE, log: (e) => log.push(e), confirmWaitMs: 200, ...opts });
  w.log = log;
  return w;
}

before(async () => { await db.query('select 1'); });
after(async () => {
  if (users.length) await db.query('delete from auth.users where id = any($1::uuid[])', [users]);
  await db.end();
});

test('splitFee matches the database rounding for every cent from $5.00 to $60.00 at five fee rates', async () => {
  const fees = ['0', '2.5', '3', '3.33', '7.25'];
  const { rows: dbRows } = await db.query(
    `select a::text as amount, f::text as fee, round(a*(1-f/100),2)::text as after
       from generate_series(500, 6000) c, lateral (select c/100.0 as a) x, unnest($1::numeric[]) f`,
    [fees],
  );
  let mismatches = 0;
  for (const r of dbRows) {
    const { sendCents } = splitFee(Math.round(Number(r.amount) * 100), r.fee);
    if ((sendCents / 100).toFixed(2) !== Number(r.after).toFixed(2)) mismatches++;
  }
  assert.equal(dbRows.length, 5501 * 5);
  assert.equal(mismatches, 0);
});

test('fromBaseUnits is exact', () => {
  assert.equal(fromBaseUnits('116400000', 6), '116.4');
  assert.equal(fromBaseUnits('5', 6), '0.000005');
  assert.equal(fromBaseUnits(0n, 6), '0');
});

test('the route catalog lists BTC-funded stablecoin routes from every family and is cached', async () => {
  const breez = fakeBreez();
  const w = service(breez);
  const routes = await w.listRoutes();
  assert.deepEqual(routes.map((r) => r.id).sort(), ['orchestra:arbitrum:usdc', 'orchestra:bsc:usdt', 'orchestra:solana:usdc', 'orchestra:tron:usdt']);
  assert.deepEqual(routes.find((r) => r.id === 'orchestra:tron:usdt'), {
    id: 'orchestra:tron:usdt', provider: 'orchestra', asset: 'USDT', chain: 'tron', chainId: null, family: 'tron',
    decimals: 6, contractAddress: null, minUsd: 1, maxUsd: 10000,
  });
  await w.listRoutes();
  assert.equal(breez.calls.routes, 3);
});

test('quote shows the platform fee, the network fee and what arrives', async () => {
  const user = await makeUser({ earned: 200 });
  const w = service(fakeBreez());
  const q = await w.quote({ userId: user, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '120' });
  assert.equal(q.amountUsd, '120.00');
  assert.equal(q.feePercent, '3.00');
  assert.equal(q.platformFeeUsd, '3.60');
  assert.equal(q.sendUsd, '116.40');
  assert.equal(q.amountSat, 116_400);
  assert.equal(q.receive, '115.88');
  assert.equal(q.networkFeeUsd, '0.52');
  assert.deepEqual(q.providerFee, { amount: '0.52', asset: 'USDT' });
  assert.equal(q.receiveMin, '114.7212');
  assert.ok(Date.parse(q.expiresAt) > Date.now());
});

test('quote with a 0% platform fee sends the whole amount', async () => {
  const user = await makeUser({ earned: 50, fee: 0 });
  const q = await service(fakeBreez()).quote({ userId: user, routeId: 'orchestra:bsc:usdt', address: EVM, amountUsd: '10.29' });
  assert.equal(q.platformFeeUsd, '0.00');
  assert.equal(q.sendUsd, '10.29');
});

test('quote rejects a wrong-network address, a short amount and an overdraft before asking Breez', async () => {
  const user = await makeUser({ earned: 20 });
  const breez = fakeBreez();
  const w = service(breez);
  await assert.rejects(w.quote({ userId: user, routeId: 'orchestra:tron:usdt', address: EVM, amountUsd: '10' }), /not a valid TRON address/);
  await assert.rejects(w.quote({ userId: user, routeId: 'orchestra:bsc:usdt', address: '0x1234', amountUsd: '10' }), /not a valid EVM address/);
  await assert.rejects(w.quote({ userId: user, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '4.99' }), /Minimum withdrawal is \$5/);
  await assert.rejects(w.quote({ userId: user, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '20.01' }), /Insufficient balance. Available: \$20.00/);
  await assert.rejects(w.quote({ userId: user, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '1.234' }), /dollars and cents/);
  assert.equal(breez.calls.prepare, 0);
});

test('confirm reserves, sends with the withdrawal id as idempotency key, and delivery marks it paid', async () => {
  const user = await makeUser({ earned: 200 });
  const breez = fakeBreez();
  const w = service(breez);
  const q = await w.quote({ userId: user, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '120' });
  const r = await w.confirm({ userId: user, quoteId: q.quoteId });
  assert.equal(r.status, 'sending');
  assert.ok(breez.payments.has(r.withdrawalId));
  assert.deepEqual(await balance(user), { queued: '120.00000000', withdrawn: '0', available: '80.00000000' });
  const [row] = await rows(user);
  assert.equal(row.method, 'stablecoin');
  assert.equal(row.coin, 'USDT');
  assert.equal(row.chain, 'tron');
  assert.equal(row.destination, TRON);
  assert.equal(row.amount_sat, '116400');
  assert.equal(row.amount_after_fee, '116.40000000');

  breez.deliver(r.withdrawalId, 'completed', 115_901_234n);
  assert.equal(await w.onPayment({ id: r.withdrawalId, paymentType: 'send' }), 'paid');
  const [paid] = await rows(user);
  assert.equal(paid.status, 'paid');
  assert.equal(paid.payout_ref, r.withdrawalId);
  assert.equal(paid.amount_out, '115.90123400');
  assert.deepEqual(await balance(user), { queued: '120.00000000', withdrawn: '116.40000000', available: '80.00000000' });
});

test('confirming the same quote twice, one after the other, sends once', async () => {
  const user = await makeUser({ earned: 100 });
  const breez = fakeBreez();
  const w = service(breez);
  const q = await w.quote({ userId: user, routeId: 'orchestra:bsc:usdt', address: EVM, amountUsd: '30' });
  const a = await w.confirm({ userId: user, quoteId: q.quoteId });
  const b = await w.confirm({ userId: user, quoteId: q.quoteId });
  assert.equal(a.withdrawalId, b.withdrawalId);
  assert.equal(breez.calls.send, 1);
  assert.equal((await rows(user)).length, 1);
  assert.equal((await balance(user)).available, '70.00000000');
});

test('confirming the same quote twice at once sends once', async () => {
  const user = await makeUser({ earned: 100 });
  const breez = fakeBreez();
  const w = service(breez);
  const q = await w.quote({ userId: user, routeId: 'orchestra:bsc:usdt', address: EVM, amountUsd: '30' });
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => w.confirm({ userId: user, quoteId: q.quoteId })));
  assert.equal(new Set([a.withdrawalId, b.withdrawalId, c.withdrawalId]).size, 1);
  assert.equal(breez.calls.send, 1);
  assert.equal((await rows(user)).length, 1);
});

test('two database sessions reserving the same quote get one row', async () => {
  const user = await makeUser({ earned: 100 });
  const quoteId = randomUUID();
  const args = [user, quoteId, '40.00', '3.00', '38.80', 'USDT', 'tron', TRON, '0.5', '38.3', 38_800, new Date(Date.now() + 60_000).toISOString()];
  const sql = 'select id from reserve_stablecoin_withdrawal($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)';
  const results = await Promise.all([db.query(sql, args), db.query(sql, args), db.query(sql, args)]);
  assert.equal(new Set(results.map((r) => r.rows[0].id)).size, 1);
  assert.equal((await rows(user)).length, 1);
  assert.equal((await balance(user)).available, '60.00000000');
});

test('a send that fails before any transfer refunds the reservation exactly once', async () => {
  const user = await makeUser({ earned: 100 });
  const breez = fakeBreez({ mode: 'insufficient' });
  const w = service(breez);
  const q = await w.quote({ userId: user, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '50' });
  const r = await w.confirm({ userId: user, quoteId: q.quoteId });
  assert.equal(r.status, 'failed');
  assert.match(r.note, /Insufficient funds/);
  assert.equal((await balance(user)).available, '100.00000000');
  const again = await db.query(`select finalize_stablecoin_withdrawal($1, 'failed') as r`, [r.withdrawalId]);
  assert.equal(again.rows[0].r, 'already_failed');
  const late = await db.query(`select finalize_stablecoin_withdrawal($1, 'paid', 'x') as r`, [r.withdrawalId]);
  assert.equal(late.rows[0].r, 'already_failed');
  assert.equal((await balance(user)).available, '100.00000000');
});

test('a Spark leg that fails, or a swap that is refunded, returns the balance', async () => {
  const user = await makeUser({ earned: 100 });
  const w1 = service(fakeBreez({ mode: 'spark-failed' }));
  const q1 = await w1.quote({ userId: user, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '10' });
  assert.equal((await w1.confirm({ userId: user, quoteId: q1.quoteId })).status, 'failed');

  const breez = fakeBreez();
  const w2 = service(breez);
  const q2 = await w2.quote({ userId: user, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '10' });
  const r2 = await w2.confirm({ userId: user, quoteId: q2.quoteId });
  breez.deliver(r2.withdrawalId, 'refunded');
  assert.equal(await w2.onPayment({ id: r2.withdrawalId, paymentType: 'send' }), 'failed');
  assert.equal((await balance(user)).available, '100.00000000');
});

test('a swap that fails without a refund stays sending for a human', async () => {
  const user = await makeUser({ earned: 100 });
  const breez = fakeBreez();
  const w = service(breez);
  const q = await w.quote({ userId: user, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '10' });
  const r = await w.confirm({ userId: user, quoteId: q.quoteId });
  breez.deliver(r.withdrawalId, 'failed');
  assert.equal(await w.onPayment({ id: r.withdrawalId, paymentType: 'send' }), 'sending');
  assert.ok(w.log.some((e) => e.event === 'withdrawal-stuck'));
  assert.equal((await rows(user))[0].status, 'sending');
  assert.equal((await balance(user)).available, '90.00000000');
});

test('crash mid-send: a restarted service finds the payment by idempotency key and never sends again', async () => {
  const user = await makeUser({ earned: 100 });
  const breez = fakeBreez({ mode: 'hang' });
  const before = service(breez, { confirmWaitMs: 50 });
  const q = await before.quote({ userId: user, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '25' });
  const r = await before.confirm({ userId: user, quoteId: q.quoteId });
  assert.equal(r.status, 'sending');
  // The process dies here. Its transfer reached Spark anyway, so the
  // restarted SDK's storage has it after sync.
  breez.releaseHang();
  await new Promise((resolve) => setImmediate(resolve));
  const sendsBefore = breez.calls.send;

  const restarted = service(breez);
  breez.deliver(r.withdrawalId, 'completed', 24_000_000n);
  await restarted.reconcile({ synced: true });
  assert.equal(breez.calls.send, sendsBefore);
  const [row] = await rows(user);
  assert.equal(row.status, 'paid');
  assert.equal(row.amount_out, '24.00000000');
  await restarted.reconcile({ synced: true });
  assert.equal((await rows(user)).length, 1);
  assert.equal((await balance(user)).withdrawn, '24.25000000');
});

test('crash before any transfer: the orphan is refunded once, only after its quote has long expired', async () => {
  const user = await makeUser({ earned: 100 });
  const breez = fakeBreez({ mode: 'network-no-transfer' });
  const w = service(breez);
  const q = await w.quote({ userId: user, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '25' });
  const r = await w.confirm({ userId: user, quoteId: q.quoteId });
  assert.equal(r.status, 'sending');
  assert.equal((await balance(user)).available, '75.00000000');

  const soon = service(breez);
  await soon.reconcile({ synced: true });
  assert.equal((await rows(user))[0].status, 'sending');

  const later = service(breez, { now: () => Date.now() + 12 * 60_000 });
  await later.reconcile({ synced: false });
  assert.equal((await rows(user))[0].status, 'sending', 'never refunds without a fresh sync');
  await later.reconcile({ synced: true });
  const [row] = await rows(user);
  assert.equal(row.status, 'failed');
  assert.match(row.admin_note, /No payment found/);
  assert.equal((await balance(user)).available, '100.00000000');
  await later.reconcile({ synced: true });
  assert.equal((await balance(user)).available, '100.00000000');
  assert.equal(breez.calls.send, 1);
});

test('an ambiguous error with a transfer on record is settled from that payment', async () => {
  const user = await makeUser({ earned: 100 });
  const breez = fakeBreez({ mode: 'network-after-transfer' });
  const w = service(breez);
  const q = await w.quote({ userId: user, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '25' });
  const r = await w.confirm({ userId: user, quoteId: q.quoteId });
  assert.equal(r.status, 'sending');
  breez.deliver(r.withdrawalId, 'completed', 24_100_000n);
  await w.reconcile({ synced: true });
  assert.equal((await rows(user))[0].status, 'paid');
});

test('an expired quote is re-quoted at confirm instead of sent', async () => {
  const user = await makeUser({ earned: 100 });
  const breez = fakeBreez();
  let clock = Date.now();
  const w = service(breez, { now: () => clock });
  const q = await w.quote({ userId: user, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '25' });
  clock += 61_000;
  await assert.rejects(w.confirm({ userId: user, quoteId: q.quoteId }), (e) => {
    assert.equal(e.status, 409);
    assert.equal(e.extra.quote.amountUsd, '25.00');
    assert.notEqual(e.extra.quote.quoteId, q.quoteId);
    return true;
  });
  assert.equal(breez.calls.send, 0);
  assert.equal((await rows(user)).length, 0);
});

test('a fee change between quote and confirm is refused, so the user never pays a fee they did not see', async () => {
  const user = await makeUser({ earned: 100, fee: 3 });
  const breez = fakeBreez();
  const w = service(breez);
  const q = await w.quote({ userId: user, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '25' });
  await db.query('update profiles set withdrawal_fee_percent = 0 where id = $1', [user]);
  await assert.rejects(w.confirm({ userId: user, quoteId: q.quoteId }), /Withdrawal fee changed/);
  assert.equal(breez.calls.send, 0);
});

test('another user cannot confirm my quote', async () => {
  const user = await makeUser({ earned: 100 });
  const other = await makeUser({ earned: 100 });
  const w = service(fakeBreez());
  const q = await w.quote({ userId: user, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '25' });
  await assert.rejects(w.confirm({ userId: other, quoteId: q.quoteId }), /Quote not found/);
});

test('sending counts toward the daily limit and failed does not', async () => {
  const user = await makeUser({ earned: 100, dailyLimit: 40 });
  const breez = fakeBreez({ mode: 'network-no-transfer' });
  const w = service(breez);
  const q1 = await w.quote({ userId: user, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '30' });
  await w.confirm({ userId: user, quoteId: q1.quoteId });
  const q2 = await w.quote({ userId: user, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '20' });
  await assert.rejects(w.confirm({ userId: user, quoteId: q2.quoteId }), /daily withdrawal limit of \$40/);
});

test('reserve refuses an inactive account and a disabled withdrawal feature', async () => {
  const pending = await makeUser({ earned: 100, active: false });
  const off = await makeUser({ earned: 100 });
  await db.query(`insert into profile_feature_flags(user_id, feature_key, enabled) values ($1, 'can_request_withdrawals', false)`, [off]);
  const sql = 'select id from reserve_stablecoin_withdrawal($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)';
  const args = (u) => [u, randomUUID(), '10.00', '3.00', '9.70', 'USDT', 'tron', TRON, '0.5', '9.2', 9_700, new Date(Date.now() + 60_000).toISOString()];
  await assert.rejects(db.query(sql, args(pending)), /Account approval is required/);
  await assert.rejects(db.query(sql, args(off)), /Withdrawal requests are disabled/);
});

test('the browser roles cannot call reserve or finalize', async () => {
  const { rows: r } = await db.query(`
    select p.proname, has_function_privilege('authenticated', p.oid, 'execute') as auth, has_function_privilege('anon', p.oid, 'execute') as anon,
           has_function_privilege('service_role', p.oid, 'execute') as service
      from pg_proc p where p.proname in ('reserve_stablecoin_withdrawal', 'finalize_stablecoin_withdrawal') order by 1`);
  assert.deepEqual(r, [
    { proname: 'finalize_stablecoin_withdrawal', auth: false, anon: false, service: true },
    { proname: 'reserve_stablecoin_withdrawal', auth: false, anon: false, service: true },
  ]);
});

test('USDT no longer goes to the admin queue: manual requests refuse it and auto-withdraw skips it', async () => {
  const user = await makeUser({ earned: 100 });
  await db.query(`update profiles set auto_withdraw_enabled = true, default_withdrawal_method = 'usdt_bep20', wallet_usdt_bep20 = $2 where id = $1`, [user, EVM]);
  const { rows: q } = await db.query('select system_queue_withdrawal($1) as id', [user]);
  assert.equal(q[0].id, null);
  await db.query(`update profiles set default_withdrawal_method = null where id = $1`, [user]);
  assert.equal((await db.query('select system_queue_withdrawal($1) as id', [user])).rows[0].id, null);

  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query(`create or replace function auth.uid() returns uuid language sql stable as $$ select '${user}'::uuid $$`);
    await assert.rejects(client.query(`select request_withdrawal(10, 'usdt_bep20', $1)`, [EVM]), /USDT withdrawals are sent instantly/);
    await client.query('rollback');
    await client.query('begin');
    await client.query(`update profiles set role = 'moderator' where id = $1`, [user]);
    await client.query(`create or replace function auth.uid() returns uuid language sql stable as $$ select '${user}'::uuid $$`);
    await assert.rejects(client.query(`select reseller_request_withdrawal_for($1, 10, 'usdt_bep20', $2)`, [user, EVM]), /USDT withdrawals are sent instantly/);
  } finally {
    await client.query('rollback');
    client.release();
  }
  await db.query(`update profiles set default_withdrawal_method = 'bkash', wallet_bkash = '01711000000' where id = $1`, [user]);
  assert.ok((await db.query('select system_queue_withdrawal($1) as id', [user])).rows[0].id, 'bKash still auto-queues');
});

// Time for the leaf-error retry: sleep() moves the clock instead of waiting.
function fakeClock() {
  const c = { t: Date.now(), slept: [] };
  c.now = () => c.t;
  c.sleep = async (ms) => { c.slept.push(ms); c.t += ms; };
  return c;
}

test('BSC USDT has 18 decimals: quote, stored estimate and delivered amount are read at 18', async () => {
  assert.equal(fromBaseUnits('5380000000000000000', 18), '5.38');
  assert.equal(fromBaseUnits('1', 18), '0.000000000000000001');
  const user = await makeUser({ earned: 50, fee: 0 });
  const breez = fakeBreez();
  const w = service(breez);
  const route = (await w.listRoutes()).find((r) => r.id === 'orchestra:bsc:usdt');
  assert.equal(route.decimals, 18);
  assert.equal(route.contractAddress, BSC_USDT);
  // $5.90 = 5900 sats; the fake answers estimatedOut '5380000000000000000',
  // the shape of a mainnet quote for 5.38 USDT.
  const q = await w.quote({ userId: user, routeId: 'orchestra:bsc:usdt', address: EVM, amountUsd: '5.90' });
  assert.equal(q.receive, '5.38');
  assert.equal(q.receiveMin, '5.3262');
  assert.deepEqual(q.providerFee, { amount: '0.52', asset: 'USDT' });
  assert.equal(q.networkFeeUsd, '0.52');
  const r = await w.confirm({ userId: user, quoteId: q.quoteId });
  assert.equal((await rows(user))[0].amount_out, '5.38000000');
  breez.deliver(r.withdrawalId, 'completed', 5_379_123_456_789_012_345n, 18);
  assert.equal(await w.onPayment({ id: r.withdrawalId, paymentType: 'send' }), 'paid');
  assert.equal((await rows(user))[0].amount_out, '5.37912346');
});

test('leaf error: the send is retried after a sync with the same key, and the ledger is debited once', async () => {
  const user = await makeUser({ earned: 100 });
  const breez = fakeBreez({ leafFailures: 1 });
  const clock = fakeClock();
  const w = service(breez, { now: clock.now, sleep: clock.sleep, confirmWaitMs: 10_000 });
  const q = await w.quote({ userId: user, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '25' });
  const r = await w.confirm({ userId: user, quoteId: q.quoteId });
  assert.equal(r.status, 'sending');
  assert.equal(breez.calls.send, 2);
  assert.equal(breez.calls.sync, 1);
  assert.deepEqual(clock.slept, [5_000]);
  assert.deepEqual([...breez.payments.keys()], [r.withdrawalId]);
  assert.equal((await rows(user)).length, 1);
  assert.equal((await balance(user)).available, '75.00000000');
  breez.deliver(r.withdrawalId, 'completed', 24_000_000n);
  assert.equal(await w.onPayment({ id: r.withdrawalId, paymentType: 'send' }), 'paid');
  assert.deepEqual(await balance(user), { queued: '25.00000000', withdrawn: '24.25000000', available: '75.00000000' });
});

test('leaf error past the retry bound: the withdrawal fails and the balance comes back once', async () => {
  const user = await makeUser({ earned: 100 });
  const breez = fakeBreez({ leafFailures: Infinity, quoteTtlMs: 15 * 60_000 });
  const clock = fakeClock();
  const w = service(breez, { now: clock.now, sleep: clock.sleep, confirmWaitMs: 10_000 });
  const q = await w.quote({ userId: user, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '25' });
  const r = await w.confirm({ userId: user, quoteId: q.quoteId });
  assert.equal(r.status, 'failed');
  assert.match(r.note, /Failed to select leaves/);
  assert.deepEqual(clock.slept, [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000]);
  assert.ok(clock.slept.reduce((a, b) => a + b) < LEAF_RETRY_MS);
  assert.equal(breez.calls.send, 9);
  assert.equal(breez.calls.sync, 8);
  assert.equal(breez.payments.size, 0);
  assert.equal((await balance(user)).available, '100.00000000');
  await service(breez, { now: () => Date.now() + 30 * 60_000 }).reconcile({ synced: true });
  assert.equal((await balance(user)).available, '100.00000000');
  assert.equal((await rows(user)).length, 1);
});

test('leaf error retries stop at the quote expiry, and the withdrawal fails cleanly', async () => {
  const user = await makeUser({ earned: 100 });
  const breez = fakeBreez({ leafFailures: Infinity }); // 60 s quote
  const clock = fakeClock();
  const w = service(breez, { now: clock.now, sleep: clock.sleep, confirmWaitMs: 10_000 });
  const q = await w.quote({ userId: user, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '25' });
  const r = await w.confirm({ userId: user, quoteId: q.quoteId });
  assert.equal(r.status, 'failed');
  assert.deepEqual(clock.slept, [5_000, 10_000, 20_000]);
  assert.equal(breez.calls.send, 4);
  assert.equal((await balance(user)).available, '100.00000000');
});

test('leaf error but the attempt made a payment: it is found after the sync and nothing is sent again', async () => {
  const user = await makeUser({ earned: 100 });
  const breez = fakeBreez({ mode: 'leaf-after-transfer' });
  const clock = fakeClock();
  const w = service(breez, { now: clock.now, sleep: clock.sleep, confirmWaitMs: 10_000 });
  const q = await w.quote({ userId: user, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '25' });
  const r = await w.confirm({ userId: user, quoteId: q.quoteId });
  assert.equal(r.status, 'sending');
  assert.equal(breez.calls.send, 1);
  assert.equal(breez.calls.sync, 1);
  assert.equal(breez.payments.size, 1);
  breez.deliver(r.withdrawalId, 'completed', 24_000_000n);
  assert.equal(await w.onPayment({ id: r.withdrawalId, paymentType: 'send' }), 'paid');
  assert.deepEqual(await balance(user), { queued: '25.00000000', withdrawn: '24.25000000', available: '75.00000000' });
});

test('outcomeOf maps Breez payment states', () => {
  assert.equal(outcomeOf({ status: 'pending' }).status, 'sending');
  assert.equal(outcomeOf({ status: 'failed' }).status, 'failed');
  assert.equal(outcomeOf({ status: 'completed' }).status, 'sending');
  assert.equal(outcomeOf({ status: 'completed', conversionDetails: { status: 'refundNeeded' } }).status, 'sending');
  assert.equal(outcomeOf({ status: 'completed', conversionDetails: { status: 'refunded' } }).status, 'failed');
  assert.equal(outcomeOf({ status: 'completed', conversionDetails: { status: 'failed' } }).status, 'stuck');
  assert.equal(outcomeOf({ status: 'completed', conversionDetails: { status: 'completed' } }).status, 'paid');
  assert.equal(routeId({ provider: 'orchestra', chain: 'tron', asset: 'USDT' }), 'orchestra:tron:usdt');
  assert.equal(failedBeforeSend(new Error(LEAF_ERROR)), true);
  assert.equal(failedBeforeSend(new Error('Network error: connection reset')), false);
});

test('networkFeeUsd is sendUsd minus what arrives, exact at the coin decimals', () => {
  assert.equal(networkFeeUsd(11_640, '115880000', 6), '0.52');
  assert.equal(networkFeeUsd(590, '5380000000000000000', 18), '0.52');
  assert.equal(networkFeeUsd(1_000, '9876543', 6), '0.123457');
  // A quote that delivers more than it was sent never shows a negative fee.
  assert.equal(networkFeeUsd(1_000, '10000001', 6), '0');
});

test('a new account gets a 0% withdrawal fee, and its quote has no platform fee', async () => {
  const id = randomUUID();
  users.push(id);
  await db.query(`insert into auth.users(id, email) values ($1, $2)`, [id, `new-${id}@test.invalid`]);
  // No fee of its own (NULL = inherit, 0101); it resolves to the 0% global default.
  const { rows: [p] } = await db.query('select withdrawal_fee_percent::text as fee, resolve_withdrawal_fee(id)::text as resolved from profiles where id = $1', [id]);
  assert.equal(p.fee, null);
  assert.equal(Number(p.resolved), 0);
  await db.query(`update profiles set account_status = 'active' where id = $1`, [id]);
  await db.query(
    `insert into payments(user_id, amount_requested, amount_settled, status, settled_at, expires_at)
     values ($1, 50, 50, 'settled', now(), now() + interval '1 hour')`, [id],
  );
  const q = await service(fakeBreez()).quote({ userId: id, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '20' });
  assert.equal(Number(q.feePercent), 0);
  assert.equal(q.platformFeeUsd, '0.00');
  assert.equal(q.sendUsd, '20.00');
  assert.equal(q.networkFeeUsd, '0.52');
  assert.equal(q.receive, '19.48');
  const { rows: [s] } = await db.query(`select value->>'percent' as pct from app_settings where key = 'default_withdrawal_fee_percent'`);
  assert.equal(Number(s.pct), 0);
});

test('a quote the SDK refuses reaches the user as a generic message, with the detail only in the log', async () => {
  const user = await makeUser({ earned: 50, fee: 0 });
  const breez = fakeBreez();
  breez.prepareSendPayment = async () => { throw new Error('Breez SDK: Orchestra quote failed: upstream 500'); };
  const w = service(breez);
  await assert.rejects(
    w.quote({ userId: user, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '20' }),
    (e) => e.status === 422 && !/breez|sdk|orchestra/i.test(e.message) && /could not be quoted/.test(e.message),
  );
  assert.ok(w.log.some((l) => l.error === 'prepare failed' && /Orchestra quote failed/.test(l.detail)));
});

// ---------------------------------------------------------------------------
// 0101: per-reseller self-withdraw switch and the withdrawal fee hierarchy.
// ---------------------------------------------------------------------------

async function makeReseller() {
  const id = await makeUser({ earned: 10, fee: null });
  await db.query(`update profiles set role = 'moderator' where id = $1`, [id]);
  return id;
}
async function makeAdmin() {
  const id = await makeUser({ earned: 10, fee: null });
  await db.query(`update profiles set role = 'admin' where id = $1`, [id]);
  return id;
}
async function makeFreelancer(reseller, { earned = 100, fee = null } = {}) {
  const id = await makeUser({ earned, fee });
  if (reseller) await db.query('update profiles set referred_by = $2 where id = $1', [id, reseller]);
  return id;
}

// Runs fn as uid inside a transaction that is always rolled back.
// browser: also switch to the `authenticated` role, so table grants and RLS
// apply the way they do for a signed-in browser.
async function asUser(uid, fn, { browser = false } = {}) {
  const c = await db.connect();
  try {
    await c.query('begin');
    await c.query(`create or replace function auth.uid() returns uuid language sql stable as $$ select '${uid}'::uuid $$`);
    if (browser) {
      await c.query('grant usage on schema auth to authenticated');
      await c.query('set local role authenticated');
    }
    return await fn(c);
  } finally {
    await c.query('rollback').catch(() => {});
    c.release();
  }
}
// Error text from a query that must fail, run in its own savepoint so the
// surrounding transaction stays usable.
async function refusal(c, sql, args = []) {
  await c.query('savepoint r');
  try {
    await c.query(sql, args);
  } catch (e) {
    await c.query('rollback to savepoint r');
    return e.message;
  }
  await c.query('release savepoint r');
  return null;
}
async function fee(userId) {
  const { rows: [r] } = await db.query('select fee_percent::text as pct, source from withdrawal_fee_resolution($1)', [userId]);
  return { pct: Number(r.pct), source: r.source };
}
const ledgerOf = async (u) => ({ balance: await balance(u), rows: (await rows(u)).length });

test('self-withdraw is off by default: the column defaults to false and a reseller with no row counts as off', async () => {
  const { rows: [col] } = await db.query(`
    select column_default, is_nullable from information_schema.columns
     where table_schema = 'public' and table_name = 'reseller_settings' and column_name = 'allow_freelancer_self_withdraw'`);
  assert.equal(col.column_default, 'false');
  assert.equal(col.is_nullable, 'NO');
  const reseller = await makeReseller();
  const freelancer = await makeFreelancer(reseller);
  assert.equal((await db.query('select count(*)::int as n from reseller_settings where reseller_id = $1', [reseller])).rows[0].n, 0);
  assert.equal((await db.query('select self_withdraw_allowed($1) as ok', [freelancer])).rows[0].ok, false);
  await db.query('insert into reseller_settings(reseller_id) values ($1)', [reseller]);
  assert.equal((await db.query('select allow_freelancer_self_withdraw as v from reseller_settings where reseller_id = $1', [reseller])).rows[0].v, false);
  assert.equal((await db.query('select self_withdraw_allowed($1) as ok', [freelancer])).rows[0].ok, false);
  // The freelancer's own view of it.
  const view = await asUser(freelancer, async (c) => (await c.query('select my_withdraw_settings() as s')).rows[0].s, { browser: true });
  assert.equal(view.self_withdraw_allowed, false);
  assert.equal(view.has_reseller, true);
  assert.equal(view.reseller, null);
});

test('freelancers with no reseller, resellers and admins can always withdraw from their own account', async () => {
  const solo = await makeFreelancer(null);
  const reseller = await makeReseller();
  const admin = await makeAdmin();
  const { rows } = await db.query('select self_withdraw_allowed($1) as a, self_withdraw_allowed($2) as b, self_withdraw_allowed($3) as c', [solo, reseller, admin]);
  assert.deepEqual(rows[0], { a: true, b: true, c: true });
  const view = await asUser(solo, async (c) => (await c.query('select my_withdraw_settings() as s')).rows[0].s, { browser: true });
  assert.equal(view.self_withdraw_allowed, true);
  assert.equal(view.has_reseller, false);
  const q = await service(fakeBreez()).quote({ userId: solo, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '10' });
  assert.ok(q.quoteId);
});

test('switch off: every self-service path refuses with a clean message and the ledger does not move', async () => {
  const reseller = await makeReseller();
  const freelancer = await makeFreelancer(reseller, { earned: 100 });
  await db.query(`update profiles set auto_withdraw_enabled = true, default_withdrawal_method = 'bkash', wallet_bkash = '01711000000' where id = $1`, [freelancer]);
  const before = await ledgerOf(freelancer);
  const clean = (m) => m === SELF_WITHDRAW_OFF && !/breez|spark|sdk|orchestra/i.test(m);

  // Payment service quote: refused before the SDK is asked anything.
  const breez = fakeBreez();
  await assert.rejects(
    service(breez).quote({ userId: freelancer, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '20' }),
    (e) => e.status === 403 && clean(e.message),
  );
  assert.equal(breez.calls.prepare, 0);

  // Reserve (what confirm calls), as the service role would.
  const sql = 'select id from reserve_stablecoin_withdrawal($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)';
  await assert.rejects(
    db.query(sql, [freelancer, randomUUID(), '10.00', '0', '10.00', 'USDT', 'tron', TRON, '0.5', '9.5', 10_000, new Date(Date.now() + 60_000).toISOString()]),
    (e) => clean(e.message),
  );

  // Auto-withdraw queues nothing.
  assert.equal((await db.query('select system_queue_withdrawal($1) as id', [freelancer])).rows[0].id, null);

  await asUser(freelancer, async (c) => {
    // The manual request RPC the dashboard and user-withdraw call.
    assert.ok(clean(await refusal(c, `select request_withdrawal(10, 'bkash', '01711000000')`)));
    // A direct insert from the browser: no INSERT grant/policy for the client.
    await c.query('set local role authenticated');
    assert.match(await refusal(c, `insert into withdrawals(user_id, amount_requested, fee_percent, amount_after_fee, method, destination, status)
                                   values ($1, 10, 0, 10, 'bkash', '01711000000', 'pending')`, [freelancer]),
      /permission denied|row-level security/);
  });
  // Even a signed-in insert that got past the grants hits the table trigger.
  await asUser(freelancer, async (c) => {
    assert.ok(clean(await refusal(c, `insert into withdrawals(user_id, amount_requested, fee_percent, amount_after_fee, method, destination, status)
                                      values ($1, 10, 0, 10, 'bkash', '01711000000', 'pending')`, [freelancer])));
  });

  assert.deepEqual(await ledgerOf(freelancer), before);
});

test('switch on: the freelancer quotes, confirms and requests by themselves', async () => {
  const reseller = await makeReseller();
  const freelancer = await makeFreelancer(reseller, { earned: 100 });
  // Turned on through the reseller's own RPC (rolled back), then committed
  // directly for the service calls below, which use other connections.
  await asUser(reseller, async (c) => {
    assert.equal((await c.query('select reseller_set_self_withdraw(true) as v')).rows[0].v, true);
    assert.equal((await c.query('select self_withdraw_allowed($1) as ok', [freelancer])).rows[0].ok, true);
  });
  await db.query('insert into reseller_settings(reseller_id, allow_freelancer_self_withdraw) values ($1, true)', [reseller]);

  const breez = fakeBreez();
  const w = service(breez);
  const q = await w.quote({ userId: freelancer, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '20' });
  const out = await w.confirm({ userId: freelancer, quoteId: q.quoteId });
  assert.equal(out.status, 'sending');
  assert.equal(breez.calls.send, 1);
  await asUser(freelancer, async (c) => {
    const { rows: [r] } = await c.query(`select status, method from request_withdrawal(10, 'bkash', '01711000000')`);
    assert.deepEqual(r, { status: 'pending', method: 'bkash' });
  });
  assert.equal(Number((await balance(freelancer)).queued), 20);

  // Flipped off between quote and confirm: refused at reserve, nothing sent.
  const q2 = await w.quote({ userId: freelancer, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '10' });
  await db.query('update reseller_settings set allow_freelancer_self_withdraw = false where reseller_id = $1', [reseller]);
  await assert.rejects(w.confirm({ userId: freelancer, quoteId: q2.quoteId }), (e) => e.status === 403 && e.message === SELF_WITHDRAW_OFF);
  assert.equal(breez.calls.send, 1);
  assert.equal(Number((await balance(freelancer)).queued), 20);
});

test('the reseller still withdraws for a team member while self-withdraw is off, and so does an admin', async () => {
  const reseller = await makeReseller();
  const admin = await makeAdmin();
  const freelancer = await makeFreelancer(reseller, { earned: 100 });
  assert.equal((await db.query('select self_withdraw_allowed($1) as ok', [freelancer])).rows[0].ok, false);
  await db.query(`update profiles set wallet_bkash = '01711000000' where id = $1`, [freelancer]);
  await asUser(reseller, async (c) => {
    const { rows: [r] } = await c.query(`select user_id, status, admin_note, fee_percent::text, destination from reseller_request_withdrawal_for($1, 25, 'bkash', 'typed-not-used')`, [freelancer]);
    assert.equal(r.user_id, freelancer);
    assert.equal(r.status, 'pending');
    assert.equal(r.admin_note, 'Submitted by reseller');
    assert.equal(r.destination, '01711000000');
    const b = (await c.query('select available::text from get_balance_for($1)', [freelancer])).rows[0];
    assert.equal(Number(b.available), 75);
  });
    await asUser(admin, async (c) => {
    const { rows: [r] } = await c.query(`select user_id, status, destination from reseller_request_withdrawal_for($1, 10, 'bank', 'Acct 123')`, [freelancer]);
    assert.deepEqual(r, { user_id: freelancer, status: 'pending', destination: 'Acct 123' });
  });
  // Another reseller cannot.
  const other = await makeReseller();
  await asUser(other, async (c) => {
    assert.match(await refusal(c, `select reseller_request_withdrawal_for($1, 10, 'bkash', '01711000000')`, [freelancer]), /not on your team/);
  });
});

test('who can change the switch: the reseller for their own team and an admin for any reseller, nobody else', async () => {
  const reseller = await makeReseller();
  const otherReseller = await makeReseller();
  const admin = await makeAdmin();
  const freelancer = await makeFreelancer(reseller);
  await db.query('insert into reseller_settings(reseller_id) values ($1), ($2)', [reseller, otherReseller]);
  const flag = async (c, id) => (await c.query('select allow_freelancer_self_withdraw as v from reseller_settings where reseller_id = $1', [id])).rows[0]?.v;

  // Admin, through the same RPC the admin desk uses; audited.
  await asUser(admin, async (c) => {
    assert.equal((await c.query('select admin_set_reseller_self_withdraw($1, true) as v', [reseller])).rows[0].v, true);
    assert.equal(await flag(c, reseller), true);
    const { rows: [a] } = await c.query(`select actor_id, new_value from audit_log where action = 'reseller.self_withdraw_changed' and subject_id = $1 order by id desc limit 1`, [reseller]);
    assert.equal(a.actor_id, admin);
    assert.deepEqual(a.new_value, { allow_freelancer_self_withdraw: true });
    assert.match(await refusal(c, 'select admin_set_reseller_self_withdraw($1, true)', [freelancer]), /Reseller not found/);
  });
  // The reseller, for their own team only.
  await asUser(reseller, async (c) => {
    await c.query('select reseller_set_self_withdraw(true)');
    assert.equal(await flag(c, reseller), true);
    assert.match(await refusal(c, 'select admin_set_reseller_self_withdraw($1, true)', [otherReseller]), /Not authorized/);
    assert.equal(await flag(c, otherReseller), false);
  });
  // The freelancer: neither RPC, and no direct write.
  await asUser(freelancer, async (c) => {
    assert.match(await refusal(c, 'select reseller_set_self_withdraw(true)'), /Not authorized/);
    assert.match(await refusal(c, 'select admin_set_reseller_self_withdraw($1, true)', [reseller]), /Not authorized/);
  });
  for (const who of [freelancer, otherReseller]) {
    await asUser(who, async (c) => {
      // As migrated: the browser role has no write grant on the table.
      assert.match(await refusal(c, 'update reseller_settings set allow_freelancer_self_withdraw = true where reseller_id = $1', [reseller]), /permission denied/);
      assert.match(await refusal(c, 'insert into reseller_settings(reseller_id, allow_freelancer_self_withdraw) values ($1, true)', [who]), /permission denied/);
      // And if a grant ever came back, RLS still allows no write at all.
      await c.query('reset role');
      await c.query('grant insert, update on reseller_settings to authenticated');
      await c.query('set local role authenticated');
      const upd = await c.query('update reseller_settings set allow_freelancer_self_withdraw = true where reseller_id = $1', [reseller]);
      assert.equal(upd.rowCount, 0);
      assert.match(await refusal(c, 'insert into reseller_settings(reseller_id, allow_freelancer_self_withdraw) values ($1, true)', [who]), /row-level security/);
      // Reading: a reseller sees only their own row; a freelancer sees none.
      const seen = (await c.query('select reseller_id from reseller_settings')).rows.map((r) => r.reseller_id);
      assert.deepEqual(seen, who === otherReseller ? [otherReseller] : []);
    }, { browser: true });
  }
  assert.equal((await db.query('select allow_freelancer_self_withdraw as v from reseller_settings where reseller_id = $1', [reseller])).rows[0].v, false);
});

test('fee hierarchy: global default, then the reseller team fee, then the account override', async () => {
  const admin = await makeAdmin();
  const reseller = await makeReseller();
  const freelancer = await makeFreelancer(reseller, { earned: 100 });
  const solo = await makeFreelancer(null, { earned: 100 });
  await db.query('insert into reseller_settings(reseller_id, allow_freelancer_self_withdraw) values ($1, true)', [reseller]);
  const w = service(fakeBreez());
  const quoteFee = async (u) => {
    const q = await w.quote({ userId: u, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '20' });
    return { pct: Number(q.feePercent), platform: q.platformFeeUsd, send: q.sendUsd };
  };

  // Level 3, the global default (0% since 0100): no platform fee at all.
  assert.deepEqual(await fee(freelancer), { pct: 0, source: 'global' });
  assert.deepEqual(await quoteFee(freelancer), { pct: 0, platform: '0.00', send: '20.00' });

  // A non-zero global default, set by an admin. Committed briefly for the
  // quote; restored in finally.
  const { rows: [g] } = await db.query(`select value from app_settings where key = 'default_withdrawal_fee_percent'`);
  try {
    await asUser(admin, async (c) => {
      await c.query('select admin_set_default_withdrawal_fee(2)');
      assert.equal(Number((await c.query('select resolve_withdrawal_fee($1) as f', [freelancer])).rows[0].f), 2);
    });
    await db.query(`update app_settings set value = '{"percent": 2}' where key = 'default_withdrawal_fee_percent'`);
    assert.deepEqual(await fee(freelancer), { pct: 2, source: 'global' });
    assert.deepEqual(await fee(solo), { pct: 2, source: 'global' });
    assert.deepEqual(await quoteFee(solo), { pct: 2, platform: '0.40', send: '19.60' });

    // Level 2, the reseller team fee, set by an admin. Freelancers on the
    // team only: the reseller's own account and a solo freelancer keep the
    // global default.
    await asUser(admin, async (c) => {
      assert.equal(Number((await c.query('select admin_set_reseller_withdrawal_fee($1, 1.5) as f', [reseller])).rows[0].f), 1.5);
    });
    await db.query('update reseller_settings set team_withdrawal_fee_percent = 1.5 where reseller_id = $1', [reseller]);
    assert.deepEqual(await fee(freelancer), { pct: 1.5, source: 'reseller' });
    assert.deepEqual(await fee(reseller), { pct: 2, source: 'global' });
    assert.deepEqual(await fee(solo), { pct: 2, source: 'global' });
    assert.deepEqual(await quoteFee(freelancer), { pct: 1.5, platform: '0.30', send: '19.70' });
    // The reseller can see their team fee; the freelancer sees only the result.
    const rv = await asUser(reseller, async (c) => (await c.query('select my_withdraw_settings() as s')).rows[0].s, { browser: true });
    assert.equal(Number(rv.reseller.team_withdrawal_fee_percent), 1.5);
    assert.equal(Number(rv.global_fee_percent), 2);
    const fv = await asUser(freelancer, async (c) => (await c.query('select my_withdraw_settings() as s')).rows[0].s, { browser: true });
    assert.equal(Number(fv.fee_percent), 1.5);
    assert.equal(fv.fee_source, 'reseller');

    // Level 1, the account's own override, beats both, including an explicit 0.
    await asUser(admin, async (c) => { await c.query('select admin_update_creator_fee($1, 0.5)', [freelancer]); });
    await db.query('update profiles set withdrawal_fee_percent = 0.5 where id = $1', [freelancer]);
    assert.deepEqual(await fee(freelancer), { pct: 0.5, source: 'account' });
    assert.deepEqual(await quoteFee(freelancer), { pct: 0.5, platform: '0.10', send: '19.90' });
    await db.query('update profiles set withdrawal_fee_percent = 0 where id = $1', [freelancer]);
    assert.deepEqual(await fee(freelancer), { pct: 0, source: 'account' });

    // Clearing the override (NULL) falls back to the team fee; clearing the
    // team fee falls back to the global default.
    await asUser(admin, async (c) => {
      await c.query('select admin_update_creator_fee($1, null)', [freelancer]);
      assert.equal((await c.query('select withdrawal_fee_percent from profiles where id = $1', [freelancer])).rows[0].withdrawal_fee_percent, null);
      await c.query('select admin_set_reseller_withdrawal_fee($1, null)', [reseller]);
      assert.equal(Number((await c.query('select resolve_withdrawal_fee($1) as f', [freelancer])).rows[0].f), 2);
    });
    await db.query('update profiles set withdrawal_fee_percent = null where id = $1', [freelancer]);
    assert.deepEqual(await fee(freelancer), { pct: 1.5, source: 'reseller' });

    // Every SQL path stores the resolved fee: manual request, reseller
    // team cash-out and auto-queue.
    await asUser(freelancer, async (c) => {
      assert.equal((await c.query(`select fee_percent::text, amount_after_fee::text from request_withdrawal(10, 'bkash', '01711000000')`)).rows[0].fee_percent, '1.50');
    });
    await db.query(`update profiles set wallet_bkash = '01711000000' where id = $1`, [freelancer]);
    await asUser(reseller, async (c) => {
      const r = (await c.query(`select fee_percent::text, amount_after_fee::text, destination from reseller_request_withdrawal_for($1, 10, 'bkash', 'typed-not-used')`, [freelancer])).rows[0];
      assert.equal(r.fee_percent, '1.50');
      assert.equal(Number(r.amount_after_fee), 9.85);
      assert.equal(r.destination, '01711000000');
    });
    await asUser(admin, async (c) => {
      await c.query(`update profiles set auto_withdraw_enabled = true, default_withdrawal_method = 'bkash', wallet_bkash = '01711000000' where id = $1`, [solo]);
      const id = (await c.query('select system_queue_withdrawal($1) as id', [solo])).rows[0].id;
      assert.equal((await c.query('select fee_percent::text from withdrawals where id = $1', [id])).rows[0].fee_percent, '2.00');
    });

    // A team fee change between quote and confirm is refused, nothing sent.
    const breez = fakeBreez();
    const w2 = service(breez);
    const q = await w2.quote({ userId: freelancer, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '20' });
    await db.query('update reseller_settings set team_withdrawal_fee_percent = 3 where reseller_id = $1', [reseller]);
    await assert.rejects(w2.confirm({ userId: freelancer, quoteId: q.quoteId }), /Withdrawal fee changed/);
    assert.equal(breez.calls.send, 0);
  } finally {
    await db.query(`update app_settings set value = $1 where key = 'default_withdrawal_fee_percent'`, [g.value]);
  }
});

test('only an admin sets fees; a freelancer cannot change their own fee and a reseller cannot set a team fee', async () => {
  const reseller = await makeReseller();
  const freelancer = await makeFreelancer(reseller);
  for (const who of [reseller, freelancer]) {
    await asUser(who, async (c) => {
      assert.match(await refusal(c, 'select admin_set_reseller_withdrawal_fee($1, 0)', [reseller]), /Not authorized/);
      assert.match(await refusal(c, 'select admin_set_default_withdrawal_fee(0)'), /Not authorized/);
      assert.match(await refusal(c, 'select admin_update_creator_fee($1, 0)', [freelancer]), /Not authorized/);
      assert.match(await refusal(c, 'select admin_list_reseller_settings()'), /Not authorized/);
      assert.match(await refusal(c, 'select admin_withdraw_fee_overview()'), /Not authorized/);
    });
  }
  // The profile guard stops a direct write to the override.
  await asUser(freelancer, async (c) => {
    assert.ok(await refusal(c, 'update profiles set withdrawal_fee_percent = 0 where id = $1', [freelancer]));
  });
});

test('the browser roles cannot call the fee and switch resolvers for other accounts', async () => {
  const { rows: r } = await db.query(`
    select p.proname, has_function_privilege('authenticated', p.oid, 'execute') as auth, has_function_privilege('anon', p.oid, 'execute') as anon,
           has_function_privilege('service_role', p.oid, 'execute') as service
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('resolve_withdrawal_fee', 'withdrawal_fee_resolution', 'self_withdraw_allowed', 'reseller_of')
     order by 1`);
  assert.deepEqual(r.map((x) => [x.proname, x.auth, x.anon, x.service]), [
    ['reseller_of', false, false, true],
    ['resolve_withdrawal_fee', false, false, true],
    ['self_withdraw_allowed', false, false, true],
    ['withdrawal_fee_resolution', false, false, true],
  ]);
});
