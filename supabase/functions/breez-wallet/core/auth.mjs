// How callers prove who they are.
//
// 1. Service requests (every route except /health and /ready) come from the
//    Supabase Edge Functions. Two forms are accepted, chosen by
//    REQUEST_AUTH_MODE:
//      any    (rollout default) — the legacy static bearer OR a signed request
//      signed (target)          — a signed request only
//    A signed request carries
//      x-cpay-timestamp  milliseconds since the epoch
//      x-cpay-nonce      16-128 chars [A-Za-z0-9_-], single use
//      x-cpay-signature  v1=<hex HMAC-SHA256(secret, canonical)>
//    where canonical = "cpay-v1\n<ts>\n<nonce>\n<METHOD>\n<path+query>\n<sha256 hex of body>".
//    The secret never travels, the body and path cannot be changed, and a
//    captured request is refused outside a ±5 minute window or a second
//    time inside it (nonces are remembered for the window; one instance).
//
// 2. Platform wallet routes (/admin/wallet/*) additionally carry the admin's
//    own Supabase access token in x-cpay-admin-token. The service asks
//    Supabase Auth who the token belongs to (signature, expiry and user are
//    checked there) and uses THAT id; an adminId in the body that differs is
//    refused. ADMIN_JWT_MODE:
//      optional (rollout default) — verify the token when present, otherwise
//                                   fall back to the body adminId
//      required (target)          — no valid token, no wallet access
//    So the shared secret alone can no longer move platform money.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;
export const MAX_NONCES = 100_000;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const TS = /^\d{12,14}$/;
const SIG = /^v1=([0-9a-f]{64})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const REQUEST_AUTH_MODES = new Set(['any', 'signed']);
export const ADMIN_JWT_MODES = new Set(['optional', 'required']);

export const sha256Hex = (buf) => createHash('sha256').update(buf ?? '').digest('hex');

export function canonicalRequest({ ts, nonce, method, path, body }) {
  return `cpay-v1\n${ts}\n${nonce}\n${String(method).toUpperCase()}\n${path}\n${sha256Hex(body ?? '')}`;
}

export function signRequest({ secret, ts, nonce, method, path, body }) {
  return `v1=${createHmac('sha256', secret).update(canonicalRequest({ ts, nonce, method, path, body })).digest('hex')}`;
}

const same = (a, b) => {
  const x = createHash('sha256').update(a ?? '').digest();
  const y = createHash('sha256').update(b ?? '').digest();
  return timingSafeEqual(x, y);
};

// Returns check(headers, method, path, rawBody) -> { ok, kind?, reason? }.
// rawBody is a Buffer (empty for none). Signature headers, when present, are
// the only thing evaluated: a bad signature is never rescued by a bearer.
export function createRequestAuth({ secret, mode = 'any', now = () => Date.now(), windowMs = SIGNATURE_WINDOW_MS, maxNonces = MAX_NONCES }) {
  if (!REQUEST_AUTH_MODES.has(mode)) throw new Error('unknown request auth mode');
  const bearer = `Bearer ${secret}`;
  const seen = new Map(); // nonce -> expiry ms

  function prune(t) {
    if (seen.size < 1000 && seen.size < maxNonces) return;
    for (const [n, exp] of seen) if (exp <= t) seen.delete(n);
  }

  function hasSignature(headers) {
    return headers['x-cpay-signature'] !== undefined || headers['x-cpay-timestamp'] !== undefined || headers['x-cpay-nonce'] !== undefined;
  }

  function check(headers, method, path, rawBody) {
    if (hasSignature(headers)) {
      const ts = String(headers['x-cpay-timestamp'] ?? '');
      const nonce = String(headers['x-cpay-nonce'] ?? '');
      const sig = SIG.exec(String(headers['x-cpay-signature'] ?? ''));
      if (!TS.test(ts) || !NONCE.test(nonce) || !sig) return { ok: false, reason: 'malformed-signature' };
      const t = now();
      if (Math.abs(t - Number(ts)) > windowMs) return { ok: false, reason: 'stale-signature' };
      const expected = signRequest({ secret, ts, nonce, method, path, body: rawBody });
      if (!same(expected, `v1=${sig[1]}`)) return { ok: false, reason: 'bad-signature' };
      prune(t);
      if (seen.has(nonce) && seen.get(nonce) > t) return { ok: false, reason: 'replayed-nonce' };
      if (seen.size >= maxNonces) return { ok: false, reason: 'nonce-store-full' };
      seen.set(nonce, Number(ts) + windowMs + 1);
      return { ok: true, kind: 'signed' };
    }
    if (mode === 'signed') return { ok: false, reason: 'signature-required' };
    const header = headers.authorization;
    if (typeof header === 'string' && same(header, bearer)) return { ok: true, kind: 'bearer' };
    return { ok: false, reason: 'bad-bearer' };
  }

  return { check, mode, nonceCount: () => seen.size };
}

// Supabase Auth lookup: GET /auth/v1/user with the caller's access token.
// Returns the user id, or null for any failure (fails closed).
export function createAdminTokenVerifier({ supabaseUrl, anonKey, fetchImpl = fetch, timeoutMs = 5_000 }) {
  const base = String(supabaseUrl).replace(/\/+$/, '');
  return async function verify(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 8192 || !/^[A-Za-z0-9._-]+$/.test(token)) return null;
    try {
      const res = await fetchImpl(`${base}/auth/v1/user`, {
        headers: { apikey: anonKey, authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status !== 200) return null;
      const user = await res.json().catch(() => null);
      return user && UUID.test(String(user.id)) ? String(user.id).toLowerCase() : null;
    } catch {
      return null;
    }
  };
}

// Decides the admin id a wallet call runs as. Returns [status, error] on refusal
// or { adminId } on success. verifyToken may be null (not configured).
export async function resolveAdmin({ mode, verifyToken, token, bodyAdminId }) {
  const present = typeof token === 'string' && token !== '';
  if (present && verifyToken) {
    const id = await verifyToken(token);
    if (!id) return { refused: [401, { error: 'admin session is not valid' }], reason: 'bad-admin-token' };
    if (bodyAdminId !== undefined && bodyAdminId !== null && String(bodyAdminId).toLowerCase() !== id) {
      return { refused: [403, { error: 'admin only' }], reason: 'admin-id-mismatch' };
    }
    return { adminId: id, via: 'token' };
  }
  if (mode === 'required') return { refused: [401, { error: 'admin session required' }], reason: present ? 'admin-token-unverifiable' : 'missing-admin-token' };
  return { adminId: bodyAdminId, via: 'legacy' };
}
