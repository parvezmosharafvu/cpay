import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createWithdrawals } from './withdraw.mjs';
import { createWallet, createAdminWalletRoute, bearerAuth, paymentView, owedToCreatorsUsd } from './wallet.mjs';
import { settlePayment } from './ledger.mjs';
import { usdToSats } from './money.mjs';

// The admin Wallet tab's service side, against a database with every
// migration applied and a fake Breez SDK. Other test files run at the same
// time and add creator balances, so amounts owed are read, never assumed.
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const users = [];
const RATE = 100_000; // USD per BTC: $1 = 1000 sats
const EVM = '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063';
const BOLT11 = 'lnbcrt50u1fakeinvoice';
const SPARK = 'sparkrt1fakeaddress';

after(async () => {
  if (users.length) {
    await db.query(`delete from audit_log where actor_id = any($1::uuid[]) and set_config('cpay.audit_maintenance', 'on', true) = 'on'`, [users]);
    await db.query('delete from auth.users where id = any($1::uuid[])', [users]);
  }
  await db.end();
});

async function makeUser({ role = 'creator', earned = 0 } = {}) {
  const id = randomUUID();
  users.push(id);
  await db.query(`insert into auth.users(id, email) values ($1, $2)`, [id, `wallet-${id}@test.invalid`]);
  await db.query(`update profiles set role = $2, account_status = 'active' where id = $1`, [id, role]);
  if (earned) {
    await db.query(
      `insert into payments(user_id, amount_requested, amount_settled, status, settled_at, expires_at)
       values ($1, $2, $2, 'settled', now(), now() + interval '1 hour')`, [id, earned]);
  }
  return id;
}

const balanceOf = async (id) => (await db.query('select earned::text, queued::text, available::text from get_balance_for($1)', [id])).rows[0];
const withdrawalCount = async (id) => Number((await db.query('select count(*) from withdrawals where user_id = $1', [id])).rows[0].count);
const auditRows = async (subjectId) => (await db.query(
  `select action, actor_id, new_value from audit_log where subject_type = 'platform_wallet_send' and subject_id = $1 order by id`, [subjectId])).rows;

function pair(chain, asset) {
  return {
    provider: 'orchestra', chain, asset, decimals: 6, exactOutEligible: true, deliveryMethods: ['spark'],
    acceptedAssets: [{ asset: { type: 'bitcoin' }, limits: { minUsdCents: 100, maxUsdCents: 1_000_000 } }],
  };
}

// The SDK calls wallet.mjs and withdraw.mjs make, with Breez-shaped answers
// (bigint amounts, unix-second timestamps).
function fakeBreez({ balanceSats = 1_000_000_000, leafFailures = 0 } = {}) {
  const calls = [];
  const sent = new Map();
  const fake = {
    calls, sent, balanceSats, leafFailures,
    async syncWallet() { calls.push(['syncWallet']); return {}; },
    async getInfo() { return { identityPubkey: '02ab', balanceSats: fake.balanceSats, tokenBalances: new Map() }; },
    async listPayments(req) {
      calls.push(['listPayments', req]);
      const all = Array.from({ length: 7 }, (_, i) => ({
        id: `p${i}`, paymentType: i % 2 ? 'send' : 'receive', status: 'completed', method: 'lightning',
        amount: BigInt(1000 * (i + 1)), fees: BigInt(i), timestamp: 1_790_000_000 - i * 60,
        details: { type: 'lightning', description: `memo ${i}`, invoice: `lnbcrt${i}`, destinationPubkey: '02', htlcDetails: {} },
      }));
      return { payments: all.slice(req.offset, req.offset + req.limit) };
    },
    async receivePayment({ paymentMethod }) {
      calls.push(['receivePayment', paymentMethod]);
      if (paymentMethod.type === 'sparkAddress') return { paymentRequest: SPARK, fee: 0n };
      return { paymentRequest: `lnbcrt${paymentMethod.amountSats}n1${paymentMethod.description.length}`, fee: 0n };
    },
    async getLightningAddress() { return { lightningAddress: 'cpay@breez.tips', username: 'cpay', description: '', lnurl: { url: 'https://breez.tips/lnurlp/cpay', bech32: 'lnurl1cpay' } }; },
    async parse(input) {
      if (input === BOLT11) return { type: 'bolt11Invoice', amountMsat: 5_000_000, invoice: { bolt11: input } };
      if (input === 'lnbcrt5003u1half-cent') return { type: 'bolt11Invoice', amountMsat: 5_003_000, invoice: { bolt11: input } };
      if (input === 'lnbcrt100000001u1too-large') return { type: 'bolt11Invoice', amountMsat: 100_000_001_000, invoice: { bolt11: input } };
      if (input === 'lnbcrt1amountless') return { type: 'bolt11Invoice', invoice: { bolt11: input } };
      if (input === SPARK) return { type: 'sparkAddress', address: input };
      if (input === 'friend@example.com') return { type: 'lightningAddress', address: input, payRequest: { callback: 'https://example.com/cb', minSendable: 1000, maxSendable: 1e11, domain: 'example.com' } };
      if (/^0x[0-9a-fA-F]{40}$/.test(input)) return { type: 'crossChainAddress', address: input, addressFamily: 'evm' };
      throw new Error('unrecognized input');
    },
    async getCrossChainRoutes({ addressDetails }) {
      return addressDetails.addressFamily === 'evm' ? [pair('arbitrum', 'USDC')] : [];
    },
    async prepareSendPayment(req) {
      calls.push(['prepareSendPayment', req]);
      const r = req.paymentRequest;
      if (r.type === 'crossChain') {
        const baseIn = req.amount * 1000n;
        return { amount: req.amount, feePolicy: req.feePolicy, paymentMethod: {
          type: 'crossChainAddress', route: r.route, recipientAddress: r.address, amountIn: String(req.amount), assetAmountIn: String(baseIn),
          estimatedOut: String(baseIn - 300_000n), feeAmount: '300000', serviceFeeAmount: '0', sourceTransferFeeSats: 0, feeMode: 'feesIncluded',
          expiresAt: new Date(Date.now() + 60_000).toISOString(), providerContext: { type: 'orchestra' } } };
      }
      if (r.input === SPARK) return { amount: req.amount, feePolicy: 'feesExcluded', paymentMethod: { type: 'sparkAddress', address: SPARK, fee: '0' } };
      const amount = req.amount ?? 5000n;
      return { amount, feePolicy: 'feesExcluded', paymentMethod: { type: 'bolt11Invoice', invoiceDetails: {}, lightningFeeSats: 12, sparkTransferFeeSats: 0 } };
    },
    async prepareLnurlPay(req) {
      calls.push(['prepareLnurlPay', req]);
      return { amountSats: Number(req.amount), feeSats: 7, payRequest: req.payRequest, invoiceDetails: {}, feePolicy: 'feesExcluded' };
    },
    async sendPayment({ prepareResponse, idempotencyKey }) {
      calls.push(['sendPayment', idempotencyKey]);
      if (fake.leafFailures > 0) { fake.leafFailures--; throw new Error('Wallet: Tree service error: generic error: Failed to select leaves after all retries'); }
      return { payment: fake.store(idempotencyKey, prepareResponse.amount) };
    },
    async lnurlPay({ prepareResponse, idempotencyKey }) {
      calls.push(['lnurlPay', idempotencyKey]);
      return { payment: fake.store(idempotencyKey, BigInt(prepareResponse.amountSats)) };
    },
    store(id, amount) {
      if (!sent.has(id)) sent.set(id, { id, paymentType: 'send', status: 'completed', method: 'lightning', amount, fees: 12n, timestamp: Math.floor(Date.now() / 1000) });
      return sent.get(id);
    },
    async getPayment({ paymentId }) {
      if (!sent.has(paymentId)) throw new Error('Invalid input: Not found');
      return { payment: sent.get(paymentId) };
    },
    async listFiatCurrencies() {
      return { currencies: [
        { id: 'EUR', info: { name: 'Euro', fractionSize: 2, symbol: { grapheme: '€' } } },
        { id: 'USD', info: { name: 'United States Dollar', fractionSize: 2, symbol: { grapheme: '$' } } },
        { id: 'BDT', info: { name: 'Bangladeshi Taka', fractionSize: 2 } },
      ] };
    },
    async listFiatRates() { return { rates: [{ coin: 'USD', value: RATE }, { coin: 'EUR', value: 92_000 }, { coin: 'BDT', value: 0 }] }; },
  };
  return fake;
}

function setup(breez = fakeBreez(), opts = {}) {
  const btcUsdRate = opts.btcUsdRate ?? (async () => RATE);
  const withdrawals = createWithdrawals({ breez, db, btcUsdRate });
  const wallet = createWallet({ breez, db, btcUsdRate, withdrawals, ...opts });
  return { breez, withdrawals, wallet, route: createAdminWalletRoute({ wallet, withdrawals }) };
}

test('the service secret is compared exactly', () => {
  const ok = bearerAuth('s3cret');
  assert.equal(ok('Bearer s3cret'), true);
  for (const bad of [undefined, '', 'Bearer s3cre', 'Bearer s3cret ', 's3cret', 'bearer s3cret']) assert.equal(ok(bad), false, String(bad));
});

test('every wallet action is refused with 403 unless adminId is an admin', async () => {
  const { route, breez } = setup();
  const creator = await makeUser({ role: 'creator' });
  const reseller = await makeUser({ role: 'moderator' });
  const actions = ['info', 'payments', 'receive', 'addresses', 'send-prepare', 'send-confirm', 'stable-routes', 'stable-quote', 'stable-confirm', 'fiat'];
  for (const action of actions) {
    for (const adminId of [creator, reseller, randomUUID(), 'not-a-uuid', undefined]) {
      const [status, body] = await route('POST', `/admin/wallet/${action}`, { adminId, amountSat: 1000, destination: BOLT11 });
      assert.equal(status, 403, `${action} as ${adminId}`);
      assert.deepEqual(body, { error: 'admin only' });
    }
  }
  assert.equal(breez.calls.length, 0, 'no SDK call was made for a non-admin');
  assert.equal((await route('POST', '/admin/wallet/nope', {}))[0], 404);
  assert.equal((await route('GET', '/admin/wallet/info', null))[0], 405);
});

test('info shows sats, USD at the Breez rate and what is owed to creators', async () => {
  const { route } = setup(fakeBreez({ balanceSats: 250_000_000 }));
  const admin = await makeUser({ role: 'admin' });
  await makeUser({ earned: 40 });
  const [status, info] = await route('POST', '/admin/wallet/info', { adminId: admin });
  assert.equal(status, 200);
  assert.equal(info.balanceSats, 250_000_000);
  assert.equal(info.btcUsdRate, RATE);
  assert.equal(info.balanceUsd, '250000.00');
  assert.ok(Number(info.owedToCreatorsUsd) >= 40);
  assert.equal(info.owedToCreatorsSat, usdToSats(await owedToCreatorsUsd(db), RATE));
  assert.equal(info.spendableSat, 250_000_000 - info.owedToCreatorsSat);
});

test('wallet info preserves exact liabilities and rounds monetary values half-up', async () => {
  const dbStub = { query: async () => ({ rows: [{ owed: '2.67500000' }] }) };
  const wallet = createWallet({
    breez: fakeBreez({ balanceSats: 1015 }), db: dbStub,
    btcUsdRate: async () => RATE, withdrawals: {},
  });
  const info = await wallet.info();
  assert.equal(info.balanceUsd, '1.02');
  assert.equal(info.owedToCreatorsUsd, '2.68');
  assert.equal(info.owedToCreatorsSat, 2675);
});

test('send quote rounds the total to cents using exact half-up arithmetic', async () => {
  const wallet = createWallet({
    breez: fakeBreez(), db: { query: async () => ({ rows: [{ owed: '0' }] }) },
    btcUsdRate: async () => RATE, withdrawals: {},
  });
  const quote = await wallet.sendPrepare({ adminId: randomUUID(), destination: 'lnbcrt5003u1half-cent' });
  assert.equal(quote.totalUsd, '5.02');
});

test('admin stablecoin quote converts USD cents to sats exactly with floor rounding', async () => {
  const route = {
    id: 'orchestra:arbitrum:usdc', provider: 'orchestra', asset: 'USDC', chain: 'arbitrum',
    family: 'evm', decimals: 6, minUsdCents: 100, maxUsdCents: 1_000_000,
    minUsd: 1, maxUsd: 10_000,
  };
  const withdrawals = {
    listRoutes: async () => [route],
    validateAddress: async (address) => address,
    prepareCrossChain: async () => ({
      pair: route, prepared: {}, expiresAtMs: Date.now() + 60_000, estimatedOutBase: '0',
      providerFee: { amount: '0', asset: 'USDC' }, receive: '1', receiveMin: '0.9',
    }),
  };
  const wallet = createWallet({
    breez: fakeBreez(), db: { query: async () => ({ rows: [{ owed: '0' }] }) },
    btcUsdRate: async () => 80000.32, withdrawals,
  });
  const quote = await wallet.stableQuote({
    adminId: randomUUID(), routeId: route.id, address: EVM, amountUsd: '2500.01',
  });
  assert.equal(quote.amountSat, 3_125_000);
});

test('payments are paged, newest first, with bigints as strings', async () => {
  const { route, breez } = setup();
  const admin = await makeUser({ role: 'admin' });
  const [, page1] = await route('POST', '/admin/wallet/payments', { adminId: admin, offset: 0, limit: 5 });
  assert.equal(page1.payments.length, 5);
  assert.equal(page1.hasMore, true);
  assert.deepEqual(page1.payments[1], {
    id: 'p1', type: 'send', status: 'completed', method: 'lightning', amountSat: '2000', feeSat: '1',
    at: new Date((1_790_000_000 - 60) * 1000).toISOString(), description: 'memo 1', invoice: 'lnbcrt1', lightningAddress: null, conversion: null,
  });
  const [, page2] = await route('POST', '/admin/wallet/payments', { adminId: admin, offset: 5, limit: 5 });
  assert.equal(page2.payments.length, 2);
  assert.equal(page2.hasMore, false);
  await route('POST', '/admin/wallet/payments', { adminId: admin, limit: 5000 });
  assert.deepEqual(breez.calls.filter((c) => c[0] === 'listPayments').map((c) => c[1]), [
    { offset: 0, limit: 5, sortAscending: false }, { offset: 5, limit: 5, sortAscending: false }, { offset: 0, limit: 50, sortAscending: false },
  ]);
  assert.doesNotThrow(() => JSON.stringify(page1));
});

test('receive makes a bolt11 for the amount and memo', async () => {
  const { route, breez } = setup();
  const admin = await makeUser({ role: 'admin' });
  const [status, inv] = await route('POST', '/admin/wallet/receive', { adminId: admin, amountSat: '2500', memo: '  top up  ' });
  assert.equal(status, 200);
  assert.equal(inv.amountSat, 2500);
  assert.equal(inv.memo, 'top up');
  assert.match(inv.bolt11, /^lnbcrt2500n1/);
  assert.deepEqual(breez.calls.at(-1), ['receivePayment', { type: 'bolt11Invoice', description: 'top up', amountSats: 2500, expirySecs: 3600 }]);
  await assert.rejects(route('POST', '/admin/wallet/receive', { adminId: admin, amountSat: '1.5' }), /whole number of sats/);
  await assert.rejects(route('POST', '/admin/wallet/receive', { adminId: admin, amountSat: 0 }), /between 1 and/);
});

test('addresses show the Spark address and the Lightning address', async () => {
  const { route } = setup();
  const admin = await makeUser({ role: 'admin' });
  const [, a] = await route('POST', '/admin/wallet/addresses', { adminId: admin });
  assert.deepEqual(a, { sparkAddress: SPARK, lightningAddress: 'cpay@breez.tips', lnurl: 'lnurl1cpay', notes: [] });
});

test('a bolt11 send shows the fee, then sends once, audits twice and leaves creator balances alone', async () => {
  const { route, breez, withdrawals } = setup();
  const admin = await makeUser({ role: 'admin' });
  const creator = await makeUser({ earned: 75 });
  const before = await balanceOf(creator);

  const [, prep] = await route('POST', '/admin/wallet/send-prepare', { adminId: admin, destination: BOLT11 });
  assert.equal(prep.kind, 'lightning');
  assert.equal(prep.amountSat, 5000);
  assert.equal(prep.feeSat, 12);
  assert.equal(prep.totalSat, 5012);
  assert.equal(prep.totalUsd, '5.01');
  assert.equal(breez.calls.filter((c) => c[0] === 'sendPayment').length, 0, 'prepare does not send');

  const other = await makeUser({ role: 'admin' });
  await assert.rejects(route('POST', '/admin/wallet/send-confirm', { adminId: other, prepareId: prep.prepareId }), /Nothing to confirm/);

  const [a, b] = await Promise.all([
    route('POST', '/admin/wallet/send-confirm', { adminId: admin, prepareId: prep.prepareId }),
    route('POST', '/admin/wallet/send-confirm', { adminId: admin, prepareId: prep.prepareId }),
  ]);
  assert.deepEqual(a, b);
  assert.equal(a[1].status, 'completed');
  assert.deepEqual(breez.calls.filter((c) => c[0] === 'sendPayment'), [['sendPayment', prep.prepareId]]);

  const log = await auditRows(prep.prepareId);
  assert.deepEqual(log.map((r) => [r.action, r.actor_id, r.new_value.status]), [
    ['platform_wallet.send', admin, 'sending'],
    ['platform_wallet.send.result', admin, 'completed'],
  ]);
  assert.equal(log[0].new_value.destination, BOLT11);
  assert.equal(log[1].new_value.breezPaymentId, prep.prepareId);

  assert.deepEqual(await balanceOf(creator), before);
  assert.equal(await withdrawalCount(creator), 0);
  assert.equal(await withdrawals.onPayment(breez.sent.get(prep.prepareId)), null, 'the withdrawal tracker ignores admin sends');
});

test('an admin send that hits the leaf error is retried after a sync with the same key, and audited once', async () => {
  const slept = [];
  const { route, breez } = setup(fakeBreez({ leafFailures: 2 }), { sleep: async (ms) => { slept.push(ms); } });
  const admin = await makeUser({ role: 'admin' });
  const [, prep] = await route('POST', '/admin/wallet/send-prepare', { adminId: admin, destination: BOLT11 });
  const [, sent] = await route('POST', '/admin/wallet/send-confirm', { adminId: admin, prepareId: prep.prepareId });
  assert.equal(sent.status, 'completed');
  assert.deepEqual(slept, [5_000, 10_000]);
  assert.deepEqual(breez.calls.filter((c) => c[0] === 'sendPayment' || c[0] === 'syncWallet'), [
    ['sendPayment', prep.prepareId], ['syncWallet'], ['sendPayment', prep.prepareId], ['syncWallet'], ['sendPayment', prep.prepareId],
  ]);
  assert.equal(breez.sent.size, 1);
  assert.deepEqual((await auditRows(prep.prepareId)).map((r) => r.new_value.status), ['sending', 'completed']);
});

test('Lightning address sends go through LNURL-pay and Spark sends through prepareSendPayment', async () => {
  const { route, breez } = setup();
  const admin = await makeUser({ role: 'admin' });
  const [, ln] = await route('POST', '/admin/wallet/send-prepare', { adminId: admin, destination: 'friend@example.com', amountSat: 3000 });
  assert.equal(ln.kind, 'lightning_address');
  assert.equal(ln.feeSat, 7);
  const prepLn = breez.calls.find((c) => c[0] === 'prepareLnurlPay')[1];
  assert.equal(prepLn.amount, 3000n);
  assert.equal(prepLn.payRequest.domain, 'example.com');
  const [, lnSent] = await route('POST', '/admin/wallet/send-confirm', { adminId: admin, prepareId: ln.prepareId });
  assert.equal(lnSent.payment.amountSat, '3000');
  assert.deepEqual(breez.calls.filter((c) => c[0] === 'lnurlPay'), [['lnurlPay', ln.prepareId]]);

  const [, sp] = await route('POST', '/admin/wallet/send-prepare', { adminId: admin, destination: SPARK, amountSat: 1234 });
  assert.equal(sp.kind, 'spark');
  assert.equal(sp.feeSat, 0);
  assert.deepEqual(breez.calls.at(-1), ['prepareSendPayment', { paymentRequest: { type: 'input', input: SPARK }, amount: 1234n }]);

  await assert.rejects(route('POST', '/admin/wallet/send-prepare', { adminId: admin, destination: SPARK }), /whole number of sats/);
  await assert.rejects(route('POST', '/admin/wallet/send-prepare', { adminId: admin, destination: 'lnbcrt1amountless' }), /whole number of sats/);
  await assert.rejects(route('POST', '/admin/wallet/send-prepare', { adminId: admin, destination: 'lnbcrt100000001u1too-large' }), /Invoice amount must be between 1 and 100000000 sats/);
  await assert.rejects(route('POST', '/admin/wallet/send-prepare', { adminId: admin, destination: 'hello' }), /Paste a Lightning invoice/);
  await assert.rejects(route('POST', '/admin/wallet/send-prepare', { adminId: admin, destination: EVM, amountSat: 10 }), /Use Withdraw stablecoin/);
});

test('a send that would dip into money owed to creators is refused', async () => {
  const breez = fakeBreez();
  const { route, wallet } = setup(breez);
  const admin = await makeUser({ role: 'admin' });
  await makeUser({ earned: 20_000 });
  const { owedSat } = await wallet.spendable();
  // The wallet holds at least 10M sats, far more than the send, but all of
  // it is owed. The margin is for other test files, running at the same
  // time, whose withdrawals get paid or whose users are deleted, lowering
  // what is owed.
  breez.balanceSats = owedSat - 10_000_000;
  await assert.rejects(route('POST', '/admin/wallet/send-prepare', { adminId: admin, destination: BOLT11 }), (e) => {
    assert.equal(e.status, 422);
    assert.match(e.message, /needs 5012 sats but only \d+ are spendable/);
    return true;
  });
  breez.balanceSats = owedSat + 1_000_000;
  const [, prep] = await route('POST', '/admin/wallet/send-prepare', { adminId: admin, destination: BOLT11 });
  breez.balanceSats = owedSat - 10_000_000; // the balance fell between prepare and confirm
  await assert.rejects(route('POST', '/admin/wallet/send-confirm', { adminId: admin, prepareId: prep.prepareId }), /only 0 are spendable/);
  assert.equal(breez.calls.filter((c) => c[0] === 'sendPayment').length, 0);
  assert.deepEqual(await auditRows(prep.prepareId), [], 'nothing is audited when nothing is sent');
});

test('the stablecoin send quotes through the withdraw route logic and never writes a withdrawal', async () => {
  const { route, breez, withdrawals } = setup();
  const admin = await makeUser({ role: 'admin' });
  const creator = await makeUser({ earned: 60 });
  const before = await balanceOf(creator);

  const [, routes] = await route('POST', '/admin/wallet/stable-routes', { adminId: admin });
  assert.deepEqual(routes.routes.map((r) => r.id), ['orchestra:arbitrum:usdc']);
  await assert.rejects(route('POST', '/admin/wallet/stable-quote', { adminId: admin, routeId: 'orchestra:arbitrum:usdc', address: 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL', amountUsd: '20' }), /not a valid EVM address/);
  await assert.rejects(route('POST', '/admin/wallet/stable-quote', { adminId: admin, routeId: 'orchestra:arbitrum:usdc', address: EVM, amountUsd: '0.50' }), /minimum for USDC on arbitrum is \$1.00/);

  const [, q] = await route('POST', '/admin/wallet/stable-quote', { adminId: admin, routeId: 'orchestra:arbitrum:usdc', address: EVM, amountUsd: '20' });
  assert.equal(q.amountSat, 20_000);
  assert.equal(q.receive, '19.7');
  assert.equal(q.receiveMin, '19.503');
  assert.deepEqual(q.providerFee, { amount: '0.3', asset: 'USDC' });
  assert.equal(q.networkFeeUsd, '0.3');
  const prep = breez.calls.filter((c) => c[0] === 'prepareSendPayment').at(-1)[1];
  assert.equal(prep.paymentRequest.type, 'crossChain');
  assert.equal(prep.paymentRequest.maxSlippageBps, 100);
  assert.equal(prep.feePolicy, 'feesIncluded');

  const [, sent] = await route('POST', '/admin/wallet/stable-confirm', { adminId: admin, quoteId: q.quoteId });
  assert.equal(sent.kind, 'stablecoin');
  const log = await auditRows(q.quoteId);
  assert.deepEqual(log.map((r) => [r.action, r.new_value.kind, r.new_value.asset, r.new_value.chain]), [
    ['platform_wallet.send', 'stablecoin', 'USDC', 'arbitrum'],
    ['platform_wallet.send.result', 'stablecoin', 'USDC', 'arbitrum'],
  ]);
  assert.deepEqual(await balanceOf(creator), before);
  assert.equal((await db.query('select count(*) from withdrawals where id::text = $1 or quote_id::text = $1', [q.quoteId])).rows[0].count, '0');
  assert.deepEqual(await withdrawals.reconcile({ synced: true }).then(() => 'ok'), 'ok');
});

test('admin stablecoin quote accepts an exact integer-cent route maximum', async () => {
  const breez = fakeBreez();
  const getRoutes = breez.getCrossChainRoutes.bind(breez);
  breez.getCrossChainRoutes = async (args) => (await getRoutes(args)).map((p) => ({
    ...p,
    acceptedAssets: p.acceptedAssets.map((a) => ({ ...a, limits: { minUsdCents: 100, maxUsdCents: 201 } })),
  }));
  const { route } = setup(breez);
  const admin = await makeUser({ role: 'admin' });
  const [, quote] = await route('POST', '/admin/wallet/stable-quote', {
    adminId: admin, routeId: 'orchestra:arbitrum:usdc', address: EVM, amountUsd: '2.01',
  });
  assert.equal(quote.amountUsd, '2.01');
});

test('admin stablecoin quotes convert cents to sats exactly at decimal BTC rates', async () => {
  const { route, breez } = setup(fakeBreez(), { btcUsdRate: async () => 80000.32 });
  const admin = await makeUser({ role: 'admin' });
  const [, quote] = await route('POST', '/admin/wallet/stable-quote', {
    adminId: admin, routeId: 'orchestra:arbitrum:usdc', address: EVM, amountUsd: '2500.01',
  });
  assert.equal(quote.amountSat, 3_125_000);
  const prep = breez.calls.filter((c) => c[0] === 'prepareSendPayment').at(-1)[1];
  assert.equal(prep.amount, 3_125_000n);
});

test('a Lightning payment into an admin invoice credits no creator', async () => {
  const creator = await makeUser({ earned: 30 });
  const before = await balanceOf(creator);
  const outcome = await settlePayment(db, {
    id: `adm-${randomUUID()}`, paymentType: 'receive', status: 'completed', amount: 2500n,
    details: { type: 'lightning', htlcDetails: { paymentHash: randomUUID().replace(/-/g, '').padEnd(64, '0') } },
  });
  assert.equal(outcome, 'unknown');
  assert.deepEqual(await balanceOf(creator), before);
});

test('fiat lists every currency with its Breez rate, USD first', async () => {
  const { route } = setup();
  const admin = await makeUser({ role: 'admin' });
  const [, f] = await route('POST', '/admin/wallet/fiat', { adminId: admin });
  assert.deepEqual(f, { rateCount: 3, currencies: [
    { id: 'USD', name: 'United States Dollar', symbol: '$', fractionSize: 2, btcRate: RATE },
    { id: 'BDT', name: 'Bangladeshi Taka', symbol: null, fractionSize: 2, btcRate: null },
    { id: 'EUR', name: 'Euro', symbol: '€', fractionSize: 2, btcRate: 92_000 },
  ] });
});

test('paymentView handles a payment without details', () => {
  assert.deepEqual(paymentView({ id: 'x', paymentType: 'receive', status: 'pending', method: 'spark', amount: 5n, fees: 0n, timestamp: 0 }), {
    id: 'x', type: 'receive', status: 'pending', method: 'spark', amountSat: '5', feeSat: '0', at: '1970-01-01T00:00:00.000Z',
    description: null, invoice: null, lightningAddress: null, conversion: null,
  });
});
