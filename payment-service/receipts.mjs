// F1 PR 1: the receipt log, record-only. Every completed receive is
// written to lightning_receipts before the unchanged legacy settlement
// runs, and the legacy outcome is copied next to it afterwards.
//
// Hard rule: nothing in this file may stop, change or delay settlement
// beyond the recording timeout. recordReceipt() and noteLegacyOutcome()
// never throw; every failure is logged, counted and swallowed. Recording
// uses its own small pool (recordDb), so it cannot take connections the
// settlement path needs, and each call is one autocommit statement, so a
// recording error cannot roll back a settlement or the other way round.
// Nothing here evaluates, credits, settles or touches payments.

import { paymentHashOf, settlePayment } from './ledger.mjs';

export const RECEIPT_MODES = new Set(['off', 'shadow']);
export const DEFAULT_RECORD_TIMEOUT_MS = 2_500;
// Server-side limit for each recording statement (set on the recording
// pool's connections). Below the client-side timeout above.
export const RECORD_STATEMENT_TIMEOUT_MS = 2_000;

const LEGACY_OUTCOMES = new Set(['settled', 'duplicate', 'already_settled', 'underpaid', 'not_settleable', 'unknown', 'no_hash']);
const RECEIVE_KINDS = new Set(['lightning', 'spark', 'token', 'deposit']);
const METHODS = new Set(['lightning', 'spark', 'token', 'deposit', 'withdraw', 'unknown']);
const STATUSES = new Set(['completed', 'pending', 'failed']);
const HTLC_STATUSES = new Set(['waitingForPreimage', 'preimageShared', 'returned']);
const ID = /^[\x21-\x7e]{1,200}$/;
const HEX64ISH = /^[0-9a-f]{1,128}$/;
const TXID = /^[0-9a-f]{64}$/;
const DIGITS = /^\d{1,18}$/;

// Explicit allowlist of what may be stored from an SDK payment object.
// Each entry reads one value and returns it only if it has the expected
// type and size; anything else is dropped (never truncated). Fields that
// are not listed (invoice, description, preimage, lnurl data, conversion
// details, and anything the SDK adds later) are never stored.
const PAYLOAD_FIELDS = {
  id: (p) => (typeof p.id === 'string' && ID.test(p.id) ? p.id : undefined),
  paymentType: (p) => (p.paymentType === 'receive' || p.paymentType === 'send' ? p.paymentType : undefined),
  status: (p) => (STATUSES.has(p.status) ? p.status : undefined),
  method: (p) => (METHODS.has(p.method) ? p.method : undefined),
  amount: (p) => digits(p.amount),
  fees: (p) => digits(p.fees),
  timestamp: (p) => (Number.isSafeInteger(p.timestamp) && p.timestamp >= 0 ? p.timestamp : undefined),
  detailsType: (p) => (typeof p.details?.type === 'string' && /^[a-z]{1,20}$/.test(p.details.type) ? p.details.type : undefined),
  paymentHash: (p) => hexOrUndefined(p.details?.htlcDetails?.paymentHash),
  htlcStatus: (p) => (HTLC_STATUSES.has(p.details?.htlcDetails?.status) ? p.details.htlcDetails.status : undefined),
  htlcExpiryTime: (p) => {
    const t = p.details?.htlcDetails?.expiryTime;
    return Number.isSafeInteger(t) && t >= 0 ? t : undefined;
  },
  txId: (p) => (typeof p.details?.txId === 'string' && TXID.test(p.details.txId.toLowerCase()) ? p.details.txId.toLowerCase() : undefined),
  vout: (p) => (Number.isSafeInteger(p.details?.vout) && p.details.vout >= 0 && p.details.vout < 100_000 ? p.details.vout : undefined),
};
export const PAYLOAD_KEYS = Object.freeze([...Object.keys(PAYLOAD_FIELDS), 'droppedFields']);
export const MAX_PAYLOAD_BYTES = 4096;

function digits(v) {
  if (typeof v !== 'bigint' && typeof v !== 'number' && typeof v !== 'string') return undefined;
  const s = String(v);
  return DIGITS.test(s) ? s : undefined;
}

function hexOrUndefined(v) {
  if (typeof v !== 'string') return undefined;
  const s = v.toLowerCase();
  return HEX64ISH.test(s) ? s : undefined;
}

// Builds the stored payload from the allowlist only. droppedFields counts
// allowlisted fields that were present but failed validation.
export function sanitizePayload(payment) {
  const out = {};
  let dropped = 0;
  for (const [key, read] of Object.entries(PAYLOAD_FIELDS)) {
    let value;
    try { value = read(payment); } catch { value = undefined; }
    if (value !== undefined) out[key] = value;
    else if (rawPresent(payment, key)) dropped++;
  }
  if (dropped) out.droppedFields = dropped;
  if (Buffer.byteLength(JSON.stringify(out)) > MAX_PAYLOAD_BYTES) throw new Error('payload too large');
  return out;
}

function rawPresent(p, key) {
  const d = p?.details;
  const h = d?.htlcDetails;
  const raw = {
    id: p?.id, paymentType: p?.paymentType, status: p?.status, method: p?.method, amount: p?.amount, fees: p?.fees,
    timestamp: p?.timestamp, detailsType: d?.type, paymentHash: h?.paymentHash, htlcStatus: h?.status,
    htlcExpiryTime: h?.expiryTime, txId: d?.txId, vout: d?.vout,
  }[key];
  return raw !== undefined && raw !== null;
}

// The arguments for record_lightning_receipt(). Throws when the payment
// cannot be recorded faithfully (bad id or amount); the caller logs it as
// a 'mapping' failure and settlement goes ahead.
export function receiptArgs(payment, source) {
  const id = payment.id;
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('payment id is not recordable');
  const amount = digits(payment.amount);
  if (amount === undefined) throw new Error('payment amount is not recordable');
  const fee = digits(payment.fees ?? 0) ?? null;
  const hash = hexOrUndefined(paymentHashOf(payment)) ?? null;
  const kind = RECEIVE_KINDS.has(payment.details?.type) ? payment.details.type : 'other';
  const ts = Number.isSafeInteger(payment.timestamp) && payment.timestamp > 0 ? payment.timestamp : null;
  return [id, hash, kind, amount, fee, ts, sanitizePayload(payment), source === 'catch-up' ? 'catch_up' : 'event'];
}

export function shouldRecord(payment) {
  return payment?.paymentType === 'receive' && payment?.status === 'completed';
}

export function failureClass(e) {
  if (e?.cpayTimeout) return 'timeout';
  const code = e?.code;
  if (code === '42883' || code === '42P01') return 'function_missing';
  if (code === '42501') return 'permission';
  if (typeof code === 'string' && code.startsWith('23')) return 'constraint';
  if (code === '57014' || code === '55P03') return 'timeout';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND' || code === 'ETIMEDOUT'
      || (typeof code === 'string' && (code.startsWith('08') || code === '57P01'))
      || /connect|terminat|Connection/i.test(String(e?.message ?? ''))) return 'connection';
  if (e?.cpayMapping) return 'mapping';
  return 'other';
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('receipt recording timed out'), { cpayTimeout: true })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const short = (e) => String(e?.message ?? e).slice(0, 200);

export function createReceiptRecorder({ mode = 'off', recordDb = null, log = () => {}, timeoutMs = DEFAULT_RECORD_TIMEOUT_MS } = {}) {
  const enabled = mode === 'shadow' && recordDb !== null;
  const stats = { recorded: 0, duplicate: 0, updated: 0, conflict: 0, failed: 0, outcomeNoted: 0, outcomeFailed: 0 };

  // Returns true when a receipt row exists for this payment afterwards.
  // Never throws.
  async function recordReceipt(payment, source) {
    if (!enabled || !shouldRecord(payment)) return false;
    let args;
    try {
      args = receiptArgs(payment, source);
    } catch (e) {
      stats.failed++;
      log({ event: 'receipt-record-failed', breezPaymentId: safeId(payment), failure: 'mapping', error: short(e) });
      return false;
    }
    try {
      const { rows } = await withTimeout(
        recordDb.query('select public.record_lightning_receipt($1, $2, $3, $4, $5, $6, $7, $8) as outcome', args),
        timeoutMs,
      );
      const outcome = rows[0].outcome;
      if (outcome in stats) stats[outcome]++;
      log({ event: outcome === 'conflict' ? 'receipt-conflict' : 'receipt-recorded', breezPaymentId: args[0], source, outcome });
      return true;
    } catch (e) {
      stats.failed++;
      log({ event: 'receipt-record-failed', breezPaymentId: args[0], failure: failureClass(e), error: short(e) });
      return false;
    }
  }

  // Best effort, after settlement has already happened. Never throws.
  async function noteLegacyOutcome(payment, outcome) {
    if (!enabled || !LEGACY_OUTCOMES.has(outcome)) return;
    try {
      await withTimeout(
        recordDb.query('select public.note_lightning_receipt_legacy_outcome($1, $2)', [payment.id, outcome]),
        timeoutMs,
      );
      stats.outcomeNoted++;
    } catch (e) {
      stats.outcomeFailed++;
      log({ event: 'receipt-outcome-failed', breezPaymentId: safeId(payment), failure: failureClass(e), error: short(e) });
    }
  }

  return { enabled, recordReceipt, noteLegacyOutcome, stats: () => ({ ...stats }) };
}

function safeId(payment) {
  try { return typeof payment?.id === 'string' ? payment.id.slice(0, 200) : null; } catch { return null; }
}

// Record (shadow only), then the unchanged legacy settlement, then the
// shadow copy of its outcome. The legacy call runs whatever happens in
// recording: recordReceipt() never throws, and the guard below covers a
// recorder that is broken itself. Errors from the legacy call propagate
// exactly as on main.
export async function settleWithReceipt({ db, recorder, payment, source, settle = settlePayment }) {
  let recorded = false;
  try { recorded = await recorder.recordReceipt(payment, source); } catch { recorded = false; }
  const outcome = await settle(db, payment);
  if (recorded) {
    try { await recorder.noteLegacyOutcome(payment, outcome); } catch { /* shadow only */ }
  }
  return outcome;
}
