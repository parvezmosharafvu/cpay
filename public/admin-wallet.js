// Admin Wallet tab: the platform's own Lightning wallet. Every call goes
// through admin-actions/admin-wallet, which checks the caller is an admin
// and forwards to the payment service. Sends only spend what the wallet
// holds beyond what is owed to creators; the service enforces that.
// The route, not the bare admin-actions root (that answers 404).
// admin-wallet-route.js, loaded after this file, replaces walletCall.
const WALLET_FN = 'admin-actions/admin-wallet';
const walletState = { info: null, fiat: [], currency: 'USD', page: 0, pageSize: 10, prepared: null, quote: null, routes: [] };

const $w = (id) => document.getElementById(id);
const sats = (n) => (n == null ? '-' : `${Number(n).toLocaleString('en-US')} sats`);

async function walletCall(action, body = {}) {
  const res = await callFunction(WALLET_FN, { action, ...body });
  if (!res.ok) throw new Error(res.message || 'The wallet did not answer');
  return res.data;
}

function fiatValue(satAmount, cur) {
  const rate = cur?.btcRate;
  if (!rate || satAmount == null) return null;
  const v = (Number(satAmount) * rate) / 1e8;
  const digits = cur.fractionSize ?? 2;
  return `${cur.symbol || ''}${v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${cur.id}`;
}

function walletShell() {
  return `<div class="grid kpis wallet-kpis">
      <div class="card"><div class="kicker">Wallet balance</div><div class="kpi" id="wbSats">-</div><div class="faint" id="wbUsd">Loading…</div></div>
      <div class="card"><div class="kicker">Owed to freelancers</div><div class="kpi" id="wbOwed">-</div><div class="faint" id="wbOwedSats"></div></div>
      <div class="card"><div class="kicker">Spendable</div><div class="kpi" id="wbSpend">-</div><div class="faint">Balance minus what freelancers are owed</div></div>
      <div class="card"><div class="kicker">Wallet rate</div><div class="kpi" id="wbRate">-</div>
        <div class="row"><select id="wbCur" class="input sm-select" aria-label="Currency"></select><span class="faint" id="wbCurBal"></span></div></div>
    </div>
    <div class="grid split">
      <div class="card">
        <h3>Receive</h3>
        <div class="row wallet-pair">
          <div class="field"><label for="wrAmt">Amount (sats)</label><input id="wrAmt" type="number" min="1" step="1" inputmode="numeric" placeholder="10000"></div>
          <div class="field"><label for="wrMemo">Memo</label><input id="wrMemo" maxlength="200" placeholder="What it is for"></div>
        </div>
        <button class="btn primary" id="wrBtn">Create invoice</button>
        <div class="wallet-invoice" id="wrOut" hidden>
          <div class="qr-frame"><div id="wrQr"></div></div>
          <div class="mono wallet-code" id="wrText"></div>
          <div class="row"><button class="btn ghost sm" id="wrCopy">Copy invoice</button><span class="faint" id="wrMeta"></span></div>
        </div>
        <dl class="wallet-addrs" id="wrAddrs"><div><dt>Spark address</dt><dd class="faint">Loading…</dd></div></dl>
      </div>
      <div class="card">
        <h3>Send</h3>
        <div class="field"><label for="wsDest">To</label><input id="wsDest" placeholder="Lightning invoice, Lightning address or Spark address" autocomplete="off"></div>
        <div class="field short"><label for="wsAmt">Amount (sats)</label><input id="wsAmt" type="number" min="1" step="1" inputmode="numeric" placeholder="Not needed for an invoice with an amount"></div>
        <button class="btn ghost" id="wsPrep">Preview fee</button>
        <div class="summary wallet-review" id="wsReview" hidden>
          <dl>
            <div><dt>Type</dt><dd id="wsKind"></dd></div>
            <div><dt>Amount</dt><dd id="wsAmount"></dd></div>
            <div><dt>Route fee</dt><dd id="wsFee"></dd></div>
            <div class="total"><dt>Total</dt><dd id="wsTotal"></dd></div>
          </dl>
          <p class="faint" id="wsNote"></p>
          <div class="row"><button class="btn primary" id="wsGo">Confirm send</button><button class="btn ghost" id="wsCancel">Cancel</button></div>
        </div>
      </div>
    </div>
    <div class="withdraw">
      <div class="card">
        <h3>Withdraw stablecoin</h3>
        <div class="field"><label for="wqNet">Coin and network</label><select id="wqNet"><option value="">Loading networks…</option></select></div>
        <div class="field"><label for="wqAddr">Destination address</label><input id="wqAddr" autocomplete="off" placeholder="Address"></div>
        <div class="field short"><label for="wqAmt">Amount (USD)</label><input id="wqAmt" type="number" min="1" step="0.01" inputmode="decimal" placeholder="0.00"></div>
        <p class="hint">Paid from the platform wallet through the same payout route and quote as freelancer withdrawals. No freelancer balance changes.</p>
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
      <table class="table"><thead><tr><th>When</th><th>Type</th><th>Status</th><th class="num">Amount</th><th class="num">Fee</th><th>Details</th></tr></thead><tbody id="whRows"><tr><td colspan="6" class="empty">Loading…</td></tr></tbody></table>
      <div class="row wallet-pager"><button class="btn ghost sm" id="whPrev">Newer</button><button class="btn ghost sm" id="whNext">Older</button><span class="faint" id="whPage"></span></div>
    </div>`;
}

function renderBalance() {
  const i = walletState.info;
  if (!i) return;
  const cur = walletState.fiat.find((c) => c.id === walletState.currency);
  $w('wbSats').textContent = sats(i.balanceSats);
  $w('wbUsd').textContent = i.balanceUsd != null ? `${money(i.balanceUsd)} at the wallet rate` : (i.rateError || 'No rate');
  $w('wbOwed').textContent = money(i.owedToCreatorsUsd);
  $w('wbOwedSats').textContent = i.owedToCreatorsSat != null ? `${sats(i.owedToCreatorsSat)} held for freelancers` : '';
  $w('wbSpend').textContent = sats(i.spendableSat);
  $w('wbRate').textContent = cur?.btcRate ? `${fiatValue(1e8, cur)}` : (i.btcUsdRate ? `$${Number(i.btcUsdRate).toLocaleString('en-US')}` : '-');
  $w('wbCurBal').textContent = cur ? `per BTC · balance ${fiatValue(i.balanceSats, cur) ?? 'no rate'}` : 'per BTC';
}

async function loadInfo() {
  try { walletState.info = await walletCall('info'); renderBalance(); }
  catch (e) { $w('wbUsd').textContent = e.message; }
}

async function loadFiat() {
  try {
    const { currencies } = await walletCall('fiat');
    walletState.fiat = currencies;
    $w('wbCur').innerHTML = currencies.map((c) => `<option value="${escapeHtml(c.id)}"${c.btcRate ? '' : ' disabled'}>${escapeHtml(c.id)} · ${escapeHtml(c.name)}</option>`).join('');
    $w('wbCur').value = walletState.currency;
    renderBalance();
  } catch (e) { $w('wbCurBal').textContent = e.message; }
}

async function loadAddresses() {
  try {
    const a = await walletCall('addresses');
    const rows = [['Spark address', a.sparkAddress], ['Lightning address', a.lightningAddress]]
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${v ? `<span class="mono">${escapeHtml(v)}</span> <button class="btn ghost sm" data-copy="${escapeHtml(v)}">Copy</button>` : '<span class="faint">Not registered</span>'}</dd></div>`).join('');
    $w('wrAddrs').innerHTML = rows;
  } catch (e) { $w('wrAddrs').innerHTML = `<div><dt>Addresses</dt><dd class="err">${escapeHtml(e.message)}</dd></div>`; }
}

function paymentDetails(p) {
  return escapeHtml(p.description || p.lightningAddress || (p.invoice ? shortAddress(p.invoice) : '') || p.method || '');
}

async function loadHistory() {
  const { page, pageSize } = walletState;
  try {
    const r = await walletCall('payments', { offset: page * pageSize, limit: pageSize });
    $w('whRows').innerHTML = r.payments.map((p) => `<tr>
        <td>${escapeHtml(when(p.at))}</td><td>${p.type === 'send' ? 'Sent' : 'Received'}</td><td>${badge(p.status)}</td>
        <td class="num">${p.type === 'send' ? '−' : '+'}${Number(p.amountSat).toLocaleString('en-US')}</td>
        <td class="num">${Number(p.feeSat).toLocaleString('en-US')}</td><td class="mono">${paymentDetails(p)}</td></tr>`).join('')
      || '<tr><td colspan="6" class="empty">No payments yet</td></tr>';
    $w('whPrev').disabled = page === 0;
    $w('whNext').disabled = !r.hasMore;
    $w('whPage').textContent = r.payments.length ? `Page ${page + 1}` : '';
  } catch (e) { $w('whRows').innerHTML = `<tr><td colspan="6" class="empty err">${escapeHtml(e.message)}</td></tr>`; }
}

function drawQr(text) {
  const box = $w('wrQr');
  box.innerHTML = '';
  if (typeof QRCode === 'undefined') { box.textContent = 'QR code could not load. Copy the invoice instead.'; return; }
  new QRCode(box, { text, width: 220, height: 220, colorDark: '#000000', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
}

async function createInvoice() {
  const btn = $w('wrBtn');
  btn.disabled = true;
  try {
    const inv = await walletCall('receive', { amountSat: $w('wrAmt').value.trim(), memo: $w('wrMemo').value });
    $w('wrOut').hidden = false;
    drawQr(inv.bolt11);
    $w('wrText').textContent = inv.bolt11;
    $w('wrMeta').textContent = `${sats(inv.amountSat)} · expires ${when(inv.expiresAt)}`;
  } catch (e) { toast(e.message); }
  btn.disabled = false;
}

const KIND_LABEL = { lightning: 'Lightning invoice', lightning_address: 'Lightning address', spark: 'Spark address', stablecoin: 'Stablecoin' };

async function prepareSend() {
  const btn = $w('wsPrep');
  btn.disabled = true;
  walletState.prepared = null;
  $w('wsReview').hidden = true;
  try {
    const p = await walletCall('send-prepare', { destination: $w('wsDest').value.trim(), amountSat: $w('wsAmt').value.trim() || undefined });
    walletState.prepared = p;
    $w('wsKind').textContent = KIND_LABEL[p.kind] || p.kind;
    $w('wsAmount').textContent = sats(p.amountSat);
    $w('wsFee').textContent = sats(p.feeSat);
    $w('wsTotal').textContent = `${sats(p.totalSat)} · ${money(p.totalUsd)}`;
    $w('wsNote').textContent = `To ${shortAddress(p.destination)}. The fee holds until ${when(p.expiresAt)}.`;
    $w('wsReview').hidden = false;
  } catch (e) { toast(e.message); }
  btn.disabled = false;
}

async function confirmSend() {
  const p = walletState.prepared;
  if (!p) return;
  const btn = $w('wsGo');
  btn.disabled = true;
  try {
    const r = await walletCall('send-confirm', { prepareId: p.prepareId });
    toast(`Send ${r.status}`, r.status !== 'failed');
    walletState.prepared = null;
    $w('wsReview').hidden = true;
    $w('wsDest').value = ''; $w('wsAmt').value = '';
    refreshWallet();
  } catch (e) { toast(e.message); }
  btn.disabled = false;
}

function clearQuote(note) {
  walletState.quote = null;
  for (const id of ['wqRoute', 'wqSend', 'wqFee', 'wqProv', 'wqMin', 'wqGet']) $w(id).textContent = '-';
  $w('wqGo').disabled = true;
  if (note) $w('wqNote').textContent = note;
}

async function loadRoutes() {
  try {
    const { routes } = await walletCall('stable-routes');
    walletState.routes = routes;
    $w('wqNet').innerHTML = routes.length
      ? routes.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.asset)} · ${escapeHtml(chainLabel(r.chain))}</option>`).join('')
      : '<option value="">No networks available right now</option>';
    if (!routes.length) clearQuote('The wallet lists no stablecoin networks right now. They exist on mainnet only.');
  } catch (e) { clearQuote(e.message); }
}

async function getQuote() {
  const btn = $w('wqBtn');
  btn.disabled = true;
  clearQuote('Getting a quote…');
  try {
    const q = await walletCall('stable-quote', { routeId: $w('wqNet').value, address: $w('wqAddr').value.trim(), amountUsd: $w('wqAmt').value.trim() });
    walletState.quote = q;
    $w('wqRoute').textContent = `${q.asset} · ${chainLabel(q.route.chain)}`;
    $w('wqSend').textContent = `${money(q.amountUsd)} · ${sats(q.amountSat)}`;
    $w('wqFee').textContent = money(q.networkFeeUsd);
    $w('wqProv').textContent = `${q.providerFee.amount} ${q.providerFee.asset}`;
    $w('wqMin').textContent = `${q.receiveMin} ${q.asset}`;
    $w('wqGet').textContent = `${q.receive} ${q.asset}`;
    $w('wqNote').textContent = `To ${shortAddress(q.destination)}. Quote valid until ${when(q.expiresAt)}.`;
    $w('wqGo').disabled = false;
  } catch (e) { clearQuote(e.message); }
  btn.disabled = false;
}

async function confirmQuote() {
  const q = walletState.quote;
  if (!q) return;
  $w('wqGo').disabled = true;
  try {
    const r = await walletCall('stable-confirm', { quoteId: q.quoteId });
    toast(`Withdrawal ${r.status}`, r.status !== 'failed');
    clearQuote('Sent. It shows in the history below.');
    refreshWallet();
  } catch (e) { toast(e.message); $w('wqGo').disabled = false; }
}

function refreshWallet() { loadInfo(); loadHistory(); }

async function renderWallet() {
  const root = $w('wallet');
  root.innerHTML = walletShell();
  root.addEventListener('click', async (e) => {
    const v = e.target.closest('[data-copy]')?.dataset.copy;
    if (v) { try { await navigator.clipboard.writeText(v); toast('Copied', true); } catch { toast('Could not copy'); } }
  });
  $w('wbCur').onchange = () => { walletState.currency = $w('wbCur').value; renderBalance(); };
  $w('wrBtn').onclick = createInvoice;
  $w('wrCopy').onclick = async () => { try { await navigator.clipboard.writeText($w('wrText').textContent); toast('Invoice copied', true); } catch { toast('Could not copy'); } };
  $w('wsPrep').onclick = prepareSend;
  $w('wsGo').onclick = confirmSend;
  $w('wsCancel').onclick = () => { walletState.prepared = null; $w('wsReview').hidden = true; };
  $w('wsDest').oninput = () => { walletState.prepared = null; $w('wsReview').hidden = true; };
  $w('wqBtn').onclick = getQuote;
  $w('wqGo').onclick = confirmQuote;
  for (const id of ['wqNet', 'wqAddr', 'wqAmt']) $w(id).addEventListener('input', () => walletState.quote && clearQuote('Inputs changed. Get a new quote.'));
  $w('whPrev').onclick = () => { walletState.page = Math.max(0, walletState.page - 1); loadHistory(); };
  $w('whNext').onclick = () => { walletState.page += 1; loadHistory(); };
  await Promise.all([loadInfo(), loadFiat(), loadAddresses(), loadHistory(), loadRoutes()]);
}
