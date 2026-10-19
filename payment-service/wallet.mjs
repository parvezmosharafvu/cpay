// The platform's own Breez wallet, for the admin Wallet tab: balance,
// history, receive, addresses, sends and fiat rates. Nothing here writes a
// creator's ledger. A send may only spend what the wallet holds beyond what
// the platform owes creators, and every send is written to audit_log before
// it leaves and again when Breez answers.

import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { UserError, parseAmountCents, networkFeeUsd, retryLeafErrors, wait, LEAF_RETRY_MS } from './withdraw.mjs';
import { decimalToCents, formatCents, satsToUsdCents, usdCentsToSats, usdToSats } from './money.mjs';

export const PREPARE_TTL_MS = 10 * 60 * 1000;
export const MAX_PAGE = 50;
const MAX_SEND_SAT = 100_000_000;
const QUOTE_MARGIN_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Constant-time check of the shared secret the edge functions send.
export function bearerAuth(secret) {
  const expected = createHash('sha256').update(`Bearer ${secret}`).digest();
  return (header) => timingSafeEqual(createHash('sha256').update(header ?? '').digest(), expected);
}

// A Breez Payment as JSON. amount and fees are bigints in the SDK.
export function paymentView(p) {
  const d = p.details ?? {};
  return {
    id: p.id,
    type: p.paymentType,
    status: p.status,
    method: p.method,
    amountSat: String(p.amount ?? 0n),
    feeSat: String(p.fees ?? 0n),
    at: new Date(Number(p.timestamp) * 1000).toISOString(),
    description: d.description ?? null,
    invoice: d.type === 'lightning' ? d.invoice : null,
    lightningAddress: d.lnurlPayInfo?.lnAddress ?? null,
    conversion: p.conversionDetails?.status ?? null,
  };
}

function wholeSats(value, { min = 1, max = MAX_SEND_SAT, label = 'Amount' } = {}) {
  const s = String(value ?? '').trim();
  if (!/^\d+$/.test(s)) throw new UserError(400, `${label} must be a whole number of sats`);
  const n = Number(s);
  if (n < min || n > max) throw new UserError(422, `${label} must be between ${min} and ${max} sats`);
  return n;
}

// What the platform owes creators, in USD: every available balance plus
// withdrawals that are requested but not yet paid out.
export async function owedToCreatorsUsd(db) {
  const { rows } = await db.query(
    `select (coalesce((select sum(greatest(b.available, 0)) from profiles p cross join lateral get_balance_for(p.id) b), 0)
           + coalesce((select sum(amount_requested) from withdrawals where status in ('pending','approved','processing','sending')), 0))::text as owed`,
  );
  return rows[0].owed;
}

export function createWallet({ breez, db, btcUsdRate, withdrawals, now = () => Date.now(), sleep = wait, log = () => {}, track = (p) => p }) {
  const prepared = new Map();
  const inflight = new Map();

  // role = 'admin' AND account_status = 'active', the database's is_admin()
  // rule. Checked on every /admin/wallet call, so a suspended, pending or
  // rejected admin can neither start nor confirm a send.
  async function isAdmin(adminId) {
    if (!UUID.test(String(adminId))) return false;
    const { rows } = await db.query(`select role, account_status from profiles where id = $1`, [adminId]);
    return rows[0]?.role === 'admin' && rows[0]?.account_status === 'active';
  }

  // Sats the platform may spend without touching money owed to creators.
  // Refuses when there is no rate, because then the owed amount is unknown.
  async function spendable() {
    const { balanceSats } = await breez.getInfo({ ensureSynced: false });
    const rate = await btcUsdRate();
    const owedUsd = await owedToCreatorsUsd(db);
    const owedSat = usdToSats(owedUsd, rate);
    return { balanceSats: Number(balanceSats), rate, owedUsd, owedSat, spendableSat: Math.max(0, Number(balanceSats) - owedSat) };
  }

  async function guard(totalSat) {
    const s = await spendable();
    if (totalSat > s.spendableSat) {
      throw new UserError(422, `This send needs ${totalSat} sats but only ${s.spendableSat} are spendable. `
        + `The wallet holds ${s.balanceSats} sats and ${s.owedSat} of them back $${formatCents(decimalToCents(s.owedUsd))} owed to creators.`);
    }
    return s;
  }

  // Owner limits from Admin → Settings (admin_send_daily_cap_usd,
  // admin_send_allowed_destinations), enforced by the database function
  // system_admin_send_check(). Checked at prepare and again right before the
  // send. Both are off by default.
  async function limits(destination, usdCents) {
    try {
      await db.query('select public.system_admin_send_check($1, $2)', [String(destination ?? ''), usdCents]);
    } catch (e) {
      const m = String(e?.message ?? e);
      if (/allow-list|daily cap|unknown amount/.test(m)) throw new UserError(422, m);
      throw e;
    }
  }
  const usdCentsOf = (v) => (v.kind === 'stablecoin' ? decimalToCents(v.amountUsd) : decimalToCents(v.totalUsd));

  async function info() {
    const { balanceSats } = await breez.getInfo({ ensureSynced: false });
    let rate = null, rateError = null;
    try { rate = await btcUsdRate(); } catch (e) { rateError = String(e?.message ?? e); }
    const owedUsd = await owedToCreatorsUsd(db);
    const owedSat = rate ? usdToSats(owedUsd, rate) : null;
    const bal = Number(balanceSats);
    return {
      balanceSats: bal,
      btcUsdRate: rate,
      balanceUsd: rate ? formatCents(satsToUsdCents(bal, rate)) : null,
      owedToCreatorsUsd: formatCents(decimalToCents(owedUsd)),
      owedToCreatorsSat: owedSat,
      spendableSat: owedSat === null ? null : Math.max(0, bal - owedSat),
      rateError,
    };
  }

  async function payments({ offset = 0, limit = 20 } = {}) {
    const off = Math.max(0, Math.floor(Number(offset) || 0));
    const lim = Math.min(MAX_PAGE, Math.max(1, Math.floor(Number(limit) || 20)));
    const { payments: list } = await breez.listPayments({ offset: off, limit: lim, sortAscending: false });
    return { payments: list.map(paymentView), offset: off, limit: lim, hasMore: list.length === lim };
  }

  async function receive({ amountSat, memo }) {
    const amount = wholeSats(amountSat);
    const description = String(memo ?? '').trim().slice(0, 200) || 'cpay platform wallet';
    const expirySecs = 3600;
    const res = await breez.receivePayment({ paymentMethod: { type: 'bolt11Invoice', description, amountSats: amount, expirySecs } });
    return {
      bolt11: res.paymentRequest, amountSat: amount, memo: description, feeSat: String(res.fee ?? 0n),
      expiresAt: new Date(now() + expirySecs * 1000).toISOString(),
    };
  }

  async function addresses() {
    const out = { sparkAddress: null, lightningAddress: null, lnurl: null, notes: [] };
    try {
      out.sparkAddress = (await breez.receivePayment({ paymentMethod: { type: 'sparkAddress' } })).paymentRequest;
    } catch (e) { out.notes.push(`Spark address: ${e?.message ?? e}`); }
    try {
      const la = await breez.getLightningAddress();
      if (la) { out.lightningAddress = la.lightningAddress; out.lnurl = la.lnurl?.bech32 ?? null; }
      else out.notes.push('No Lightning address is registered for this wallet');
    } catch (e) { out.notes.push(`Lightning address: ${e?.message ?? e}`); }
    return out;
  }

  function remember(entry) {
    const prepareId = randomUUID();
    prepared.set(prepareId, { ...entry, prepareId });
    for (const [k, p] of prepared) if (p.expiresAtMs < now() - 60_000) prepared.delete(k);
    return prepareId;
  }

  // Edge isolates hand the wallet over between requests, so a quote held
  // only in this process can be gone by the time the admin confirms. Every
  // quote is also stored in breez_wallet.admin_send_quotes: tied to the
  // admin, expiring with the quote, and claimed once (consumed_at). A
  // confirm on another instance re-prepares the same send and refuses if it
  // now costs more than what the admin approved.
  async function persist(prepareId, adminId, kind, request, view, expiresAtMs) {
    await db.query(`delete from breez_wallet.admin_send_quotes where created_at < now() - interval '7 days'`);
    await db.query(
      `insert into breez_wallet.admin_send_quotes (id, admin_id, kind, request, view, expires_at)
       values ($1, $2, $3, $4::jsonb, $5::jsonb, to_timestamp($6::double precision / 1000))`,
      [prepareId, adminId, kind, JSON.stringify(request), JSON.stringify(view), expiresAtMs],
    );
  }

  async function claim(prepareId, adminId) {
    const { rows } = await db.query(
      `update breez_wallet.admin_send_quotes set consumed_at = now()
        where id = $1 and admin_id = $2 and consumed_at is null
        returning kind, request, view, (extract(epoch from expires_at) * 1000)::float8 as expires_ms`,
      [prepareId, adminId],
    );
    if (rows[0]) return rows[0];
    const { rows: used } = await db.query(
      `select 1 from breez_wallet.admin_send_quotes where id = $1 and admin_id = $2 and consumed_at is not null`,
      [prepareId, adminId],
    );
    if (used[0]) throw new UserError(409, 'This send was already confirmed. Check the wallet history before sending again.');
    throw new UserError(404, 'Nothing to confirm. Prepare the send again.');
  }

  async function sendPrepare({ adminId, destination, amountSat }) {
    const built = await buildSend({ destination, amountSat });
    const prepareId = remember({ adminId, ...built });
    await persist(prepareId, adminId, built.kind, { destination: built.view.destination, amountSat: amountSat ?? null }, built.view, built.expiresAtMs);
    return { prepareId, ...built.view };
  }

  async function buildSend({ destination, amountSat }) {
    const input = String(destination ?? '').trim();
    if (!input) throw new UserError(400, 'Paste a Lightning invoice, Lightning address or Spark address');
    let parsed;
    try { parsed = await breez.parse(input); } catch { parsed = null; }
    const amount = () => wholeSats(amountSat);
    let kind, res, sat, feeSat, lnurl = false;
    try {
      if (parsed?.type === 'bolt11Invoice') {
        kind = 'lightning';
        const fixed = parsed.amountMsat != null ? Math.ceil(parsed.amountMsat / 1000) : null;
        sat = fixed === null ? amount() : wholeSats(fixed, { label: 'Invoice amount' });
        res = await breez.prepareSendPayment({ paymentRequest: { type: 'input', input }, amount: fixed ? undefined : BigInt(sat) });
        feeSat = Number(res.paymentMethod.lightningFeeSats ?? 0);
      } else if (parsed?.type === 'sparkAddress') {
        kind = 'spark';
        sat = amount();
        res = await breez.prepareSendPayment({ paymentRequest: { type: 'input', input }, amount: BigInt(sat) });
        feeSat = Number(res.paymentMethod.fee ?? 0);
      } else if (parsed?.type === 'lightningAddress' || parsed?.type === 'lnurlPay') {
        kind = 'lightning_address';
        sat = amount();
        const payRequest = parsed.type === 'lightningAddress' ? parsed.payRequest : parsed;
        res = await breez.prepareLnurlPay({ amount: BigInt(sat), payRequest });
        feeSat = Number(res.feeSats ?? 0);
        lnurl = true;
      } else if (parsed?.type === 'crossChainAddress') {
        throw new UserError(422, 'That is a stablecoin address. Use Withdraw stablecoin.');
      } else {
        throw new UserError(422, 'Paste a Lightning invoice, Lightning address or Spark address');
      }
    } catch (e) {
      if (e instanceof UserError) throw e;
      throw new UserError(422, `Could not prepare this send: ${e?.message ?? e}`);
    }
    const s = await guard(sat + feeSat);
    await limits(input, satsToUsdCents(sat + feeSat, s.rate));
    const expiresAtMs = now() + PREPARE_TTL_MS;
    const view = {
      kind, destination: input, amountSat: sat, feeSat, totalSat: sat + feeSat,
      totalUsd: formatCents(satsToUsdCents(sat + feeSat, s.rate)), expiresAt: new Date(expiresAtMs).toISOString(),
    };
    return { kind, lnurl, res, view, expiresAtMs };
  }

  async function stableQuote({ adminId, routeId, address, amountUsd }) {
    const built = await buildStable({ routeId, address, amountUsd });
    const prepareId = remember({ adminId, ...built });
    await persist(prepareId, adminId, 'stablecoin', { routeId, address: built.view.destination, amountUsd: built.view.amountUsd }, built.view, built.expiresAtMs);
    return { prepareId, quoteId: prepareId, ...built.view };
  }

  async function buildStable({ routeId, address, amountUsd }) {
    const amountCents = parseAmountCents(amountUsd);
    if (amountCents === null) throw new UserError(400, 'Enter an amount in dollars and cents');
    const route = (await withdrawals.listRoutes()).find((r) => r.id === String(routeId ?? ''));
    if (!route) throw new UserError(422, 'That coin and network is not available right now');
    if (route.minUsdCents != null && amountCents < route.minUsdCents) throw new UserError(422, `The minimum for ${route.asset} on ${route.chain} is $${route.minUsd.toFixed(2)}`);
    if (route.maxUsdCents != null && amountCents > route.maxUsdCents) throw new UserError(422, `The maximum for ${route.asset} on ${route.chain} is $${route.maxUsd.toFixed(2)}`);
    const dest = await withdrawals.validateAddress(String(address ?? '').trim(), route.family);
    const rate = await btcUsdRate();
    const amountSat = usdCentsToSats(amountCents, rate, 'floor');
    await guard(amountSat);
    await limits(dest, amountCents);
    const q = await withdrawals.prepareCrossChain({
      route, address: dest, amountSat,
      lowBalanceMessage: 'The platform wallet does not hold enough sats for this send',
      failMessage: 'Could not quote this send', showDetail: true,
    });
    const view = {
      kind: 'stablecoin', destination: dest,
      route: { id: route.id, asset: q.pair.asset, chain: q.pair.chain, family: route.family, provider: q.pair.provider },
      amountUsd: (amountCents / 100).toFixed(2), amountSat, feeSat: 0, totalSat: amountSat, btcUsdRate: rate,
      providerFee: q.providerFee, receive: q.receive, receiveMin: q.receiveMin, asset: q.pair.asset,
      networkFeeUsd: networkFeeUsd(amountCents, q.estimatedOutBase, q.pair.decimals),
      expiresAt: new Date(q.expiresAtMs).toISOString(),
    };
    return { kind: 'stablecoin', lnurl: false, res: q.prepared, view, expiresAtMs: q.expiresAtMs - QUOTE_MARGIN_MS };
  }

  // The quote was made on another instance: prepare the same send here and
  // accept it only if it costs no more than 1% (and 1 sat) over the approved
  // total, and a stablecoin receive is not more than 1% lower.
  async function rebuild(prepareId, adminId, row) {
    const shown = row.view;
    const fresh = row.kind === 'stablecoin'
      ? await buildStable(row.request)
      : await buildSend(row.request);
    const v = fresh.view;
    const costlier = v.totalSat > Math.floor(shown.totalSat * 1.01) + 1 || (row.kind !== 'stablecoin' && v.amountSat !== shown.amountSat);
    const lessReceived = row.kind === 'stablecoin' && Number.isFinite(Number(shown.receive)) && Number(v.receive) < Number(shown.receive) * 0.99;
    if (fresh.kind !== row.kind || costlier || lessReceived) {
      log({ event: 'admin-send-requote-changed', prepareId, shownTotalSat: shown.totalSat, freshTotalSat: v.totalSat });
      throw new UserError(409, 'The quote changed since you reviewed it. Prepare the send again.');
    }
    log({ event: 'admin-send-requoted', prepareId, kind: row.kind });
    return { adminId, ...fresh, prepareId };
  }

  async function audit(adminId, action, prepareId, value) {
    await db.query(
      `insert into audit_log (actor_id, actor_email, action, subject_type, subject_id, new_value, note)
       values ($1, (select email from profiles where id = $1), $2, 'platform_wallet_send', $3, $4::jsonb, 'Platform wallet. No creator ledger change.')`,
      [adminId, action, prepareId, JSON.stringify(value)],
    );
  }

  async function run(p) {
    const v = p.view;
    await guard(v.totalSat);
    const usdCents = usdCentsOf(v);
    await limits(v.destination, usdCents);
    const record = { kind: v.kind, destination: v.destination, amountSat: v.amountSat, feeSat: v.feeSat, asset: v.asset ?? null, chain: v.route?.chain ?? null, amountUsd: v.amountUsd ?? null, usdCents };
    // Written before the send, so a send the process dies in the middle of
    // still has a trace.
    await audit(p.adminId, 'platform_wallet.send', p.prepareId, { status: 'sending', ...record });
    let payment;
    try {
      ({ payment } = await retryLeafErrors({
        breez, key: p.prepareId, now, sleep, log,
        deadlineMs: Math.min(now() + LEAF_RETRY_MS, p.expiresAtMs),
        attempt: () => (p.lnurl
          ? breez.lnurlPay({ prepareResponse: p.res, idempotencyKey: p.prepareId })
          : breez.sendPayment({ prepareResponse: p.res, idempotencyKey: p.prepareId })),
        existing: () => withdrawals.findPayment(p.prepareId),
      }));
    } catch (e) {
      const error = String(e?.message ?? e).slice(0, 300);
      await audit(p.adminId, 'platform_wallet.send.result', p.prepareId, { status: 'error', error, ...record }).catch(() => {});
      log({ event: 'admin-send-error', prepareId: p.prepareId, error });
      throw new UserError(502, `The send did not complete: ${error}`);
    }
    await audit(p.adminId, 'platform_wallet.send.result', p.prepareId, { status: payment.status, breezPaymentId: payment.id, ...record })
      .catch((e) => log({ event: 'admin-send-audit-failed', prepareId: p.prepareId, error: String(e?.message ?? e) }));
    log({ event: 'admin-send', prepareId: p.prepareId, kind: v.kind, status: payment.status });
    return { prepareId: p.prepareId, kind: v.kind, status: payment.status, payment: paymentView(payment) };
  }

  async function sendConfirm({ adminId, prepareId }) {
    const key = `${adminId}:${prepareId}`;
    if (inflight.has(key)) return inflight.get(key);
    const job = (async () => {
      const row = await claim(prepareId, adminId);
      const mem = prepared.get(prepareId);
      prepared.delete(prepareId);
      const expiresAtMs = mem?.adminId === adminId ? mem.expiresAtMs : Number(row.expires_ms);
      if (now() >= expiresAtMs) throw new UserError(409, 'The fee quote expired. Prepare the send again.');
      const p = mem?.adminId === adminId ? mem : await rebuild(prepareId, adminId, row);
      return track(run(p));
    })();
    inflight.set(key, job);
    job.then(
      () => setTimeout(() => inflight.delete(key), 60_000).unref?.(),
      () => inflight.delete(key),
    );
    return job;
  }

  async function fiat() {
    const [{ currencies }, { rates }] = await Promise.all([breez.listFiatCurrencies(), breez.listFiatRates()]);
    // Regtest lists some currencies (BGN, VES) at 0: no rate, not free.
    const byCoin = new Map(rates.filter((r) => r.value > 0).map((r) => [r.coin, r.value]));
    const list = currencies.map((c) => ({
      id: c.id, name: c.info?.name ?? c.id, symbol: c.info?.symbol?.grapheme ?? null,
      fractionSize: c.info?.fractionSize ?? 2, btcRate: byCoin.get(c.id) ?? null,
    })).sort((a, b) => (a.id === 'USD' ? -1 : b.id === 'USD' ? 1 : a.id.localeCompare(b.id)));
    return { currencies: list, rateCount: rates.length };
  }

  return { isAdmin, info, payments, receive, addresses, sendPrepare, sendConfirm, stableQuote, fiat, spendable };
}

// /admin/wallet/<action>, POST with {adminId, ...}. The edge function has
// already checked the caller is an admin; this checks again against the
// database, so a leaked service secret alone cannot move platform money.
export function createAdminWalletRoute({ wallet, withdrawals }) {
  const actions = {
    info: () => wallet.info(),
    payments: (b) => wallet.payments({ offset: b.offset, limit: b.limit }),
    receive: (b) => wallet.receive({ amountSat: b.amountSat, memo: b.memo }),
    addresses: () => wallet.addresses(),
    'send-prepare': (b) => wallet.sendPrepare({ adminId: b.adminId, destination: b.destination, amountSat: b.amountSat }),
    'send-confirm': (b) => {
      if (!UUID.test(String(b.prepareId))) throw new UserError(400, 'prepareId must be a uuid');
      return wallet.sendConfirm({ adminId: b.adminId, prepareId: b.prepareId });
    },
    'stable-routes': async () => ({ routes: await withdrawals.listRoutes(), cache: withdrawals.routeCacheInfo() }),
    'stable-quote': (b) => wallet.stableQuote({ adminId: b.adminId, routeId: b.routeId, address: b.address, amountUsd: b.amountUsd }),
    'stable-confirm': (b) => {
      if (!UUID.test(String(b.quoteId))) throw new UserError(400, 'quoteId must be a uuid');
      return wallet.sendConfirm({ adminId: b.adminId, prepareId: b.quoteId });
    },
    fiat: () => wallet.fiat(),
  };
  return async function route(method, url, body) {
    const m = /^\/admin\/wallet\/([a-z-]+)$/.exec(url);
    if (!m || !actions[m[1]]) return [404, { error: 'not found' }];
    if (method !== 'POST') return [405, { error: 'method not allowed' }];
    if (!(await wallet.isAdmin(body?.adminId))) return [403, { error: 'admin only' }];
    return [200, await actions[m[1]](body)];
  };
}
