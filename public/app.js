function $(id){ return document.getElementById(id); }
function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function money(n){ return '$' + Number(n ?? 0).toFixed(2); }
function when(ts){ return ts ? new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : ''; }
// A link with no design of its own uses the site's default design.
function layoutLabel(theme){
  const meta = window.CPAY_LAYOUTS[resolveDesign(theme)];
  return meta ? meta.label : 'Site default';
}
function badge(status){
  const s = String(status || '').toLowerCase();
  return `<span class="badge ${escapeHtml(s)}">${escapeHtml(s || 'unknown')}</span>`;
}
function toast(msg, ok){
  const el = $('toast');
  if (!el) return alert(msg);
  el.textContent = msg;
  el.classList.toggle('ok', !!ok);
  el.style.display = 'block';
}
async function requireSession(){
  const { data: { session } } = await window.supabaseClient.auth.getSession();
  if (!session) { location.href = 'login.html'; return null; }
  return session;
}
async function loadProfile(){
  const session = await requireSession();
  if (!session) return null;
  const { data, error } = await window.supabaseClient.from('profiles')
    .select('*').eq('id', session.user.id).single();
  if (error || !data) { location.href = 'login.html'; return null; }
  if (data.account_status && data.account_status !== 'active') {
    await window.supabaseClient.auth.signOut();
    location.href = 'login.html';
    return null;
  }
  window.CPAY_PROFILE = data;
  return data;
}
function roleHome(role){
  if (role === 'admin') return 'admin.html';
  if (role === 'moderator') return 'reseller.html';
  return 'dashboard.html';
}
async function signOut(){
  await window.supabaseClient.auth.signOut();
  location.href = 'login.html';
}
// Invoice designs the database accepts (payment_links.invoice_theme). Each
// one other than 'default' shows the invoice in one of the ten designs.
const INVOICE_CHOICES = [
  ['default', 'Same as payment page'],
  ['compact', 'Ledger'],
  ['poster', 'Tile'],
  ['night', 'Focus'],
  ['cashier', 'Receipt'],
];
function layoutPicker(selected, wallet, invoice){
  const layouts = window.CPAY_LAYOUTS || {};
  const layoutHtml = Object.entries(layouts).map(([id, meta]) =>
    `<button type="button" class="design ${id===selected?'on':''}" data-theme="${id}"><span class="swatch" data-layout="${id}" aria-hidden="true"></span><span>${escapeHtml(meta.label)}<span class="faint">${escapeHtml(meta.help)}</span></span></button>`
  ).join('');
  const invoiceHtml = INVOICE_CHOICES.map(([id, label]) =>
    `<button type="button" class="pill ${id===(invoice||'default')?'active':''}" data-invoice="${id}">${escapeHtml(label)}</button>`
  ).join('');
  return `
    <div class="field"><label>Payment page design <a class="design-preview" href="theme-preview.html?theme=${encodeURIComponent(selected || 'keypad')}" target="_blank" rel="noopener">Preview all designs</a></label><div class="designs" id="themePick">${layoutHtml}</div></div>
    <div class="field"><label>Invoice page design</label><div class="row" id="invoicePick">${invoiceHtml}</div></div>
    <div class="field"><label>Who can pay</label>
      <div class="row">
        <button type="button" class="pill ${wallet==='cashapp'?'active':''}" data-wallet="cashapp">Cash App only</button>
        <button type="button" class="pill ${wallet!=='cashapp'?'active':''}" data-wallet="all_wallets">Cash App and any Lightning wallet</button>
      </div>
    </div>`;
}
function bindExperience(state){
  document.querySelectorAll('#themePick .design').forEach(btn => {
    btn.onclick = () => {
      state.theme = btn.dataset.theme;
      document.querySelectorAll('#themePick .design').forEach(b => b.classList.toggle('on', b===btn));
      const preview = document.querySelector('.design-preview');
      if (preview) preview.href = 'theme-preview.html?theme=' + encodeURIComponent(state.theme);
    };
  });
  document.querySelectorAll('#invoicePick [data-invoice]').forEach(btn => {
    btn.onclick = () => {
      state.invoice = btn.dataset.invoice;
      document.querySelectorAll('#invoicePick [data-invoice]').forEach(b => b.classList.toggle('active', b===btn));
    };
  });
  document.querySelectorAll('[data-wallet]').forEach(btn => {
    btn.onclick = () => {
      state.wallet = btn.dataset.wallet;
      document.querySelectorAll('[data-wallet]').forEach(b => b.classList.toggle('active', b===btn));
    };
  });
}

/* ---------- withdraw form ----------
   'stablecoin' is sent at once through the payment service (user-withdraw
   routes/quote/confirm). The other keys are withdrawals.method codes that
   request_withdrawal queues for an admin. */
const WITHDRAW_METHODS = {
  stablecoin: { label: 'USDT / USDC (instant)', instant: true,
    note: 'Sent as soon as you confirm. Coins sent to an address on another network can be lost.' },
  bkash: { label: 'bKash', placeholder: 'bKash number', note: 'Sent after an admin approves the request.' },
  nagad: { label: 'Nagad', placeholder: 'Nagad number', note: 'Sent after an admin approves the request.' },
  binance: { label: 'Binance Pay', placeholder: 'Binance Pay ID', note: 'Sent after an admin approves the request.' },
  lightning: { label: 'Lightning', placeholder: 'you@wallet.com', note: 'Sent after an admin approves the request.' },
  bank: { label: 'Bank transfer', placeholder: 'Bank, account name and number', note: 'Sent after an admin approves the request.' },
};
// Names for the chains instant withdrawals reach today. A chain added later
// still shows, under its own name.
const CHAIN_LABELS = {
  tron: 'Tron (TRC-20)', bsc: 'BNB Smart Chain (BEP-20)', ethereum: 'Ethereum (ERC-20)', arbitrum: 'Arbitrum One',
  solana: 'Solana', base: 'Base', polygon: 'Polygon', optimism: 'Optimism', avalanche: 'Avalanche C-Chain',
};
const ADDRESS_PLACEHOLDER = { evm: '0x... address', tron: 'T... address', solana: 'Solana address' };
function chainLabel(chain){
  const c = String(chain || '');
  return CHAIN_LABELS[c.toLowerCase()] || (c.charAt(0).toUpperCase() + c.slice(1));
}

// Label for a withdrawals row. usdt_bep20 rows predate instant withdrawals.
function methodLabel(code, row){
  if (code === 'stablecoin') return row?.coin ? `${row.coin} · ${chainLabel(row.chain)} (instant)` : 'Stablecoin (instant)';
  if (code === 'usdt_bep20') return 'USDT (BNB Smart Chain, BEP-20)';
  const m = WITHDRAW_METHODS[code];
  return m ? m.label : code;
}

// Same rounding as request_withdrawal(): amount_after_fee = round(amount * (1 - fee/100), 2).
function withdrawQuote(amount, feePercent){
  if (!(amount > 0) || !Number.isFinite(feePercent)) return null;
  const receive = Math.round(amount * (100 - feePercent) + 1e-6) / 100;
  return { fee: Math.round((amount - receive) * 100) / 100, receive };
}

// An exact decimal string as dollars: at least two decimals, and every
// further digit the amount has (network fees are exact to the coin's unit).
function usdExact(v){
  const s = String(v ?? '0');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return money(v);
  const [whole, frac = ''] = s.replace(/^-/, '').split('.');
  const digits = (frac + '00').slice(0, Math.max(2, frac.replace(/0+$/, '').length));
  return `$${whole}.${digits}`;
}

// Edge function call that keeps the JSON body of an error response, which
// carries the message (and, for an expired quote, the new quote).
async function callFunction(name, body){
  const { data, error } = await window.supabaseClient.functions.invoke(name, { body });
  if (!error) return { ok: true, data };
  let payload = null;
  try { payload = await error.context.json(); } catch { payload = null; }
  return { ok: false, status: error.context?.status, data: payload, message: payload?.error || error.message };
}

function withdrawForm(whoHtml){
  const options = Object.entries(WITHDRAW_METHODS)
    .map(([id, m]) => `<option value="${id}">${escapeHtml(m.label)}</option>`).join('');
  return `<div class="withdraw">
    <div class="card">
      <h3>Withdraw</h3>
      <div class="who">${whoHtml}</div>
      <div class="field"><label for="wMethod">Method</label><select id="wMethod">${options}</select></div>
      <div class="field" id="wNetField"><label for="wNet">Coin and network</label><select id="wNet"></select></div>
      <div class="field"><label for="wAmt">Amount (USD)</label><input id="wAmt" type="number" min="5" step="0.01" inputmode="decimal" placeholder="0.00"></div>
      <div class="field"><label for="wDest" id="wDestLabel">Destination</label><input id="wDest" autocomplete="off" spellcheck="false"></div>
      <p class="hint" id="wHint"></p>
    </div>
    <aside class="card summary" aria-live="polite">
      <h3>Review</h3>
      <dl>
        <div><dt>Method</dt><dd id="sumMethod">-</dd></div>
        <div><dt>Amount</dt><dd id="sumAmount">$0.00</dd></div>
        <div id="sumFeeRow" hidden><dt id="sumFeeLabel">Platform fee</dt><dd id="sumFee">$0.00</dd></div>
        <div id="sumNetRow" hidden><dt>Network fee</dt><dd id="sumNet">-</dd></div>
        <div id="sumToRow" hidden><dt>To</dt><dd id="sumTo">-</dd></div>
        <div class="total"><dt>You receive</dt><dd id="sumGet">$0.00</dd></div>
      </dl>
      <p class="faint" id="sumNote"></p>
      <button class="btn primary block lg" id="wBtn" type="button">Confirm withdrawal</button>
    </aside>
  </div>`;
}

let withdrawRoutes = null;
async function loadWithdrawRoutes(){
  if (withdrawRoutes) return withdrawRoutes;
  const r = await callFunction('user-withdraw', { action: 'routes' });
  if (!r.ok) return { routes: [], error: r.message || 'Could not load networks' };
  withdrawRoutes = { routes: r.data?.routes || [], error: null };
  return withdrawRoutes;
}

function shortAddress(a){ return a && a.length > 16 ? `${a.slice(0, 8)}...${a.slice(-6)}` : (a || ''); }

// feePercent() returns the fee for the account being paid out, or null when
// this page cannot know it. submitManual() sends a manual request and
// returns true when it went through. instantAllowed() says whether this page
// may send a stablecoin withdrawal for the selected account. onDone() runs
// after any withdrawal so the page can refresh balances. blocked, when set,
// is a note to show instead: the form stays visible but nothing can be sent
// (a freelancer whose reseller handles withdrawals). The server refuses
// those requests too.
function bindWithdraw(feePercent, { submitManual, instantAllowed = () => true, teamPayout = () => false, onDone = () => {}, blocked = null } = {}){
  let routes = { routes: [], error: null, loading: true };
  let quote = null;
  let busy = false;
  let timer = null;

  const method = () => WITHDRAW_METHODS[$('wMethod').value];
  const route = () => routes.routes.find((r) => r.id === $('wNet').value);
  const expiresIn = () => (quote ? Math.max(0, Math.floor((Date.parse(quote.expiresAt) - Date.now()) / 1000)) : 0);

  const fillNetworks = () => {
    const keep = $('wNet').value;
    $('wNet').innerHTML = routes.routes.length
      ? routes.routes.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.asset)} · ${escapeHtml(chainLabel(r.chain))}</option>`).join('')
      : `<option value="">${routes.loading ? 'Loading networks...' : 'No networks available right now'}</option>`;
    if (routes.routes.some((r) => r.id === keep)) $('wNet').value = keep;
  };

  const render = () => {
    const m = method();
    const instant = !!m.instant;
    $('wDest').disabled = !instant && teamPayout();
    $('wNetField').hidden = !instant;
    $('sumNetRow').hidden = !instant;
    $('sumToRow').hidden = !instant;
    const r = instant ? route() : null;
    $('wDestLabel').textContent = instant ? 'Destination address' : 'Destination';
    $('wDest').placeholder = instant ? (r ? `${ADDRESS_PLACEHOLDER[r.family] || 'Address'} for ${r.asset} on ${chainLabel(r.chain)}` : 'Address') : m.placeholder;
    $('wHint').textContent = instant
      ? 'Minimum $5. Sent as soon as you confirm. The network fee and the exact amount you receive are shown before you confirm.'
      : 'Minimum $5. The amount is held from the balance while an admin reviews the request.';
    $('sumMethod').textContent = instant ? (r ? `${r.asset} · ${chainLabel(r.chain)}` : m.label) : m.label;
    const amount = Number($('wAmt').value);
    const pct = feePercent();
    $('sumAmount').textContent = money(amount > 0 ? amount : 0);
    // A 0% platform fee is not shown at all. An unknown one (a teammate's
    // account) is shown as set on their account.
    $('sumFeeRow').hidden = Number.isFinite(pct) && pct === 0;
    $('sumFeeLabel').textContent = Number.isFinite(pct) ? `Platform fee (${pct}%)` : 'Platform fee';
    const btn = $('wBtn');

    if (blocked) {
      $('wHint').textContent = '';
      $('sumFeeRow').hidden = true;
      $('sumNet').textContent = '-'; $('sumTo').textContent = '-'; $('sumGet').textContent = '-';
      $('sumNote').textContent = blocked;
      btn.textContent = 'Withdraw';
      btn.disabled = true;
      return;
    }
    if (!instant) {
      const team = teamPayout();
      $('wDest').disabled = team;
      if (team) $('wDest').value = '';
      const q = withdrawQuote(amount, pct);
      $('sumFee').textContent = q ? money(q.fee) : (Number.isFinite(pct) ? '$0.00' : 'Set on their account');
      $('sumGet').textContent = q ? money(q.receive) : (Number.isFinite(pct) ? '$0.00' : 'Shown after submit');
      $('wHint').textContent = team
        ? 'Minimum $5. Paid to the freelancer\'s saved wallet for this method. A destination you type is not used.'
        : 'Minimum $5. The amount is held from the balance while an admin reviews the request.';
      $('sumNote').textContent = team ? 'Their saved wallet, then an admin reviews the request.' : m.note;
      btn.textContent = 'Submit for approval';
      btn.disabled = busy;
      return;
    }

    if (!instantAllowed()) {
      $('sumFee').textContent = '-'; $('sumNet').textContent = '-'; $('sumTo').textContent = '-'; $('sumGet').textContent = '-';
      $('sumNote').textContent = 'Instant stablecoin withdrawals are sent from the account\'s own dashboard.';
      btn.textContent = 'Get quote';
      btn.disabled = true;
      return;
    }
    if (!quote) {
      const q = withdrawQuote(amount, pct);
      $('sumFee').textContent = q ? money(q.fee) : '$0.00';
      $('sumNet').textContent = 'Shown in the quote';
      $('sumTo').textContent = shortAddress($('wDest').value.trim()) || '-';
      $('sumGet').textContent = '-';
      $('sumNote').textContent = routes.error
        ? routes.error
        : (routes.loading ? 'Loading networks...' : (routes.routes.length ? m.note : 'No stablecoin networks are available right now.'));
      btn.textContent = busy ? 'Getting quote...' : 'Get quote';
      btn.disabled = busy || !r;
      return;
    }
    const left = expiresIn();
    $('sumAmount').textContent = money(quote.amountUsd);
    const quotePct = Number(quote.feePercent);
    $('sumFeeRow').hidden = !(quotePct > 0);
    $('sumFeeLabel').textContent = `Platform fee (${quotePct}%)`;
    $('sumFee').textContent = `-${money(quote.platformFeeUsd)}`;
    $('sumNet').textContent = `-${usdExact(quote.networkFeeUsd)}`;
    $('sumTo').textContent = shortAddress(quote.address);
    $('sumTo').title = quote.address;
    $('sumGet').textContent = `${quote.receive} ${quote.asset}`;
    $('sumNote').textContent = left > 0
      ? `Quote valid for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}. If the rate moves while it is sent, you still receive at least ${quote.receiveMin} ${quote.asset}.`
      : 'This quote expired. Get a new one to see the current fee.';
    btn.textContent = busy ? 'Sending...' : (left > 0 ? `Confirm and send ${quote.receive} ${quote.asset}` : 'Get new quote');
    btn.disabled = busy;
  };

  const clearQuote = () => { quote = null; clearInterval(timer); timer = null; };
  const showQuote = (q) => {
    quote = q;
    clearInterval(timer);
    timer = setInterval(() => { render(); if (!quote || expiresIn() === 0) { clearInterval(timer); timer = null; } }, 1000);
    render();
  };

  const getQuote = async () => {
    const amount = $('wAmt').value.trim();
    const address = $('wDest').value.trim();
    if (!(Number(amount) >= 5)) return toast('Minimum withdrawal is $5');
    if (!address) return toast('Enter the destination address');
    busy = true; render();
    const res = await callFunction('user-withdraw', { action: 'quote', routeId: $('wNet').value, address, amount });
    busy = false;
    if (!res.ok) { render(); return toast(res.message || 'Could not get a quote'); }
    showQuote(res.data);
  };

  const confirmQuote = async () => {
    busy = true; render();
    const res = await callFunction('user-withdraw', { action: 'confirm', quoteId: quote.quoteId });
    busy = false;
    if (!res.ok && res.status === 409 && res.data?.quote) {
      showQuote(res.data.quote);
      return toast('The quote expired. Check the new amounts and confirm again.');
    }
    if (!res.ok) { render(); return toast(res.message || 'The withdrawal did not go through'); }
    const w = res.data;
    clearQuote();
    $('wAmt').value = '';
    render();
    if (w.status === 'paid') toast(w.amountOut ? `Sent. ${w.amountOut} ${w.asset} delivered.` : 'Sent and delivered.', true);
    else if (w.status === 'failed') toast('The withdrawal failed and the amount is back in your balance.');
    else toast(`Sent. Your ${w.asset} is on its way and usually arrives within a few minutes.`, true);
    onDone(w);
  };

  $('wBtn').onclick = async () => {
    if (busy || blocked) return;
    const m = method();
    if (!m.instant) {
      busy = true; render();
      try { if (await submitManual()) { $('wAmt').value = ''; onDone(); } } finally { busy = false; render(); }
      return;
    }
    if (quote && expiresIn() > 0) return confirmQuote();
    clearQuote();
    return getQuote();
  };
  ['wMethod', 'wNet', 'wAmt', 'wDest'].forEach((id) => {
    const changed = () => { clearQuote(); render(); };
    $(id).addEventListener('input', changed);
    $(id).addEventListener('change', changed);
  });

  if (blocked) {
    const box = document.querySelector('.withdraw');
    if (box) box.classList.add('blocked');
    ['wMethod', 'wNet', 'wAmt', 'wDest'].forEach((id) => { $(id).disabled = true; });
    $('wNet').innerHTML = '<option value="">-</option>';
    render();
    return () => render();
  }
  fillNetworks();
  render();
  loadWithdrawRoutes().then((r) => { routes = { ...r, loading: false }; fillNetworks(); render(); });
  return () => { clearQuote(); render(); };
}

window.CPAY_APP = { $, escapeHtml, money, when, layoutLabel, badge, toast, requireSession, loadProfile, roleHome, signOut, layoutPicker, bindExperience, withdrawForm, bindWithdraw };
