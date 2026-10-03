// Merchant webhook delivery. Events are queued by a trigger on payments
// (migration 20261003040000); this signs and sends them with retries.
// Nothing unsigned is ever sent: the signature is computed from the endpoint
// secret over `${timestamp}.${body}` for every attempt.

import { createHmac, timingSafeEqual } from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';

export const MAX_ATTEMPTS = 8;
export const BASE_DELAY_SECONDS = 30;
export const MAX_DELAY_SECONDS = 6 * 60 * 60;
export const TIMEOUT_MS = 10_000;
export const TOLERANCE_SECONDS = 300;

// 30s, 60s, 2m, 4m ... capped at 6h. `attempt` is the number of attempts already made.
export const backoffSeconds = (attempt) => Math.min(BASE_DELAY_SECONDS * 2 ** Math.max(attempt - 1, 0), MAX_DELAY_SECONDS);

export function sign(secret, timestamp, body) {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export const signatureHeader = (secret, timestamp, body) => `t=${timestamp},v1=${sign(secret, timestamp, body)}`;

// For receivers (and our tests): true only for a well-formed header whose
// signature matches and whose timestamp is within the tolerance.
export function verifySignature(secret, header, body, { toleranceSeconds = TOLERANCE_SECONDS, now = () => Date.now() } = {}) {
  const parts = Object.fromEntries(String(header ?? '').split(',').map((p) => p.split('=')).filter((p) => p.length === 2));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(parts.v1 ?? '')) return false;
  if (Math.abs(Math.floor(now() / 1000) - t) > toleranceSeconds) return false;
  const expected = Buffer.from(sign(secret, t, body), 'hex');
  return timingSafeEqual(expected, Buffer.from(parts.v1, 'hex'));
}

// Receivers should also drop an event id they have already processed.
export function createReplayGuard() {
  const seen = new Set();
  return (eventId) => { if (seen.has(eventId)) return false; seen.add(eventId); return true; };
}

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb');
}

const defaultResolve = async (host) => (await dns.lookup(host, { all: true })).map((r) => r.address);

async function assertPublicUrl(url, resolve) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('endpoint must use https');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [host] : await resolve(host);
  if (!addrs.length || addrs.some(isPrivateAddress)) throw new Error('endpoint resolves to a non-public address');
}

export function createWebhookDispatcher({ db, log = () => {}, now = () => Date.now(), fetchImpl = fetch, resolve = defaultResolve, batch = 20 }) {
  const q = async (sql, params) => (await db.query(sql, params)).rows;

  async function attempt(row) {
    const timestamp = Math.floor(now() / 1000);
    const body = JSON.stringify({
      id: row.event_id, type: row.event_type, created: Math.floor(new Date(row.event_created_at).getTime() / 1000), data: row.payload,
    });
    const started = now();
    let statusCode = null, error = null, success = false;
    try {
      await assertPublicUrl(row.url, resolve);
      const res = await fetchImpl(row.url, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          'content-type': 'application/json',
          'user-agent': 'CPAY-Webhooks/1',
          'cpay-event-id': row.event_id,
          'cpay-event-type': row.event_type,
          'cpay-timestamp': String(timestamp),
          'cpay-signature': signatureHeader(row.secret, timestamp, body),
        },
        body,
      });
      statusCode = res.status;
      success = res.status >= 200 && res.status < 300;
      if (!success) error = `endpoint answered ${res.status}`;
    } catch (e) {
      error = String(e?.message ?? e).slice(0, 200);
    }
    const made = Number(row.attempts) + 1;
    const final = !success && made >= MAX_ATTEMPTS;
    const [recorded] = await q('select webhook_record_attempt($1,$2,$3,$4,$5,$6,$7) as status', [
      row.delivery_id, statusCode, error, Math.max(0, now() - started), success, final, backoffSeconds(made),
    ]);
    const status = recorded?.status ?? null;
    log({ event: 'webhook-attempt', deliveryId: row.delivery_id, eventId: row.event_id, attempt: made, outcome: status, statusCode });
    return status;
  }

  // One pass: returns how many deliveries were attempted.
  async function deliverDue() {
    await q('select webhook_close_orphans()');
    const rows = await q('select * from webhook_claim_due($1)', [batch]);
    const results = await Promise.all(rows.map((r) => attempt(r).catch((e) => {
      log({ event: 'webhook-attempt-failed', deliveryId: r.delivery_id, error: String(e?.message ?? e).slice(0, 200) });
      return null;
    })));
    return { attempted: rows.length, succeeded: results.filter((s) => s === 'succeeded').length };
  }

  return { deliverDue };
}
