import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createWithdrawals, splitFee, outcomeOf, fromBaseUnits, routeId, failedBeforeSend, LEAF_RETRY_MS } from './withdraw.mjs';

// Runs against a database with every migration applied. Unlike
// ledger.test.mjs this commits, because confirm and crash recovery need
// several connections to see each other's rows. Each test uses fresh users,
// all removed in after().
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const users = [];
const RATE = 100_000; // USD per BTC, so $1 = 1000 sats

const TRON = 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL';
const EVM = '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063';
const BSC_USDT = '0x55d398326f99059ff775485246999027b3197955';
const LEAF_ERROR = 'Wallet: Tree service error: generic error: Failed to select leaves after all retries';

function pair(chain, asset, { provider = 'orchestra', minUsdCents = 100, maxUsdCents = 1_000_000, bitcoin = true, decimals = 6, contractAddress } = {}) {
  return {
    provider, chain, asset, decimals, contractAddress, exactOutEligible: true, deliveryMethods: ['spark'],
    acceptedAssets: [{ asset: bitcoin ? { type: 'bitcoin' } : { type: 'token', tokenIdentifier: 'btkn1usdb' }, limits: { minUsdCents, maxUsdCents } }],
  };
}

// A stand-in for the Breez SDK with the calls withdraw.mjs makes. `mode`
// picks how sendPayment behaves; the first `leafFailures` sends throw the
// stale-reservation leaf error instead.
function fakeBreez({ mode = 'ok', feeBase = 520_000n, leafFailures = 0, quoteTtlMs = 60_000 } = {}) {
  const payments = new Map();
  const calls = { routes: 0, send: 0, prepare: 0, sync: 0 };
  const byFamily = {
    tron: [pair('tron', 'USDT')],
    // BSC USDT (BEP-20) has 18 decimals.
    evm: [pair('bsc', 'USDT', { decimals: 18, contractAddress: BSC_USDT }), pair('arbitrum', 'USDC'), pair('base', 'USDB', { bitcoin: false })],
    solana: [pair('solana', 'USDC')],
  };
  let release;
  const fake = {
    payments, calls, mode, leafFailures,
    releaseHang: () => release?.(),
    async getCrossChainRoutes({ addressDetails }) { calls.routes++; return byFamily[addressDetails.addressFamily] ?? []; },
    async parse(input) {
      if (/^0x[0-9a-fA-F]{40}$/.test(input)) return { type: 'crossChainAddress', address: input, addressFamily: 'evm' };
      if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(input)) return { type: 'crossChainAddress', address: input, addressFamily: 'tron' };
      throw new Error('unrecognized input');
    },
    async getInfo() { return { balanceSats: 50_000_000 }; },
    async syncWallet() { calls.sync++; return {}; },
    async prepareSendPayment({ paymentRequest, amount, feePolicy }) {
      calls.prepare++;
      // At RATE, 1 sat = $0.001 = 1000 base units of a 6-decimal stablecoin.
      const scale = 10n ** BigInt(paymentRequest.route.decimals - 6);
      const assetIn = amount * 1000n * scale;
      const fee = feeBase * scale;
      return {
        amount, feePolicy,
        paymentMethod: {
          type: 'crossChainAddress', route: paymentRequest.route, recipientAddress: paymentRequest.address,
          amountIn: String(amount), assetAmountIn: String(assetIn), estimatedOut: String(assetIn - fee), feeAmount: String(fee),
          serviceFeeAmount: '0', sourceTransferFeeSats: 0, feeMode: 'feesIncluded',
          expiresAt: new Date(Date.now() + quoteTtlMs).toISOString(),
          providerContext: { type: 'orchestra', quoteId: randomUUID(), depositAddress: 'sprt1deposit' },
        },
      };
    },
    async sendPayment({ prepareResponse, idempotencyKey }) {
      calls.send++;
      const store = (status = 'completed', conv = 'pending') => {
        const p = { id: idempotencyKey, paymentType: 'send', status, amount: prepareResponse.amount, conversionDetails: { status: conv } };
        if (!payments.has(idempotencyKey)) payments.set(idempotencyKey, p);
        return payments.get(idempotencyKey);
      };
      if (payments.has(idempotencyKey)) return { payment: payments.get(idempotencyKey) };
      if (fake.leafFailures > 0) { fake.leafFailures--; throw new Error(LEAF_ERROR); }
      if (fake.mode === 'ok') return { payment: store() };
      // The transfer went out, but the SDK still answered with the leaf error.
      if (fake.mode === 'leaf-after-transfer') { store(); throw new Error(LEAF_ERROR); }
      if (fake.mode === 'insufficient') throw new Error('Insufficient funds');
      if (fake.mode === 'network-after-transfer') { store(); throw new Error('Network error: connection reset'); }
      if (fake.mode === 'network-no-transfer') throw new Error('Network error: connection reset');
      if (fake.mode === 'spark-failed') return { payment: store('failed', undefined) };
      if (fake.mode === 'hang') return new Promise((resolve) => { release = () => resolve({ payment: store() }); });
      throw new Error(`unknown mode ${fake.mode}`);
    },
    async getPayment({ paymentId }) {
      if (!payments.has(paymentId)) throw new Error('Invalid input: Not found');
      return { payment: payments.get(paymentId) };
    },
    // Moves the cross-chain leg along, as Orchestra would.
    deliver(id, status, deliveredBase, decimals = 6) {
      const p = payments.get(id);
      p.conversionDetails = {
        status,
        conversions: deliveredBase == null ? [] : [{
          provider: 'orchestra', status,
          from: { chain: { type: 'spark' }, asset: { ticker: 'BTC', decimals: 8 }, amount: String(p.amount), fee: '0' },
          to: { chain: { type: 'external', name: 'tron' }, asset: { ticker: 'USDT', decimals }, amount: String(deliveredBase), fee: '0' },
        }],
      };
      return p;
    },
  };
  return fake;
}

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

test('quote shows the platform fee, the Breez fee and what arrives', async () => {
  const user = await makeUser({ earned: 200 });
  const w = service(fakeBreez());
  const q = await w.quote({ userId: user, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '120' });
  assert.equal(q.amountUsd, '120.00');
  assert.equal(q.feePercent, '3.00');
  assert.equal(q.platformFeeUsd, '3.60');
  assert.equal(q.sendUsd, '116.40');
  assert.equal(q.amountSat, 116_400);
  assert.equal(q.receive, '115.88');
  assert.equal(q.breezFeeUsd, '0.520000');
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
  assert.equal(paid.breez_payment_id, r.withdrawalId);
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
  assert.match(row.admin_note, /No Breez payment found/);
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
  assert.equal(q.breezFeeUsd, '0.520000');
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
