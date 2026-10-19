// Instant forward (docs/INSTANT-FORWARD.md): send each queued payment_forwards
// row to the user's Lightning address. Runs inside the sync tick, so only the
// one wallet-lease holder ever forwards. Safety:
//   - one row per payment (unique payment_id in the database);
//   - a row is claimed (queued/retry -> sending) with FOR UPDATE SKIP LOCKED;
//   - the forward id is the send's idempotency key, and the wallet is asked
//     for that key first, so a crash or retry never pays twice;
//   - the network fee is paid out of the forward (the user's share), capped by
//     instant_forward_max_fee_pct; sent + fee never exceeds forward_sat.
import { retryLeafErrors, wait } from './withdraw.mjs';

const STUCK_SECS = 120;
// Short: the sync tick runs every minute; a leaf error just retries next tick.
const LEAF_MS = 20_000;

export function createForwarder({ breez, db, log = () => {}, now = () => Date.now(), sleep = wait, batch = 5 }) {
  async function findPayment(id) {
    try {
      return (await breez.getPayment({ paymentId: id })).payment ?? null;
    } catch (e) {
      if (/not found/i.test(String(e?.message ?? e))) return null;
      throw e;
    }
  }

  async function finish(id, outcome, { sent = null, fee = null, ref = null, error = null } = {}) {
    const { rows } = await db.query('select public.system_forward_finish($1, $2, $3, $4, $5, $6) as r',
      [id, outcome, sent, fee, ref, error ? String(error).slice(0, 500) : null]);
    log({ event: 'forward', forwardId: id, outcome: rows[0].r, ...(error ? { error: String(error).slice(0, 200) } : {}) });
    return rows[0].r;
  }

  // A payment the wallet already has for this forward decides the row.
  async function fromPayment(row, p) {
    if (p.status === 'completed') {
      const sent = Number(p.amount ?? 0);
      const fee = Math.min(Number(p.fees ?? 0), Math.max(0, Number(row.forward_sat) - sent));
      return finish(row.id, 'forwarded', { sent, fee, ref: String(p.id) });
    }
    if (p.status === 'failed') return finish(row.id, 'retry', { error: 'send failed' });
    return 'sending';
  }

  async function settings() {
    const { rows } = await db.query(
      `select coalesce((public.platform_setting('instant_forward_max_fee_pct') #>> '{}')::numeric, 1)::float8 as pct`);
    return { maxFeePct: Number(rows[0].pct) };
  }

  async function quote(payRequest, amount) {
    const res = await breez.prepareLnurlPay({ amount: BigInt(amount), payRequest });
    return { res, fee: Number(res.feeSats ?? 0) };
  }

  async function forwardOne(row, cfg) {
    const existing = await findPayment(row.id);
    if (existing) return fromPayment(row, existing);
    const total = Number(row.forward_sat);
    let parsed;
    try { parsed = await breez.parse(String(row.address ?? '')); } catch { parsed = null; }
    if (parsed?.type !== 'lightningAddress' && parsed?.type !== 'lnurlPay') {
      return finish(row.id, 'retry', { error: 'Lightning address did not answer' });
    }
    const payRequest = parsed.type === 'lightningAddress' ? parsed.payRequest : parsed;
    // Quote at the full amount, then at amount minus that fee; re-quote once
    // if the fee moved so amount + fee still fits.
    let amount, q;
    try {
      q = await quote(payRequest, total);
      amount = total - q.fee;
      for (let i = 0; i < 3 && amount > 0; i++) {
        q = await quote(payRequest, amount);
        if (amount + q.fee <= total) break;
        amount = total - q.fee;
      }
    } catch (e) {
      return finish(row.id, 'retry', { error: `could not prepare: ${e?.message ?? e}` });
    }
    if (!(amount > 0) || amount + q.fee > total) return finish(row.id, 'retry', { error: 'network fee leaves nothing to send' });
    if (q.fee > Math.floor(total * cfg.maxFeePct / 100)) return finish(row.id, 'retry', { error: `network fee ${q.fee} sats is over ${cfg.maxFeePct}%` });
    const min = Math.ceil(Number(payRequest.minSendable ?? 1000) / 1000);
    const max = Math.floor(Number(payRequest.maxSendable ?? 1e15) / 1000);
    if (amount < min || amount > max) return finish(row.id, 'owed', { error: 'outside_address_limits' });
    const { balanceSats } = await breez.getInfo({ ensureSynced: false });
    if (Number(balanceSats) < amount + q.fee) return finish(row.id, 'retry', { error: 'wallet balance too low' });
    let payment = null, error = null;
    try {
      ({ payment } = await retryLeafErrors({
        breez, key: row.id, now, sleep, log, deadlineMs: now() + LEAF_MS,
        attempt: () => breez.lnurlPay({ prepareResponse: q.res, idempotencyKey: row.id }),
        existing: () => findPayment(row.id),
      }));
    } catch (e) {
      error = e;
      payment = await findPayment(row.id).catch(() => null);
    }
    if (payment) return fromPayment(row, payment);
    // Nothing was found under this key: safe to try again later with the
    // same key (the wallet library refuses a second payment for it).
    return finish(row.id, 'retry', { error: `send failed: ${error?.message ?? error}` });
  }

  // Rows left in 'sending' (a crash, a lost reply): settle them from the
  // wallet's own record. Only after a completed sync is "not found" trusted.
  async function recover(synced) {
    const { rows } = await db.query('select * from public.system_forward_stuck($1)', [STUCK_SECS]);
    for (const row of rows) {
      const p = await findPayment(row.id);
      if (p) await fromPayment(row, p);
      else if (synced) await finish(row.id, 'retry', { error: 'no send found after restart' });
    }
    return rows.length;
  }

  async function run({ synced = false } = {}) {
    const out = { recovered: 0 };
    out.recovered = await recover(synced);
    const { rows } = await db.query('select * from public.system_forward_claim($1)', [batch]);
    if (!rows.length) return out;
    const cfg = await settings();
    for (const row of rows) {
      let r;
      try { r = await forwardOne(row, cfg); }
      catch (e) {
        log({ event: 'forward-error', forwardId: row.id, error: String(e?.message ?? e).slice(0, 300) });
        // Leave it 'sending': recover() decides from the wallet next tick.
        r = 'sending';
      }
      out[r] = (out[r] ?? 0) + 1;
    }
    return out;
  }

  return { run, forwardOne, recover };
}
