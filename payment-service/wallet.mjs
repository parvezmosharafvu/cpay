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

  async function isAdmin(adminId) {
    if (!UUID.test(String(adminId))) return false;
    const { rows } = await db.query(`select role from profiles where id = $1`, [adminId]);
    return rows[0]?.role === 'admin';
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

  async function sendPrepare({ adminId, destination, amountSat }) {
    const input = String(destination ?? '').trim();
    if (!input) throw new UserError(400, 'Paste a Lightning invoice, Lightning address or Spark address');
    let parsed;
    try { parsed = await breez.parse(input); } catch { parsed = null; }
    const amount = () => wholeSats(amountSat);
    let kind, res, sat, feeSat, lnurl = false;
    try {
      if (parsed?.type === 'bolt11Invoice') {
        kind = 'lightning';
        const fixed = parsed.amountMsat ? Math.ceil(parsed.amountMsat / 1000) : null;
        sat = fixed ?? amount();
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
    const expiresAtMs = now() + PREPARE_TTL_MS;
    const view = {
      kind, destination: input, amountSat: sat, feeSat, totalSat: sat + feeSat,
      totalUsd: formatCents(satsToUsdCents(sat + feeSat, s.rate)), expiresAt: new Date(expiresAtMs).toISOString(),
    };
    const prepareId = remember({ adminId, kind, lnurl, res, view, expiresAtMs });
    return { prepareId, ...view };
  }

  async function stableQuote({ adminId, routeId, address, amountUsd }) {
    const amountCents = parseAmountCents(amountUsd);
    if (amountCents === null) throw new UserError(400, 'Enter an amount in dollars and cents');
    const route = (await withdrawals.listRoutes()).find((r) => r.id === String(routeId ?? ''));
    if (!route) throw new UserError(422, 'That coin and network is not available right now');
    if (route.minUsdCents != null && amountCents < route.minUsdCents) throw new UserError(422, `The minimum for ${route.asset} on ${route.chain} is $${formatCents(route.minUsdCents)}`);
    if (route.maxUsdCents != null && amountCents > route.maxUsdCents) throw new UserError(422, `The maximum for ${route.asset} on ${route.chain} is $${formatCents(route.maxUsdCents)}`);
    const dest = await withdrawals.validateAddress(String(address ?? '').trim(), route.family);
    const rate = await btcUsdRate();
    const amountSat = usdCentsToSats(amountCents, rate, 'floor');
    await guard(amountSat);
    const q = await withdrawals.prepareCrossChain({
      route, address: dest, amountSat,
      lowBalanceMessage: 'The platform wallet does not hold enough sats for this send',
      failMessage: 'Could not quote this send', showDetail: true,
    });
    const view = {
      kind: 'stablecoin', destination: dest,
      route: { id: route.id, asset: q.pair.asset, chain: q.pair.chain, family: route.family, provider: q.pair.provider },
      amountUsd: formatCents(amountCents), amountSat, feeSat: 0, totalSat: amountSat, btcUsdRate: rate,
      providerFee: q.providerFee, receive: q.receive, receiveMin: q.receiveMin, asset: q.pair.asset,
      networkFeeUsd: networkFeeUsd(amountCents, q.estimatedOutBase, q.pair.decimals),
      expiresAt: new Date(q.expiresAtMs).toISOString(),
    };
    const prepareId = remember({ adminId, kind: 'stablecoin', lnurl: false, res: q.prepared, view, expiresAtMs: q.expiresAtMs - QUOTE_MARGIN_MS });
    return { prepareId, quoteId: prepareId, ...view };
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
    const record = { kind: v.kind, destination: v.destination, amountSat: v.amountSat, feeSat: v.feeSat, asset: v.asset ?? null, chain: v.route?.chain ?? null, amountUsd: v.amountUsd ?? null };
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
    if (inflight.has(prepareId)) return inflight.get(prepareId);
    const p = prepared.get(prepareId);
    if (!p || p.adminId !== adminId) throw new UserError(404, 'Nothing to confirm. Prepare the send again.');
    if (now() >= p.expiresAtMs) {
      prepared.delete(prepareId);
      throw new UserError(409, 'The fee quote expired. Prepare the send again.');
    }
    prepared.delete(prepareId);
    const job = track(run(p)).finally(() => setTimeout(() => inflight.delete(prepareId), 60_000).unref?.());
    inflight.set(prepareId, job);
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
