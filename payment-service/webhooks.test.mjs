import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  createWebhookDispatcher, createReplayGuard, verifySignature, signatureHeader, backoffSeconds,
  MAX_ATTEMPTS, isPrivateAddress,
} from './webhooks.mjs';

// Real database with every migration applied; a fake endpoint stands in for the merchant's server.
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const users = [];
const URL_OK = 'https://hooks.example.test/cpay';
const ALL = ['payment.created', 'payment.pending', 'payment.succeeded', 'payment.failed', 'payment.expired'];

after(async () => {
  if (users.length) {
    await db.query(`delete from audit_log where actor_id = any($1::uuid[]) and set_config('cpay.audit_maintenance', 'on', true) = 'on'`, [users]);
    await db.query('delete from payments where user_id = any($1::uuid[])', [users]);
    await db.query('delete from auth.users where id = any($1::uuid[])', [users]);
  }
  await db.end();
});

async function makeUser(role = 'creator') {
  const id = randomUUID();
  users.push(id);
  await db.query(`insert into auth.users(id, email) values ($1, $2)`, [id, `wh-${id}@test.invalid`]);
  await db.query(`update profiles set role = $2, account_status = 'active' where id = $1`, [id, role]);
  return id;
}

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

const endpoint = (user, events = ALL, url = URL_OK) =>
  asUser(user, async (c) => (await c.query('select * from merchant_create_webhook_endpoint($1, $2)', [url, events])).rows[0]);

async function newPayment(user, amount = 5) {
  return (await db.query(
    `insert into payments(user_id, amount_requested, status, expires_at) values ($1, $2, 'new', now() + interval '1 hour') returning id`,
    [user, amount])).rows[0].id;
}
const attach = (id) => db.query(`update payments set lightning_invoice = 'lnbcrt1x', invoice_ref = $2, amount_sat = 5000 where id = $1`, [id, randomUUID().replace(/-/g, '').padEnd(64, '0')]);
const setStatus = (id, status) => db.query(`update payments set status = $2, amount_settled = case when $2 = 'settled' then amount_requested else null end, settled_at = case when $2 = 'settled' then now() else null end where id = $1`, [id, status]);
const events = async (paymentId) => (await db.query('select type from merchant_webhook_events where payment_id = $1 order by created_at, type', [paymentId])).rows.map((r) => r.type);
const makeDelivery = async (user) => {
  // Other tests leave deliveries pending; park them so this test's pass sees only its own.
  await db.query(`update merchant_webhook_deliveries set next_attempt_at = now() + interval '1 day' where status = 'pending'`);
  const ep = await endpoint(user);
  const pay = await newPayment(user);
  await attach(pay);
  return { ep, pay };
};
const dueNow = (endpointId) => db.query(`update merchant_webhook_deliveries set next_attempt_at = now() - interval '1 second' where endpoint_id = $1 and status = 'pending'`, [endpointId]);

function fakeEndpoint(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return respond(calls.length, url, init); };
  return { calls, fetchImpl };
}
const ok = () => ({ status: 200 });
const publicResolve = async () => ['93.184.216.34'];
const dispatcher = (fetchImpl, extra = {}) => createWebhookDispatcher({ db, fetchImpl, resolve: publicResolve, ...extra });

test('endpoint management: secret shown once, private to the owner, https only, known events only', async () => {
  const alice = await makeUser();
  const bob = await makeUser();
  const ep = await endpoint(alice);
  assert.match(ep.secret, /^whsec_[0-9a-f]{64}$/);
  const list = await asUser(alice, async (c) => (await c.query('select * from merchant_list_webhook_endpoints()')).rows);
  assert.equal(list.length, 1);
  assert.ok(!('secret' in list[0]));
  assert.deepEqual(await asUser(bob, async (c) => (await c.query('select * from merchant_list_webhook_endpoints()')).rows), []);
  await assert.rejects(endpoint(alice, ALL, 'http://hooks.example.test/x'), /violates check constraint/);
  await assert.rejects(endpoint(alice, ['payment.bogus']), /violates check constraint/);
  await assert.rejects(db.query('select * from merchant_webhook_endpoints'.concat(' limit 1')).then(() => asUser(bob, (c) => c.query('select secret from merchant_webhook_endpoints'))), /permission denied/);
  assert.equal(await asUser(bob, async (c) => (await c.query('select merchant_delete_webhook_endpoint($1) as ok', [ep.id])).rows[0].ok), false);
  const rotated = await asUser(alice, async (c) => (await c.query('select merchant_rotate_webhook_secret($1) as s', [ep.id])).rows[0].s);
  assert.notEqual(rotated, ep.secret);
  const admin = await makeUser('admin');
  await assert.rejects(endpoint(admin), /Only active merchant accounts/);
});

test('payment state changes enqueue one event each, with ids, and none without a subscribed endpoint', async () => {
  const quiet = await makeUser();
  const q1 = await newPayment(quiet); await attach(q1); await setStatus(q1, 'settled');
  assert.deepEqual(await events(q1), []);

  const user = await makeUser();
  await endpoint(user);
  const p = await newPayment(user);
  assert.deepEqual(await events(p), []);
  await attach(p);
  await setStatus(p, 'pending');
  await setStatus(p, 'settled');
  assert.deepEqual(await events(p), ['payment.created', 'payment.pending', 'payment.succeeded']);
  await setStatus(p, 'settled');
  assert.equal((await events(p)).length, 3, 'a no-op update emits nothing');
  const e = await newPayment(user); await attach(e); await setStatus(e, 'expired');
  const f = await newPayment(user); await attach(f); await setStatus(f, 'invalid');
  assert.ok((await events(e)).includes('payment.expired'));
  assert.ok((await events(f)).includes('payment.failed'));
  const ids = (await db.query('select id from merchant_webhook_events where payment_id = $1', [p])).rows.map((r) => r.id);
  assert.equal(new Set(ids).size, 3);
});

test('an endpoint only receives the event types it subscribed to', async () => {
  const user = await makeUser();
  const ep = await endpoint(user, ['payment.succeeded']);
  const p = await newPayment(user); await attach(p); await setStatus(p, 'settled');
  const rows = (await db.query('select ev.type from merchant_webhook_deliveries d join merchant_webhook_events ev on ev.id = d.event_id where d.endpoint_id = $1', [ep.id])).rows;
  assert.deepEqual(rows.map((r) => r.type), ['payment.succeeded']);
});

test('successful delivery: signed, timestamped, with the event id, and recorded in the log', async () => {
  const user = await makeUser();
  const { ep, pay } = await makeDelivery(user);
  const end = fakeEndpoint(ok);
  await dispatcher(end.fetchImpl).deliverDue();
  assert.equal(end.calls.length, 1);
  const { init } = end.calls[0];
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'manual');
  const h = init.headers;
  assert.ok(verifySignature(ep.secret, h['cpay-signature'], init.body), 'valid signature');
  assert.equal(h['cpay-timestamp'], h['cpay-signature'].match(/t=(\d+)/)[1]);
  const body = JSON.parse(init.body);
  assert.equal(body.id, h['cpay-event-id']);
  assert.equal(body.type, 'payment.created');
  assert.equal(body.data.payment.id, pay);
  const log = await asUser(user, async (c) => (await c.query('select * from merchant_list_webhook_deliveries($1)', [ep.id])).rows);
  assert.equal(log[0].status, 'succeeded');
  assert.equal(log[0].attempts, 1);
  assert.equal(log[0].last_status_code, 200);
  assert.equal(Number(log[0].total_count), 1);
  const bobLog = await asUser(await makeUser(), async (c) => (await c.query('select * from merchant_list_webhook_deliveries($1)', [ep.id])).rows);
  assert.deepEqual(bobLog, []);
});

test('invalid signatures are rejected: wrong secret, altered body, malformed header, stale timestamp', () => {
  const secret = 'whsec_test';
  const body = '{"id":"e1"}';
  const t = Math.floor(Date.now() / 1000);
  const header = signatureHeader(secret, t, body);
  assert.equal(verifySignature(secret, header, body), true);
  assert.equal(verifySignature('whsec_other', header, body), false);
  assert.equal(verifySignature(secret, header, body + ' '), false);
  assert.equal(verifySignature(secret, 'garbage', body), false);
  assert.equal(verifySignature(secret, '', body), false);
  assert.equal(verifySignature(secret, `t=${t},v1=${'0'.repeat(64)}`, body), false);
});

test('replayed events are refused: a captured request is stale later, and an event id is accepted once', () => {
  const secret = 'whsec_test';
  const body = '{"id":"e1"}';
  const t = Math.floor(Date.now() / 1000);
  const header = signatureHeader(secret, t, body);
  const later = () => (t + 301) * 1000;
  assert.equal(verifySignature(secret, header, body, { now: later }), false);
  assert.equal(verifySignature(secret, header, body, { now: () => (t + 299) * 1000 }), true);
  const fresh = createReplayGuard();
  assert.equal(fresh('e1'), true);
  assert.equal(fresh('e1'), false);
});

test('duplicate delivery: concurrent workers send each event once, and a delivered event is never resent', async () => {
  const user = await makeUser();
  const { ep } = await makeDelivery(user);
  const end = fakeEndpoint(async () => { await new Promise((r) => setTimeout(r, 30)); return ok(); });
  const a = dispatcher(end.fetchImpl);
  const b = dispatcher(end.fetchImpl);
  await Promise.all([a.deliverDue(), b.deliverDue(), a.deliverDue()]);
  assert.equal(end.calls.length, 1);
  await dueNow(ep.id);
  await a.deliverDue();
  assert.equal(end.calls.length, 1);
  const dup = await db.query('select count(*)::int as n from merchant_webhook_events where user_id = $1', [user]);
  assert.equal(dup.rows[0].n, 1);
});

test('failed endpoint: retried with exponential backoff, each attempt logged, then marked failed', async () => {
  const user = await makeUser();
  const { ep } = await makeDelivery(user);
  const end = fakeEndpoint(() => ({ status: 500 }));
  const d = dispatcher(end.fetchImpl);
  const row = async () => (await db.query('select status, attempts, extract(epoch from next_attempt_at - now())::int as wait, last_error from merchant_webhook_deliveries where endpoint_id = $1', [ep.id])).rows[0];
  await d.deliverDue();
  let r = await row();
  assert.equal(r.status, 'pending');
  assert.equal(r.attempts, 1);
  assert.ok(Math.abs(r.wait - backoffSeconds(1)) <= 2, `first wait ${r.wait}`);
  assert.equal(r.last_error, 'endpoint answered 500');
  await d.deliverDue();
  assert.equal(end.calls.length, 1, 'not retried before it is due');
  await dueNow(ep.id); await d.deliverDue();
  r = await row();
  assert.equal(r.attempts, 2);
  assert.ok(Math.abs(r.wait - backoffSeconds(2)) <= 2);
  for (let i = 2; i < MAX_ATTEMPTS; i++) { await dueNow(ep.id); await d.deliverDue(); }
  r = await row();
  assert.equal(r.status, 'failed');
  assert.equal(r.attempts, MAX_ATTEMPTS);
  const attempts = await db.query('select count(*)::int as n from merchant_webhook_attempts a join merchant_webhook_deliveries d on d.id = a.delivery_id where d.endpoint_id = $1', [ep.id]);
  assert.equal(attempts.rows[0].n, MAX_ATTEMPTS);
  await dueNow(ep.id); await d.deliverDue();
  assert.equal(end.calls.length, MAX_ATTEMPTS, 'no sends after the final failure');
});

test('retry: a failure followed by success delivers the same event id with a fresh signature', async () => {
  const user = await makeUser();
  const { ep } = await makeDelivery(user);
  const end = fakeEndpoint((n) => { if (n === 1) throw new Error('connect ECONNREFUSED'); return ok(); });
  const d = dispatcher(end.fetchImpl);
  await d.deliverDue();
  const mid = (await db.query('select status, last_error from merchant_webhook_deliveries where endpoint_id = $1', [ep.id])).rows[0];
  assert.equal(mid.status, 'pending');
  assert.match(mid.last_error, /ECONNREFUSED/);
  await dueNow(ep.id); await d.deliverDue();
  assert.equal(end.calls.length, 2);
  assert.equal(end.calls[0].init.headers['cpay-event-id'], end.calls[1].init.headers['cpay-event-id']);
  for (const c of end.calls) assert.ok(verifySignature(ep.secret, c.init.headers['cpay-signature'], c.init.body));
  assert.equal((await db.query('select status from merchant_webhook_deliveries where endpoint_id = $1', [ep.id])).rows[0].status, 'succeeded');
});

test('a rotated secret signs later attempts; redirects count as failures', async () => {
  const user = await makeUser();
  const { ep } = await makeDelivery(user);
  const end = fakeEndpoint((n) => (n === 1 ? { status: 302 } : ok()));
  const d = dispatcher(end.fetchImpl);
  await d.deliverDue();
  const next = await asUser(user, async (c) => (await c.query('select merchant_rotate_webhook_secret($1) as s', [ep.id])).rows[0].s);
  await dueNow(ep.id); await d.deliverDue();
  const last = end.calls[1].init;
  assert.ok(verifySignature(next, last.headers['cpay-signature'], last.body));
  assert.equal(verifySignature(ep.secret, last.headers['cpay-signature'], last.body), false);
});

test('endpoints that resolve to private addresses are never contacted', async () => {
  const user = await makeUser();
  const { ep } = await makeDelivery(user);
  const end = fakeEndpoint(ok);
  await createWebhookDispatcher({ db, fetchImpl: end.fetchImpl, resolve: async () => ['10.0.0.5'] }).deliverDue();
  assert.equal(end.calls.length, 0);
  const r = (await db.query('select attempts, last_error from merchant_webhook_deliveries where endpoint_id = $1', [ep.id])).rows[0];
  assert.equal(r.attempts, 1);
  assert.match(r.last_error, /non-public/);
  for (const ip of ['127.0.0.1', '169.254.169.254', '192.168.1.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert.equal(isPrivateAddress(ip), true, ip);
  assert.equal(isPrivateAddress('93.184.216.34'), false);
});

test('an endpoint failing too many times in a row is disabled and its queue closed out; disabled endpoints get nothing', async () => {
  const user = await makeUser();
  const ep = await endpoint(user, ['payment.created']);
  await db.query('update merchant_webhook_endpoints set consecutive_failures = 29 where id = $1', [ep.id]);
  const p = await newPayment(user); await attach(p);
  const end = fakeEndpoint(() => ({ status: 503 }));
  await dispatcher(end.fetchImpl).deliverDue();
  const e = (await db.query('select is_active, disabled_reason from merchant_webhook_endpoints where id = $1', [ep.id])).rows[0];
  assert.equal(e.is_active, false);
  assert.match(e.disabled_reason, /consecutive/);
  const p2 = await newPayment(user); await attach(p2);
  assert.deepEqual(await events(p2), []);
});

test('the service delivers over the real payment state machine: settle_breez_payment emits payment.succeeded', async () => {
  const user = await makeUser();
  await endpoint(user, ['payment.succeeded']);
  const p = await newPayment(user, 10);
  const hash = 'ab'.repeat(32);
  await db.query(`update payments set lightning_invoice = 'lnbcrt1y', invoice_ref = $2, amount_sat = 10000 where id = $1`, [p, hash]);
  const { rows } = await db.query(`select settle_breez_payment($1, $2, 10000) as outcome`, [`brz-${randomUUID()}`, hash]);
  assert.equal(rows[0].outcome, 'settled');
  assert.deepEqual(await events(p), ['payment.succeeded']);
});
