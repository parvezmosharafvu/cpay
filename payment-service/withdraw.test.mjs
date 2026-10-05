import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { TRON, EVM, BSC_USDT, LEAF_ERROR, fakeBreez } from './fake-breez.mjs';
import { createWithdrawals, splitFee, outcomeOf, fromBaseUnits, routeId, failedBeforeSend, networkFeeUsd, LEAF_RETRY_MS } from './withdraw.mjs';

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
    decimals: 6, contractAddress: null, minUsdCents: 100, maxUsdCents: 1_000_000, minUsd: 1, maxUsd: 10000,
  });
  await w.listRoutes();
  assert.equal(breez.calls.routes, 3);
});

test('withdrawal route limits compare integer cents at their exact boundaries', async () => {
  const user = await makeUser({ earned: 20, fee: 0 });
  const breez = fakeBreez();
  const getRoutes = breez.getCrossChainRoutes.bind(breez);
  breez.getCrossChainRoutes = async (args) => (await getRoutes(args)).map((p) => ({
    ...p,
    acceptedAssets: p.acceptedAssets.map((a) => ({ ...a, limits: { minUsdCents: 880, maxUsdCents: 880 } })),
  }));
  const w = service(breez);
  const quote = await w.quote({ userId: user, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '8.80' });
  assert.equal(quote.sendUsd, '8.80');
  await assert.rejects(w.quote({ userId: user, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '8.79' }), /minimum.*\$8\.80/);
});

test('stablecoin withdrawal converts USD cents to sats exactly with floor rounding', async () => {
  const user = await makeUser({ earned: 3000, fee: 0 });
  const w = service(fakeBreez(), { btcUsdRate: async () => 80000.32 });
  const quote = await w.quote({ userId: user, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '2500.01' });
  assert.equal(quote.amountSat, 3_125_000);
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

test('withdrawal quotes convert cents to sats exactly at decimal BTC rates', async () => {
  const user = await makeUser({ earned: 2500.01, fee: 0 });
  const w = service(fakeBreez(), { btcUsdRate: async () => 80000.32 });
  const q = await w.quote({ userId: user, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '2500.01' });
  assert.equal(q.amountSat, 3_125_000);
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

test.skip('USDT no longer goes to the admin queue: manual requests refuse it and auto-withdraw skips it', async () => {
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
// Withdrawal fee: the account's own override, else the global default
// (20261005020000). Every account withdraws by itself; an admin can also
// withdraw on an account's behalf.
// ---------------------------------------------------------------------------

async function makeAdmin() {
  const id = await makeUser({ earned: 10, fee: null });
  await db.query(`update profiles set role = 'admin' where id = $1`, [id]);
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

test('every freelancer quotes and confirms by themselves: there is no reseller switch any more', async () => {
  const freelancer = await makeUser({ earned: 100, fee: null });
  const view = await asUser(freelancer, async (c) => (await c.query('select my_withdraw_settings() as s')).rows[0].s, { browser: true });
  // Kept true for the previously deployed user-withdraw edge function.
  assert.equal(view.self_withdraw_allowed, true);
  for (const gone of ['has_reseller', 'team_withdraw_enabled', 'reseller']) assert.equal(gone in view, false, gone);
  const breez = fakeBreez();
  const w = service(breez);
  const q = await w.quote({ userId: freelancer, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '20' });
  const out = await w.confirm({ userId: freelancer, quoteId: q.quoteId });
  assert.equal(out.status, 'sending');
  assert.equal(breez.calls.send, 1);
  for (const t of ['reseller_settings', 'moderator_assignments']) {
    assert.equal((await db.query('select to_regclass($1) as t', [`public.${t}`])).rows[0].t, null, t);
  }
});

test('fee: the account override, else the global default, else none; the quote and every SQL path store it', async () => {
  const admin = await makeAdmin();
  const freelancer = await makeUser({ earned: 100, fee: null });
  const solo = await makeUser({ earned: 100, fee: null });
  const w = service(fakeBreez());
  const quoteFee = async (u) => {
    const q = await w.quote({ userId: u, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '20' });
    return { pct: Number(q.feePercent), platform: q.platformFeeUsd, send: q.sendUsd };
  };

  const { rows: [g] } = await db.query(`select value from app_settings where key = 'default_withdrawal_fee_percent'`);
  try {
    // The global default (0% since 0100): no platform fee at all.
    await db.query(`update app_settings set value = '{"percent": 0}' where key = 'default_withdrawal_fee_percent'`);
    assert.deepEqual(await fee(freelancer), { pct: 0, source: 'global' });
    assert.deepEqual(await quoteFee(freelancer), { pct: 0, platform: '0.00', send: '20.00' });

    // A non-zero global default, set by an admin (rolled back), then
    // committed for the quote; restored in finally.
    await asUser(admin, async (c) => {
      await c.query('select admin_set_default_withdrawal_fee(2)');
      assert.equal(Number((await c.query('select resolve_withdrawal_fee($1) as f', [freelancer])).rows[0].f), 2);
    });
    await db.query(`update app_settings set value = '{"percent": 2}' where key = 'default_withdrawal_fee_percent'`);
    assert.deepEqual(await fee(freelancer), { pct: 2, source: 'global' });
    assert.deepEqual(await quoteFee(solo), { pct: 2, platform: '0.40', send: '19.60' });
    const fv = await asUser(freelancer, async (c) => (await c.query('select my_withdraw_settings() as s')).rows[0].s, { browser: true });
    assert.deepEqual([Number(fv.fee_percent), fv.fee_source, Number(fv.global_fee_percent)], [2, 'global', 2]);

    // The account's own override beats it, including an explicit 0.
    await asUser(admin, async (c) => { await c.query('select admin_update_creator_fee($1, 0.5)', [freelancer]); });
    await db.query('update profiles set withdrawal_fee_percent = 0.5 where id = $1', [freelancer]);
    assert.deepEqual(await fee(freelancer), { pct: 0.5, source: 'account' });
    assert.deepEqual(await quoteFee(freelancer), { pct: 0.5, platform: '0.10', send: '19.90' });
    assert.deepEqual(await fee(solo), { pct: 2, source: 'global' });
    await db.query('update profiles set withdrawal_fee_percent = 0 where id = $1', [freelancer]);
    assert.deepEqual(await fee(freelancer), { pct: 0, source: 'account' });

    // Clearing the override (NULL) falls back to the global default.
    await asUser(admin, async (c) => {
      await c.query('select admin_update_creator_fee($1, null)', [freelancer]);
      assert.equal(Number((await c.query('select resolve_withdrawal_fee($1) as f', [freelancer])).rows[0].f), 2);
    });
    await db.query('update profiles set withdrawal_fee_percent = null where id = $1', [freelancer]);
    assert.deepEqual(await fee(freelancer), { pct: 2, source: 'global' });

    // No usable global default: no fee.
    await db.query(`update app_settings set value = '{"percent": "x"}' where key = 'default_withdrawal_fee_percent'`);
    assert.deepEqual(await fee(freelancer), { pct: 0, source: 'none' });
    await db.query(`update app_settings set value = '{"percent": 2}' where key = 'default_withdrawal_fee_percent'`);

    // Every SQL path stores the resolved fee: the admin's withdrawal on an
    // account's behalf (to its saved wallet, never a typed address) and
    // the auto-queue.
    await db.query(`insert into usdt_wallets(user_id, network, address) values ($1, 'tron', $2), ($3, 'tron', $2)`, [freelancer, TRON, solo]);
    await asUser(admin, async (c) => {
      const r = (await c.query(`select fee_percent::text, amount_after_fee::text, destination, admin_note from admin_request_withdrawal_for($1, 10, 'tron', 'typed-not-used')`, [freelancer])).rows[0];
      assert.deepEqual(r, { fee_percent: '2.00', amount_after_fee: '9.80000000', destination: TRON, admin_note: 'USDT payout submitted by admin' });
    });
    await asUser(admin, async (c) => {
      await c.query(`update profiles set auto_withdraw_enabled = true, preferred_usdt_network = 'tron', withdraw_threshold = 5 where id = $1`, [solo]);
      const id = (await c.query('select system_queue_withdrawal($1) as id', [solo])).rows[0].id;
      assert.equal((await c.query('select fee_percent::text from withdrawals where id = $1', [id])).rows[0].fee_percent, '2.00');
    });

    // A fee change between quote and confirm is refused, nothing sent.
    const breez = fakeBreez();
    const w2 = service(breez);
    const q = await w2.quote({ userId: freelancer, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '20' });
    await db.query(`update app_settings set value = '{"percent": 3}' where key = 'default_withdrawal_fee_percent'`);
    await assert.rejects(w2.confirm({ userId: freelancer, quoteId: q.quoteId }), (e) => e.status === 422 && /Withdrawal fee changed/.test(e.message));
    assert.equal(breez.calls.send, 0);
  } finally {
    await db.query(`update app_settings set value = $1 where key = 'default_withdrawal_fee_percent'`, [g.value]);
  }
});

test('only an admin sets fees or withdraws for another account', async () => {
  const freelancer = await makeUser({ earned: 100, fee: null });
  const other = await makeUser({ earned: 100, fee: null });
  await db.query(`insert into usdt_wallets(user_id, network, address) values ($1, 'tron', $2)`, [other, TRON]);
  const before = await balance(other);
  await asUser(freelancer, async (c) => {
    assert.match(await refusal(c, 'select admin_set_default_withdrawal_fee(0)'), /Not authorized/);
    assert.match(await refusal(c, 'select admin_update_creator_fee($1, 0)', [freelancer]), /Not authorized/);
    assert.match(await refusal(c, 'select admin_withdraw_fee_overview()'), /Not authorized/);
    assert.match(await refusal(c, `select admin_request_withdrawal_for($1, 10, 'tron', '')`, [other]), /Not authorized/);
    assert.match(await refusal(c, `select admin_request_withdrawal_for($1, 10, 'tron', '')`, [freelancer]), /Not authorized/);
  });
  // The profile guard stops a direct write to the override.
  await asUser(freelancer, async (c) => {
    assert.ok(await refusal(c, 'update profiles set withdrawal_fee_percent = 0 where id = $1', [freelancer]));
  });
  assert.deepEqual(await balance(other), before);
});

test('the browser roles cannot call the fee resolvers or the compatibility shim', async () => {
  const { rows: r } = await db.query(`
    select p.proname, has_function_privilege('authenticated', p.oid, 'execute') as auth, has_function_privilege('anon', p.oid, 'execute') as anon,
           has_function_privilege('service_role', p.oid, 'execute') as service
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('resolve_withdrawal_fee', 'withdrawal_fee_resolution', 'self_withdraw_allowed', 'reseller_of')
     order by 1`);
  assert.deepEqual(r.map((x) => [x.proname, x.auth, x.anon, x.service]), [
    ['resolve_withdrawal_fee', false, false, true],
    ['self_withdraw_allowed', false, false, true],
    ['withdrawal_fee_resolution', false, false, true],
  ]);
});
