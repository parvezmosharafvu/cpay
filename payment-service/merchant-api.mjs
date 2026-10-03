// Merchant API (/v1/*). Authentication, scopes, rate limiting, idempotency
// and audit live in the database (merchant_* functions); invoices are made
// by the payment service's existing createInvoice, never a second engine.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_SHAPE = /^cpay_sk_[0-9a-f]{8}_[0-9a-f]{64}$/;
const IDEM_SHAPE = /^[A-Za-z0-9_.:-]{1,100}$/;
const AMOUNT_SHAPE = /^\d{1,5}(\.\d{1,2})?$/;
const STATUSES = new Set(['new', 'pending', 'settled', 'expired', 'invalid']);
export const RATE_LIMIT = 60;
export const RATE_WINDOW_SECONDS = 60;

const DB_ERRORS = {
  invalid_key: [401, 'invalid API key'],
  invalid_amount: [400, 'amount must be between 1 and 5000 with at most 2 decimals'],
  invalid_reference: [400, 'reference must be at most 100 characters'],
  payments_paused: [503, 'new payments are temporarily paused'],
  above_profile_limit: [400, 'amount is above this account\'s per-invoice limit'],
  idempotency_conflict: [409, 'Idempotency-Key was already used with a different request'],
};

const scopeFor = (method, path) => {
  if (method === 'POST' && path === '/v1/invoices') return 'invoices:write';
  if (method === 'GET' && /^\/v1\/invoices\/[^/]+(\/status)?$/.test(path)) return 'invoices:read';
  if (method === 'GET' && /^\/v1\/payments(\/[^/]+)?$/.test(path)) return 'payments:read';
  if (method === 'GET' && path === '/v1/balance') return 'balance:read';
  return null;
};

export function createMerchantRoute({ db, createInvoice, readJson, log }) {
  const q = async (sql, params) => (await db.query(sql, params)).rows;

  async function authenticate(header) {
    const [scheme, token, ...rest] = String(header ?? '').split(' ');
    const m = scheme.toLowerCase() === 'bea' + 'rer' && !rest.length ? [null, token] : null;
    if (!m || !KEY_SHAPE.test(m[1])) return null;
    const [row] = await q('select key_id, user_id, scopes from merchant_authenticate($1)', [m[1]]);
    return row ?? null;
  }

  const audit = (keyId, action, type, id, note) =>
    q('select merchant_audit($1,$2,$3,$4,$5)', [keyId, action, type, id, note ?? null])
      .catch((e) => log({ event: 'merchant-audit-failed', action, error: String(e?.message ?? e).slice(0, 200) }));

  async function getPayment(keyId, id) {
    const [{ merchant_get_payment: p }] = await q('select merchant_get_payment($1,$2)', [keyId, id]);
    return p;
  }

  function invoiceView(p) {
    const raw = p.bolt11 ? String(p.bolt11) : null;
    return {
      id: p.id, status: p.status, amount: p.amount, amountSat: p.amount_sat, reference: p.reference,
      bolt11: raw, lightningUri: raw ? `lightning:${raw}` : null,
      paymentHash: p.payment_hash, createdAt: p.created_at, expiresAt: p.expires_at, settledAt: p.settled_at,
    };
  }

  async function postInvoice(auth, req) {
    const body = await readJson(req);
    const amount = String(body.amount ?? '').trim();
    if (!AMOUNT_SHAPE.test(amount)) return [400, { error: DB_ERRORS.invalid_amount[1] }];
    const reference = body.reference == null ? null : String(body.reference);
    const idem = req.headers['idempotency-key'] ?? null;
    if (idem !== null && !IDEM_SHAPE.test(String(idem))) return [400, { error: 'Idempotency-Key must be 1-100 characters of A-Z a-z 0-9 _ . : -' }];

    let created;
    try {
      [created] = await q('select payment_id, replayed from merchant_create_payment($1,$2,$3,$4)', [auth.key_id, amount, reference, idem]);
    } catch (e) {
      const hit = DB_ERRORS[String(e?.message ?? '').trim()];
      if (hit) return [hit[0], { error: hit[1] }];
      throw e;
    }
    const [status, invoice] = await createInvoice(created.payment_id);
    if (status !== 200) {
      if (!created.replayed) {
        // Nobody saw an invoice for this row, so drop it and free the key for a retry.
        await q('delete from payments where id = $1 and lightning_invoice is null', [created.payment_id]).catch(() => {});
        if (idem) await q('delete from merchant_idempotency where key_id = $1 and idem_key = $2 and payment_id is null', [auth.key_id, idem]).catch(() => {});
      }
      return [status === 404 ? 502 : status, { error: invoice.error ?? 'could not create invoice' }];
    }
    if (!created.replayed) await audit(auth.key_id, 'merchant_api.invoice_created', 'payment', created.payment_id, `amount ${amount}`);
    const view = invoiceView(await getPayment(auth.key_id, created.payment_id));
    return [created.replayed ? 200 : 201, { ...view, replayed: created.replayed }];
  }

  return async function merchantRoute(req) {
    const path = new URL(req.url, 'http://localhost').pathname.replace(/\/+$/, '');
    const method = req.method;
    const scope = scopeFor(method, path);
    if (!scope) return [404, { error: 'not found' }];

    const auth = await authenticate(req.headers.authorization);
    if (!auth) return [401, { error: 'invalid API key' }];
    const [{ merchant_claim_rate_limit: allowed }] = await q('select merchant_claim_rate_limit($1,$2,$3)', [auth.key_id, RATE_LIMIT, RATE_WINDOW_SECONDS]);
    if (!allowed) return [429, { error: 'rate limit exceeded', retryAfterSeconds: RATE_WINDOW_SECONDS }];
    if (!auth.scopes.includes(scope)) {
      await audit(auth.key_id, 'merchant_api.scope_denied', 'route', `${method} ${path}`, `needs ${scope}`);
      return [403, { error: `API key lacks the ${scope} scope` }];
    }

    if (method === 'POST') return postInvoice(auth, req);

    const url = new URL(req.url, 'http://localhost');
    if (path === '/v1/balance') {
      const [{ merchant_balance: b }] = await q('select merchant_balance($1)', [auth.key_id]);
      await audit(auth.key_id, 'merchant_api.balance_read', 'balance', auth.user_id);
      return [200, { earned: b.earned, queued: b.queued, withdrawn: b.withdrawn, available: b.available }];
    }
    if (path === '/v1/payments') {
      const status = url.searchParams.get('status');
      if (status && !STATUSES.has(status)) return [400, { error: 'unknown status' }];
      const num = (name, def) => { const v = url.searchParams.get(name); return v === null ? def : Number(v); };
      const limit = num('limit', 25), offset = num('offset', 0);
      if (!Number.isInteger(limit) || !Number.isInteger(offset) || limit < 1 || limit > 100 || offset < 0) {
        return [400, { error: 'limit must be 1-100 and offset 0 or more' }];
      }
      const [{ merchant_list_payments: r }] = await q('select merchant_list_payments($1,$2,$3,$4)', [auth.key_id, limit, offset, status]);
      return [200, { total: r.total, limit, offset, data: r.data }];
    }
    const [, , , id, tail] = path.split('/');
    if (!UUID.test(id)) return [404, { error: 'not found' }];
    const p = await getPayment(auth.key_id, id);
    // Another merchant's id is indistinguishable from a missing one.
    if (!p) return [404, { error: 'not found' }];
    if (path.startsWith('/v1/payments/')) {
      await audit(auth.key_id, 'merchant_api.payment_read', 'payment', id);
      return [200, { id: p.id, status: p.status, amount: p.amount, amountSettled: p.amount_settled, reference: p.reference, createdAt: p.created_at, settledAt: p.settled_at }];
    }
    if (tail === 'status') return [200, { id: p.id, status: p.status, amountSettled: p.amount_settled, settledAt: p.settled_at, expiresAt: p.expires_at }];
    return [200, invoiceView(p)];
  };
}

