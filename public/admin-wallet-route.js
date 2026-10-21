// Reads give up after 45 s. Sends wait longer than admin-actions' own 45 s
// send timeout, so its answer ("may still be going through, check the
// history") reaches the admin; a send the browser gives up on is never
// reported as "try again", because it may already have gone out.
const WALLET_TIMEOUT_MS = 45_000;
const WALLET_SEND_TIMEOUT_MS = 60_000;
const WALLET_SENDS = new Set(['send-confirm', 'stable-confirm']);

async function walletFetch(path, payload) {
  const { data: sess } = await window.supabaseClient.auth.getSession();
  const token = sess?.session?.access_token;
  if (!token) throw new Error('Sign in again');
  const sends = WALLET_SENDS.has(payload?.action);
  const res = await fetch(`${window.SUPABASE_URL}/functions/v1/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: window.SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(payload),
    // A wallet handoff can take ~15 s; never leave a card waiting forever.
    // Guard: frontend tests run this file in a bare vm.Context with no
    // AbortSignal, and very old browsers lack AbortSignal.timeout.
    ...(typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? { signal: AbortSignal.timeout(sends ? WALLET_SEND_TIMEOUT_MS : WALLET_TIMEOUT_MS) }
      : {}),
  }).catch((e) => {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    // A send that did not answer may still have gone out: never invite a blind retry.
    if (sends) throw new Error('The send may still be going through. Check the history before trying again.');
    throw new Error(timedOut ? 'The wallet took too long to answer. Try again.' : 'Could not reach the wallet. Check your connection and try again.');
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || data.message || `Wallet HTTP ${res.status}`);
    err.status = res.status;
    if (typeof data.code === 'string') err.code = data.code;
    throw err;
  }
  return data;
}

// The wallet lives at the admin-actions /admin-wallet route. The bare
// admin-actions root has no handler and answers 404, so the call goes
// straight to the route (no root probe and fallback).
const WALLET_ROUTE = 'admin-actions/admin-wallet';

async function walletCall(action, body = {}) {
  const run = () => walletFetch(WALLET_ROUTE, { action, ...body });
  // Sends ask for the password again when the last sign-in is not recent.
  if ((action === 'send-confirm' || action === 'stable-confirm') && window.cpayWithStepUp) return window.cpayWithStepUp(run);
  return run();
}

function walletShell() {
  return `<div class="grid kpis wallet-kpis">
      <div class="card"><div class="kicker">Wallet balance</div><div class="kpi" id="wbSats">-</div><div class="faint" id="wbUsd">Loading…</div></div>
      <div class="card"><div class="kicker">Owed to freelancers</div><div class="kpi" id="wbOwed">-</div><div class="faint" id="wbOwedSats"></div></div>
      <div class="card"><div class="kicker">Spendable</div><div class="kpi" id="wbSpend">-</div><div class="faint">Balance minus what freelancers are owed</div></div>
      <div class="card"><div class="kicker">Wallet rate</div><div class="kpi" id="wbRate">-</div>
        <div class="faint" id="wbCurBal"></div></div>
    </div>
    <div class="withdraw">
      <div class="card">
        <h3>Send USDT from platform wallet</h3>
        <div class="field"><label for="wqNet">Coin and network</label><select id="wqNet"><option value="">Loading networks…</option></select></div>
        <div class="field"><label for="wqAddr">Destination address</label><input id="wqAddr" autocomplete="off" placeholder="Address"></div>
        <div class="field short"><label for="wqAmt">Amount (USD)</label><input id="wqAmt" type="number" min="1" step="0.01" inputmode="decimal" placeholder="0.00"></div>
        <p class="hint">Pays from the platform wallet. Does not change a freelancer balance.</p>
        <button class="btn ghost" id="wqBtn">Get quote</button>
      </div>
      <div class="card summary">
        <h3>Quote</h3>
        <dl>
          <div><dt>Route</dt><dd id="wqRoute">-</dd></div>
          <div><dt>You send</dt><dd id="wqSend">-</dd></div>
          <div><dt>Route and network fee</dt><dd id="wqFee">-</dd></div>
          <div><dt>Provider fee</dt><dd id="wqProv">-</dd></div>
          <div><dt>At least (1% slippage)</dt><dd id="wqMin">-</dd></div>
          <div class="total"><dt>Arrives</dt><dd id="wqGet">-</dd></div>
        </dl>
        <p class="faint" id="wqNote">Pick a network and enter an address and amount.</p>
        <button class="btn primary block" id="wqGo" disabled>Confirm withdrawal</button>
      </div>
    </div>
    <div class="card flush">
      <h3>History</h3>
      <div class="table-wrap"><table class="table stack-sm"><thead><tr><th>When</th><th>Type</th><th>Status</th><th class="num">Amount</th><th class="num">Fee</th><th>Details</th></tr></thead><tbody id="whRows"><tr><td colspan="6" class="empty">Loading…</td></tr></tbody></table></div>
      <div class="row wallet-pager"><button class="btn ghost sm" id="whPrev">Newer</button><button class="btn ghost sm" id="whNext">Older</button><span class="faint" id="whPage"></span></div>
    </div>`;
}

async function renderWallet() {
  const root = $w('wallet');
  root.innerHTML = walletShell();
  walletState.currency = window.cpayCurrency ? window.cpayCurrency.get() : 'USD';
  document.addEventListener('cpay:currency', (e) => { walletState.currency = e.detail.code; renderBalance(); });
  $w('wqBtn').onclick = getQuote;
  $w('wqGo').onclick = confirmQuote;
  for (const id of ['wqNet', 'wqAddr', 'wqAmt']) {
    $w(id).addEventListener('input', () => walletState.quote && clearQuote('Inputs changed. Get a new quote.'));
  }
  $w('whPrev').onclick = () => { walletState.page = Math.max(0, walletState.page - 1); loadHistory(); };
  $w('whNext').onclick = () => { walletState.page += 1; loadHistory(); };
  // Each loader shows its own error in its card; one failing never blanks the rest.
  await Promise.allSettled([loadInfo(), loadFiat(), loadHistory(), loadRoutes()]);
}
