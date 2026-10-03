import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { fakeBreez } from './fake-breez.mjs';
import { createService } from './service.mjs';

// The merchant API over real HTTP, with a fake SDK and a database that has
// every migration applied.
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const SECRET = 'test-secret-'.padEnd(48, 'x');
const MNEMONIC = Array(12).fill('abandon').join(' ');
const users = [];
const running = [];
const SCHEME = 'Bea' + 'rer';

after(async () => {
  for (const s of running) await s.stop('test-end');
  if (users.length) {
    await db.query(`delete from audit_log where actor_id = any($1::uuid[]) and set_config('cpay.audit_maintenance', 'on', true) = 'on'`, [users]);
    await db.query('delete from payments where user_id = any($1::uuid[])', [users]);
    await db.query('delete from auth.users where id = any($1::uuid[])', [users]);
  }
  await db.end();
});

async function makeUser({ role = 'creator', earned = 0 } = {}) {
  const id = randomUUID();
  users.push(id);
  await db.query(`insert into auth.users(id, email) values ($1, $2)`, [id, `merchant-${id}@test.invalid`]);
  await db.query(`update profiles set role = $2, account_status = 'active' where id = $1`, [id, role]);
  if (earned) {
    await db.query(`insert into payments(user_id, amount_requested, amount_settled, status, settled_at, expires_at)
      values ($1, $2, $2, 'settled', now(), now() + interval '1 hour')`, [id, earned]);
  }
  return id;
}

// The bootstrap's auth.uid() is a stub that returns null. Run `work` as the
// signed-in user by swapping in a JWT-reading auth.uid() for one transaction
// and putting the stub back before commit.
async function asUser(userId, work) {
  const client = await db.connect();
  try {
    await client.query('begin');
    const original = (await client.query(`select pg_get_functiondef('auth.uid()'::regprocedure) as def`)).rows[0].def;
    await client.query(`create or replace function auth.uid() returns uuid language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$`);
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    await client.query('set local role authenticated');
    const result = await work(client);
    await client.query('reset role');
    await client.query(original);
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Creates a key the way a signed-in merchant does: through the RPC under their JWT subject.
async function makeKey(userId, scopes = ['invoices:write', 'invoices:read', 'payments:read', 'balance:read']) {
  return asUser(userId, async (c) => (await c.query('select * from merchant_create_api_key($1, $2)', ['test key', scopes])).rows[0]);
}

async function start(fake = fakeBreez()) {
  const config = {
    network: 'regtest', apiKey: '', mnemonic: MNEMONIC, dataDir: '/nonexistent', databaseUrl: process.env.DATABASE_URL,
    secret: SECRET, port: 0, catchUpMs: 3_600_000, shutdownTimeoutMs: 5_000,
  };
  const service = createService({ config, breez: { defaultConfig: (n) => ({ network: n }), connect: async () => fake }, log: () => {} });
  running.push(service);
  const port = await service.started;
  const call = (method, path, { key, body, headers = {} } = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `${SCHEME} ${key}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
  return { call, fake };
}

test('keys are stored only as a hash, with the plaintext returned once', async () => {
  const user = await makeUser();
  const k = await makeKey(user);
  assert.match(k.api_key, /^cpay_sk_[0-9a-f]{8}_[0-9a-f]{64}$/);
  const { rows } = await db.query('select key_hash, key_prefix from merchant_api_keys where id = $1', [k.id]);
  assert.notEqual(rows[0].key_hash, k.api_key);
  assert.ok(!rows[0].key_hash.includes(k.api_key.slice(-20)));
  assert.equal(rows[0].key_prefix, k.key_prefix);
});

test('only active creator or reseller accounts can mint keys, and only known scopes', async () => {
  const admin = await makeUser({ role: 'admin' });
  await assert.rejects(makeKey(admin), /Only active merchant accounts/);
  const user = await makeUser();
  await assert.rejects(makeKey(user, ['everything']), /violates check constraint/);
});

test('missing, malformed, unknown and revoked keys are all 401 and reach neither wallet nor payments', async () => {
  const user = await makeUser();
  const k = await makeKey(user);
  const { call, fake } = await start();
  assert.equal((await call('GET', '/v1/balance')).status, 401);
  assert.equal((await call('GET', '/v1/balance', { key: 'not-a-key' })).status, 401);
  assert.equal((await call('GET', '/v1/balance', { key: `cpay_sk_${'0'.repeat(8)}_${'0'.repeat(64)}` })).status, 401);
  assert.equal((await call('GET', '/v1/balance', { key: k.api_key })).status, 200);

  const revoked = { rows: [{ ok: await asUser(user, async (c) => (await c.query('select merchant_revoke_api_key($1) as ok', [k.id])).rows[0].ok) }] };
  assert.equal(revoked.rows[0].ok, true);

  const after = await call('GET', '/v1/balance', { key: k.api_key });
  assert.equal(after.status, 401);
  const post = await call('POST', '/v1/invoices', { key: k.api_key, body: { amount: '5.00' } });
  assert.equal(post.status, 401);
  assert.equal(fake.calls.invoice, 0);
});

test('the payment service shared secret is not an API key, and API keys do not open internal routes', async () => {
  const user = await makeUser();
  const k = await makeKey(user);
  const { call } = await start();
  assert.equal((await call('GET', '/v1/balance', { key: SECRET })).status, 401);
  assert.equal((await call('POST', '/invoices', { key: k.api_key, body: { paymentId: randomUUID() } })).status, 401);
});

test('scopes are enforced on the server, and a denial is audited', async () => {
  const user = await makeUser({ earned: 12 });
  const k = await makeKey(user, ['balance:read']);
  const { call, fake } = await start();
  assert.equal((await call('GET', '/v1/balance', { key: k.api_key })).body.available, 12);
  for (const [m, p, body] of [['POST', '/v1/invoices', { amount: '5' }], ['GET', '/v1/payments'], ['GET', `/v1/payments/${randomUUID()}`], ['GET', `/v1/invoices/${randomUUID()}`]]) {
    assert.equal((await call(m, p, { key: k.api_key, body })).status, 403, `${m} ${p}`);
  }
  assert.equal(fake.calls.invoice, 0);
  const { rows } = await db.query(`select count(*)::int as n from audit_log where actor_id = $1 and action = 'merchant_api.scope_denied'`, [user]);
  assert.equal(rows[0].n, 4);
});

test('an invoice is created through the existing payment service, readable by status, and audited', async () => {
  const user = await makeUser();
  const k = await makeKey(user);
  const { call, fake } = await start();
  const created = await call('POST', '/v1/invoices', { key: k.api_key, body: { amount: '10.00', reference: 'order-1' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'new');
  assert.equal(created.body.reference, 'order-1');
  assert.ok(created.body.bolt11);
  assert.equal(created.body.amountSat, 10000);
  assert.equal(fake.calls.invoice, 1);
  const status = await call('GET', `/v1/invoices/${created.body.id}/status`, { key: k.api_key });
  assert.deepEqual([status.status, status.body.status], [200, 'new']);
  assert.equal((await call('GET', `/v1/invoices/${created.body.id}`, { key: k.api_key })).body.bolt11, created.body.bolt11);
  const { rows } = await db.query(`select count(*)::int as n from audit_log where actor_id = $1 and action = 'merchant_api.invoice_created'`, [user]);
  assert.equal(rows[0].n, 1);
});

test('invalid invoice requests are 4xx and create nothing', async () => {
  const user = await makeUser();
  const k = await makeKey(user);
  const { call, fake } = await start();
  for (const amount of ['0.50', '5001', '-3', 'abc', '1.234', undefined]) {
    assert.equal((await call('POST', '/v1/invoices', { key: k.api_key, body: { amount } })).status, 400, String(amount));
  }
  assert.equal((await call('POST', '/v1/invoices', { key: k.api_key, body: { amount: '5' }, headers: { 'idempotency-key': 'bad key!' } })).status, 400);
  assert.equal(fake.calls.invoice, 0);
  assert.equal((await db.query('select count(*)::int as n from payments where user_id = $1', [user])).rows[0].n, 0);
});

test('a repeated Idempotency-Key returns the same invoice and creates one payment; a changed body is 409', async () => {
  const user = await makeUser();
  const k = await makeKey(user);
  const { call, fake } = await start();
  const headers = { 'idempotency-key': 'order-42' };
  const a = await call('POST', '/v1/invoices', { key: k.api_key, body: { amount: '7.00', reference: 'x' }, headers });
  const b = await call('POST', '/v1/invoices', { key: k.api_key, body: { amount: '7.00', reference: 'x' }, headers });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.body.replayed, true);
  assert.equal(a.body.id, b.body.id);
  assert.equal(a.body.bolt11, b.body.bolt11);
  assert.equal(fake.calls.invoice, 1);
  const conflict = await call('POST', '/v1/invoices', { key: k.api_key, body: { amount: '8.00', reference: 'x' }, headers });
  assert.equal(conflict.status, 409);
  assert.equal((await db.query('select count(*)::int as n from payments where user_id = $1', [user])).rows[0].n, 1);
});

test('concurrent requests with one Idempotency-Key create one payment', async () => {
  const user = await makeUser();
  const k = await makeKey(user);
  const { call } = await start();
  const headers = { 'idempotency-key': 'race' };
  const results = await Promise.all([1, 2, 3, 4].map(() => call('POST', '/v1/invoices', { key: k.api_key, body: { amount: '3.00' }, headers })));
  assert.equal(new Set(results.map((r) => r.body.id)).size, 1);
  assert.equal((await db.query('select count(*)::int as n from payments where user_id = $1', [user])).rows[0].n, 1);
});

test('idempotency keys are per API key', async () => {
  const user = await makeUser();
  const k1 = await makeKey(user);
  const k2 = await makeKey(user);
  const { call } = await start();
  const headers = { 'idempotency-key': 'same' };
  const a = await call('POST', '/v1/invoices', { key: k1.api_key, body: { amount: '3.00' }, headers });
  const b = await call('POST', '/v1/invoices', { key: k2.api_key, body: { amount: '3.00' }, headers });
  assert.notEqual(a.body.id, b.body.id);
});

test('a merchant cannot read another merchant\'s invoices or payments, and lists show only their own', async () => {
  const alice = await makeUser();
  const bob = await makeUser({ earned: 99 });
  const ka = await makeKey(alice);
  const kb = await makeKey(bob);
  const { call } = await start();
  const inv = await call('POST', '/v1/invoices', { key: ka.api_key, body: { amount: '4.00' } });
  for (const p of [`/v1/invoices/${inv.body.id}`, `/v1/invoices/${inv.body.id}/status`, `/v1/payments/${inv.body.id}`]) {
    assert.equal((await call('GET', p, { key: kb.api_key })).status, 404, p);
    assert.equal((await call('GET', p, { key: ka.api_key })).status, 200, p);
  }
  const bobList = await call('GET', '/v1/payments', { key: kb.api_key });
  assert.ok(bobList.body.data.every((r) => r.id !== inv.body.id));
  const aliceList = await call('GET', '/v1/payments', { key: ka.api_key });
  assert.deepEqual(aliceList.body.data.map((r) => r.id), [inv.body.id]);
  assert.equal((await call('GET', '/v1/balance', { key: ka.api_key })).body.available, 0);
});

test('payment list is paginated and filtered, and bad paging is 400', async () => {
  const user = await makeUser();
  const k = await makeKey(user);
  const { call } = await start();
  for (let i = 0; i < 3; i++) await call('POST', '/v1/invoices', { key: k.api_key, body: { amount: '2.00' } });
  const page = await call('GET', '/v1/payments?limit=2&offset=0', { key: k.api_key });
  assert.equal(page.body.total, 3);
  assert.equal(page.body.data.length, 2);
  assert.equal((await call('GET', '/v1/payments?limit=2&offset=2', { key: k.api_key })).body.data.length, 1);
  assert.equal((await call('GET', '/v1/payments?status=settled', { key: k.api_key })).body.total, 0);
  for (const bad of ['limit=0', 'limit=101', 'offset=-1', 'limit=x', 'status=bogus']) {
    assert.equal((await call('GET', `/v1/payments?${bad}`, { key: k.api_key })).status, 400, bad);
  }
});

test('requests over the rate limit are 429', async () => {
  const user = await makeUser();
  const k = await makeKey(user);
  const { call } = await start();
  await db.query(`insert into merchant_api_rate_limits(key_id, request_count) values ($1, 60)
    on conflict (key_id) do update set request_count = 60, window_started_at = now()`, [k.id]);
  const r = await call('GET', '/v1/balance', { key: k.api_key });
  assert.equal(r.status, 429);
});

test('unknown routes and malformed ids are 404', async () => {
  const user = await makeUser();
  const k = await makeKey(user);
  const { call } = await start();
  assert.equal((await call('GET', '/v1/nope', { key: k.api_key })).status, 404);
  assert.equal((await call('GET', '/v1/invoices/not-a-uuid', { key: k.api_key })).status, 404);
  assert.equal((await call('DELETE', '/v1/invoices', { key: k.api_key })).status, 404);
});
