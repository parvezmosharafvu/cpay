import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { TRON, fakeBreez } from './fake-breez.mjs';
import { createService } from './service.mjs';
import { signRequest } from './auth.mjs';

// Caller authentication over real HTTP (fake SDK, migrated database):
// signed requests with replay protection, and wallet routes that act as the
// admin named by a verified Supabase session, not by the body.
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const SECRET = 'auth-test-secret-'.padEnd(48, 'y');
const MNEMONIC = Array(12).fill('abandon').join(' ');
const users = [];
const running = [];

after(async () => {
  for (const s of running) await s.stop('test-end');
  if (users.length) {
    await db.query(`delete from audit_log where actor_id = any($1::uuid[]) and set_config('cpay.audit_maintenance', 'on', true) = 'on'`, [users]);
    await db.query('delete from auth.users where id = any($1::uuid[])', [users]);
  }
  await db.end();
});

async function makeUser(role = 'creator', status = 'active') {
  const id = randomUUID();
  users.push(id);
  await db.query(`insert into auth.users(id, email) values ($1, $2)`, [id, `auth-${id}@test.invalid`]);
  await db.query(`update profiles set role = $2, account_status = $3 where id = $1`, [id, role, status]);
  return id;
}

// Fake Supabase Auth: token "tok:<uuid>" belongs to <uuid>; anything else is invalid.
const verifyAdminToken = async (t) => (typeof t === 'string' && t.startsWith('tok:') ? t.slice(4) : null);

async function start(overrides = {}) {
  const fake = fakeBreez();
  const logs = [];
  const config = {
    network: 'regtest', apiKey: '', mnemonic: MNEMONIC, dataDir: '/nonexistent', databaseUrl: process.env.DATABASE_URL,
    secret: SECRET, port: 0, catchUpMs: 3_600_000, shutdownTimeoutMs: 5_000,
    requestAuthMode: 'signed', adminJwtMode: 'required', verifyAdminToken, ...overrides,
  };
  const breez = { defaultConfig: (network) => ({ network }), connect: async () => fake };
  const service = createService({ config, breez, log: (e) => logs.push(e) });
  running.push(service);
  const port = await service.started;
  // raw: send exactly these headers/body (for replays).
  const raw = (path, { method = 'POST', headers = {}, body = '' } = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: method === 'GET' ? undefined : body })
      .then(async (r) => ({ status: r.status, body: await r.json() }));
  const signHeaders = (method, path, body, { secret = SECRET, ts = Date.now() } = {}) => {
    const nonce = randomBytes(16).toString('hex');
    return { 'x-cpay-timestamp': String(ts), 'x-cpay-nonce': nonce, 'x-cpay-signature': signRequest({ secret, ts: String(ts), nonce, method, path, body: Buffer.from(body) }) };
  };
  const call = (path, { body, method = body === undefined ? 'GET' : 'POST', token, extra = {} } = {}) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const headers = { ...signHeaders(method, path, text), ...(token ? { 'x-cpay-admin-token': token } : {}), ...extra };
    return raw(path, { method, headers, body: text }).then((r) => ({ ...r, headers, text }));
  };
  return { fake, logs, raw, call, signHeaders, service };
}

test('signed mode: the static bearer alone is refused, a signed call works', async () => {
  const { raw, call, fake } = await start();
  const before = { ...fake.calls };
  for (const path of ['/metrics', '/withdraw/routes']) {
    assert.equal((await raw(path, { method: 'GET', headers: { authorization: `Bearer ${SECRET}` } })).status, 401, path);
  }
  assert.equal((await raw('/invoices', { headers: { authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ paymentId: randomUUID() }) })).status, 401);
  assert.deepEqual(fake.calls, before);
  const m = await call('/metrics');
  assert.equal(m.status, 200);
  assert.equal(m.body.requestAuthMode, 'signed');
  assert.equal(m.body.adminJwtMode, 'required');
  assert.equal((await call('/invoices', { body: { paymentId: randomUUID() } })).status, 404);
});

test('a replayed signed request is refused, and so is a tampered body or a wrong key', async () => {
  const { raw, call, signHeaders } = await start();
  const first = await call('/invoices', { body: { paymentId: randomUUID() } });
  assert.equal(first.status, 404);
  const replay = await raw('/invoices', { headers: first.headers, body: first.text });
  assert.equal(replay.status, 401);
  const h = signHeaders('POST', '/invoices', JSON.stringify({ paymentId: randomUUID() }));
  assert.equal((await raw('/invoices', { headers: h, body: JSON.stringify({ paymentId: randomUUID() }) })).status, 401);
  const wrong = signHeaders('POST', '/invoices', '{}', { secret: 'wrong-secret-'.padEnd(48, 'w') });
  assert.equal((await raw('/invoices', { headers: wrong, body: '{}' })).status, 401);
  const stale = signHeaders('GET', '/metrics', '', { ts: Date.now() - 10 * 60 * 1000 });
  assert.equal((await raw('/metrics', { method: 'GET', headers: stale })).status, 401);
});

test('wallet routes: no admin session, a forged adminId or a non-admin session cannot reach the wallet', async () => {
  const admin = await makeUser('admin');
  const creator = await makeUser('creator');
  const suspended = await makeUser('admin', 'suspended');
  const { call, fake, logs } = await start();
  const before = { ...fake.calls };
  const body = { adminId: admin, routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '20' };
  // Valid service signature + a real admin's id in the body, but no session.
  assert.equal((await call('/admin/wallet/stable-quote', { body })).status, 401);
  assert.equal((await call('/admin/wallet/send-prepare', { body: { adminId: admin, destination: 'lnbcrt1x', amountSat: 1000 } })).status, 401);
  assert.equal((await call('/admin/wallet/send-confirm', { body: { adminId: admin, prepareId: randomUUID() } })).status, 401);
  // A session that does not verify.
  assert.equal((await call('/admin/wallet/info', { body: { adminId: admin }, token: 'forged.jwt.value' })).status, 401);
  // A creator's real session with the admin's id in the body.
  assert.equal((await call('/admin/wallet/stable-quote', { body, token: `tok:${creator}` })).status, 403);
  // A creator's session on its own: not an admin.
  assert.equal((await call('/admin/wallet/info', { body: {}, token: `tok:${creator}` })).status, 403);
  // A suspended admin's session.
  assert.equal((await call('/admin/wallet/info', { body: {}, token: `tok:${suspended}` })).status, 403);
  assert.deepEqual(fake.calls, before);
  assert.ok(logs.some((e) => e.event === 'admin-auth-refused' && e.reason === 'missing-admin-token'));
  assert.ok(logs.some((e) => e.event === 'admin-auth-refused' && e.reason === 'admin-id-mismatch'));
});

test('wallet routes: an active admin session works, and one admin cannot confirm another admin\'s quote', async () => {
  const a = await makeUser('admin');
  const b = await makeUser('admin');
  const { call, fake } = await start();
  const info = await call('/admin/wallet/info', { body: {}, token: `tok:${a}` });
  assert.equal(info.status, 200, JSON.stringify(info.body));
  const q = await call('/admin/wallet/stable-quote', { body: { routeId: 'orchestra:tron:usdt', address: TRON, amountUsd: '20' }, token: `tok:${a}` });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  const quoteId = q.body.quoteId ?? q.body.prepareId;
  // b's session, body claims a: refused before anything else.
  assert.equal((await call('/admin/wallet/stable-confirm', { body: { adminId: a, quoteId }, token: `tok:${b}` })).status, 403);
  // b's session on its own: the quote is a's, so nothing to confirm.
  assert.equal((await call('/admin/wallet/stable-confirm', { body: { quoteId }, token: `tok:${b}` })).status, 404);
  assert.equal(fake.calls.send, 0);
  const audit = await db.query(`select count(*)::int as n from audit_log where actor_id = $1`, [b]);
  assert.equal(audit.rows[0].n, 0);
});

test('rollout defaults: bearer and body adminId still work, but a supplied session is verified', async () => {
  const admin = await makeUser('admin');
  const creator = await makeUser('creator');
  const { raw } = await start({ requestAuthMode: undefined, adminJwtMode: undefined });
  const bearer = { authorization: `Bearer ${SECRET}` };
  assert.equal((await raw('/admin/wallet/info', { headers: bearer, body: JSON.stringify({ adminId: admin }) })).status, 200);
  assert.equal((await raw('/admin/wallet/info', { headers: { ...bearer, 'x-cpay-admin-token': `tok:${creator}` }, body: JSON.stringify({ adminId: admin }) })).status, 403);
  assert.equal((await raw('/admin/wallet/info', { headers: { ...bearer, 'x-cpay-admin-token': 'nope' }, body: JSON.stringify({ adminId: admin }) })).status, 401);
  assert.equal((await raw('/admin/wallet/info', { headers: { ...bearer, 'x-cpay-admin-token': `tok:${admin}` }, body: '{}' })).status, 200);
});
