// invoke sends Authorization + apikey. Raw fetch without apikey was 401 Unauthorized.
async function walletCall(action, body = {}) {
  const res = await callFunction('admin-actions', { action, ...body });
  if (!res.ok) throw new Error(res.message || 'The wallet did not answer');
  return res.data;
}

function walletShell() {
  return `<div class="grid kpis wallet-kpis">
      <div class="card"><div class="kicker">Wallet balance</div><div class="kpi" id="wbSats">-</div><div class="faint" id="wbUsd">Loading…</div></div>
      <div class="card"><div class="kicker">Owed to creators</div><div class="kpi" id="wbOwed">-</div><div class="faint" id="wbOwedSats"></div></div>
      <div class="card"><div class="kicker">Spendable</div><div class="kpi" id="wbSpend">-</div><div class="faint">Balance minus what creators are owed</div></div>
      <div class="card"><div class="kicker">Breez rate</div><div class="kpi" id="wbRate">-</div>
        <div class="row"><select id="wbCur" class="input sm-select" aria-label="Currency"></select><span class="faint" id="wbCurBal"></span></div></div>
    </div>
    <div class="withdraw">
      <div class="card">
        <h3>Send USDT from platform wallet</h3>
        <div class="field"><label for="wqNet">Coin and network</label><select id="wqNet"><option value="">Loading networks…</option></select></div>
        <div class="field"><label for="wqAddr">Destination address</label><input id="wqAddr" autocomplete="off" placeholder="Address"></div>
        <div class="field short"><label for="wqAmt">Amount (USD)</label><input id="wqAmt" type="number" min="1" step="0.01" inputmode="decimal" placeholder="0.00"></div>
        <p class="hint">Pays from the platform Breez wallet. Does not change a creator balance.</p>
        <button class="btn ghost" id="wqBtn">Get quote</button>
      </div>
      <div class="card summary">
        <h3>Quote</h3>
        <dl>
          <div><dt>Route</dt><dd id="wqRoute">-</dd></div>
          <div><dt>You send</dt><dd id="wqSend">-</dd></div>
          <div><dt>Breez and network fee</dt><dd id="wqFee">-</dd></div>
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
      <table class="table"><thead><tr><th>When</th><th>Type</th><th>Status</th><th class="num">Amount</th><th class="num">Fee</th><th>Details</th></tr></thead><tbody id="whRows"><tr><td colspan="6" class="empty">Loading…</td></tr></tbody></table>
      <div class="row wallet-pager"><button class="btn ghost sm" id="whPrev">Newer</button><button class="btn ghost sm" id="whNext">Older</button><span class="faint" id="whPage"></span></div>
    </div>`;
}

async function renderWallet() {
  const root = $w('wallet');
  root.innerHTML = walletShell();
  $w('wbCur').onchange = () => { walletState.currency = $w('wbCur').value; renderBalance(); };
  $w('wqBtn').onclick = getQuote;
  $w('wqGo').onclick = confirmQuote;
  for (const id of ['wqNet', 'wqAddr', 'wqAmt']) {
    $w(id).addEventListener('input', () => walletState.quote && clearQuote('Inputs changed. Get a new quote.'));
  }
  $w('whPrev').onclick = () => { walletState.page = Math.max(0, walletState.page - 1); loadHistory(); };
  $w('whNext').onclick = () => { walletState.page += 1; loadHistory(); };
  await Promise.all([loadInfo(), loadFiat(), loadHistory(), loadRoutes()]);
}
