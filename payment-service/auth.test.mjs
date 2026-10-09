import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequestAuth, createAdminTokenVerifier, resolveAdmin, signRequest, SIGNATURE_WINDOW_MS } from './auth.mjs';

const SECRET = 'unit-secret-'.padEnd(48, 'z');
const nonce = () => randomBytes(16).toString('hex');
function signed({ secret = SECRET, ts = Date.now(), n = nonce(), method = 'POST', path = '/admin/wallet/send-confirm', body = '{"prepareId":"x"}' } = {}) {
  return { headers: { 'x-cpay-timestamp': String(ts), 'x-cpay-nonce': n, 'x-cpay-signature': signRequest({ secret, ts: String(ts), nonce: n, method, path, body: Buffer.from(body) }) }, method, path, body: Buffer.from(body) };
}

test('signed request: accepted once, replay of the same nonce refused', () => {
  const auth = createRequestAuth({ secret: SECRET, mode: 'signed' });
  const r = signed();
  assert.deepEqual(auth.check(r.headers, r.method, r.path, r.body), { ok: true, kind: 'signed' });
  assert.equal(auth.check(r.headers, r.method, r.path, r.body).reason, 'replayed-nonce');
});

test('signed request: tampered body, path, method, wrong secret, stale or future timestamp are refused', () => {
  const auth = createRequestAuth({ secret: SECRET, mode: 'any' });
  const r = signed();
  assert.equal(auth.check(r.headers, r.method, r.path, Buffer.from('{"prepareId":"y"}')).reason, 'bad-signature');
  assert.equal(auth.check(r.headers, r.method, '/admin/wallet/stable-confirm', r.body).reason, 'bad-signature');
  assert.equal(auth.check(r.headers, 'GET', r.path, r.body).reason, 'bad-signature');
  const w = signed({ secret: 'other-'.padEnd(48, 'q') });
  assert.equal(auth.check(w.headers, w.method, w.path, w.body).reason, 'bad-signature');
  const old = signed({ ts: Date.now() - SIGNATURE_WINDOW_MS - 1000 });
  assert.equal(auth.check(old.headers, old.method, old.path, old.body).reason, 'stale-signature');
  const fut = signed({ ts: Date.now() + SIGNATURE_WINDOW_MS + 1000 });
  assert.equal(auth.check(fut.headers, fut.method, fut.path, fut.body).reason, 'stale-signature');
  for (const h of [{ 'x-cpay-nonce': 'short' }, { 'x-cpay-timestamp': 'abc' }, { 'x-cpay-signature': 'v2=00' }]) {
    const m = signed();
    assert.equal(auth.check({ ...m.headers, ...h }, m.method, m.path, m.body).reason, 'malformed-signature');
  }
});

test('a bad signature is not rescued by a valid bearer', () => {
  const auth = createRequestAuth({ secret: SECRET, mode: 'any' });
  const r = signed();
  const headers = { ...r.headers, 'x-cpay-signature': 'v1=' + '0'.repeat(64), authorization: `Bearer ${SECRET}` };
  assert.equal(auth.check(headers, r.method, r.path, r.body).ok, false);
});

test('bearer: accepted in any mode, refused in signed mode', () => {
  const any = createRequestAuth({ secret: SECRET, mode: 'any' });
  const strict = createRequestAuth({ secret: SECRET, mode: 'signed' });
  assert.deepEqual(any.check({ authorization: `Bearer ${SECRET}` }, 'GET', '/metrics', Buffer.alloc(0)), { ok: true, kind: 'bearer' });
  assert.equal(any.check({ authorization: `Bearer ${SECRET}x` }, 'GET', '/metrics', Buffer.alloc(0)).ok, false);
  assert.equal(strict.check({ authorization: `Bearer ${SECRET}` }, 'GET', '/metrics', Buffer.alloc(0)).reason, 'signature-required');
  assert.throws(() => createRequestAuth({ secret: SECRET, mode: 'off' }));
});

test('nonce store is bounded and fails closed when full', () => {
  let t = Date.now();
  const auth = createRequestAuth({ secret: SECRET, mode: 'signed', now: () => t, maxNonces: 3 });
  for (let i = 0; i < 3; i++) { const r = signed({ ts: t }); assert.equal(auth.check(r.headers, r.method, r.path, r.body).ok, true); }
  const r = signed({ ts: t });
  assert.equal(auth.check(r.headers, r.method, r.path, r.body).reason, 'nonce-store-full');
  t += SIGNATURE_WINDOW_MS + 5_000; // old nonces expire and are pruned
  const later = signed({ ts: t });
  assert.equal(auth.check(later.headers, later.method, later.path, later.body).ok, true);
});

test('admin token verifier asks Supabase Auth and fails closed', async () => {
  const id = randomUUID();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (init.headers.authorization === 'Bearer good.token.value-123456') return new Response(JSON.stringify({ id }), { status: 200 });
    if (init.headers.authorization === 'Bearer throws.token.value-123456') throw new Error('network');
    return new Response('{"msg":"bad jwt"}', { status: 401 });
  };
  const verify = createAdminTokenVerifier({ supabaseUrl: 'https://example.supabase.co/', anonKey: 'anon-key', fetchImpl });
  assert.equal(await verify('good.token.value-123456'), id);
  assert.equal(calls[0].url, 'https://example.supabase.co/auth/v1/user');
  assert.equal(calls[0].init.headers.apikey, 'anon-key');
  assert.equal(await verify('bad.token.value-1234567'), null);
  assert.equal(await verify('throws.token.value-123456'), null);
  assert.equal(await verify('short'), null);
  assert.equal(await verify('has spaces in it but is long enough'), null);
  assert.equal(await verify(undefined), null);
});

test('resolveAdmin: token wins over body, mismatch and missing token refused when required', async () => {
  const admin = randomUUID();
  const other = randomUUID();
  const verifyToken = async (t) => (t === 'tok-admin' ? admin : null);
  assert.deepEqual(await resolveAdmin({ mode: 'required', verifyToken, token: 'tok-admin', bodyAdminId: undefined }), { adminId: admin, via: 'token' });
  assert.equal((await resolveAdmin({ mode: 'optional', verifyToken, token: 'tok-admin', bodyAdminId: other })).refused[0], 403);
  assert.equal((await resolveAdmin({ mode: 'optional', verifyToken, token: 'tok-forged', bodyAdminId: admin })).refused[0], 401);
  assert.equal((await resolveAdmin({ mode: 'required', verifyToken, token: undefined, bodyAdminId: admin })).refused[0], 401);
  assert.equal((await resolveAdmin({ mode: 'required', verifyToken: null, token: 'tok-admin', bodyAdminId: admin })).refused[0], 401);
  assert.deepEqual(await resolveAdmin({ mode: 'optional', verifyToken, token: undefined, bodyAdminId: other }), { adminId: other, via: 'legacy' });
});

test('signature vector shared with supabase/functions/_shared/service-auth_test.ts', () => {
  const v = signRequest({ secret: 'edge-secret-'.padEnd(48, 'e'), ts: '1760000000000', nonce: '0123456789abcdef0123', method: 'post', path: '/admin/wallet/send-confirm', body: Buffer.from('{"prepareId":"abc"}') });
  assert.equal(v, 'v1=c3589e353172c81e87fd2ee4a80065ee77e19b3e8ea3315b3f8c932872db56d8');
});
