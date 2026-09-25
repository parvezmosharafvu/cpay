function $(id){ return document.getElementById(id); }
function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function money(n){ return '$' + Number(n || 0).toFixed(2); }
function when(ts){ return ts ? new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : ''; }
function layoutLabel(theme){ return (window.CPAY_LAYOUTS[theme] || window.CPAY_LAYOUTS.keypad).label; }
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
function layoutPicker(selected, wallet){
  const layouts = window.CPAY_LAYOUTS || {};
  const layoutHtml = Object.entries(layouts).map(([id, meta]) =>
    `<button type="button" class="design ${id===selected?'on':''}" data-theme="${id}">${escapeHtml(meta.label)}<div class="faint">${escapeHtml(meta.help)}</div></button>`
  ).join('');
  return `
    <div class="field"><label>Payment page layout</label><div class="designs" id="themePick">${layoutHtml}</div></div>
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
   Keys are the withdrawals.method codes request_withdrawal accepts today.
   TODO(breez): add the Breez USDT method with one entry per chain, and take
   the fee and received amount from the prepareSendPayment quote instead of
   withdrawQuote(). */
const WITHDRAW_METHODS = {
  usdt_bep20: { label: 'USDT', network: 'BNB Smart Chain (BEP-20)', placeholder: '0x... USDT address on BNB Smart Chain',
    note: 'Sent as USDT on BNB Smart Chain. Funds sent to an address on another network can be lost.' },
  bkash: { label: 'bKash', placeholder: 'bKash number', note: 'Sent after an admin approves the request.' },
  nagad: { label: 'Nagad', placeholder: 'Nagad number', note: 'Sent after an admin approves the request.' },
  binance: { label: 'Binance Pay', placeholder: 'Binance Pay ID', note: 'Sent after an admin approves the request.' },
  lightning: { label: 'Lightning', placeholder: 'you@wallet.com', note: 'Sent after an admin approves the request.' },
  bank: { label: 'Bank transfer', placeholder: 'Bank, account name and number', note: 'Sent after an admin approves the request.' },
};

function methodLabel(code){
  const m = WITHDRAW_METHODS[code];
  return m ? (m.network ? `${m.label} (${m.network})` : m.label) : code;
}

// Same rounding as request_withdrawal(): amount_after_fee = round(amount * (1 - fee/100), 2).
function withdrawQuote(amount, feePercent){
  if (!(amount > 0) || !Number.isFinite(feePercent)) return null;
  const receive = Math.round(amount * (100 - feePercent) + 1e-6) / 100;
  return { fee: Math.round((amount - receive) * 100) / 100, receive };
}

function withdrawForm(whoHtml){
  const options = Object.entries(WITHDRAW_METHODS)
    .map(([id, m]) => `<option value="${id}">${escapeHtml(m.label)}</option>`).join('');
  return `<div class="withdraw">
    <div class="card">
      <h3>Withdraw</h3>
      <div class="who">${whoHtml}</div>
      <div class="field"><label for="wMethod">Method</label><select id="wMethod">${options}</select></div>
      <div class="field" id="wNetField"><label for="wNet">Network</label><select id="wNet"></select></div>
      <div class="field"><label for="wAmt">Amount (USD)</label><input id="wAmt" type="number" min="5" step="0.01" inputmode="decimal" placeholder="0.00"></div>
      <div class="field"><label for="wDest">Destination</label><input id="wDest" autocomplete="off"></div>
      <p class="hint">Minimum $5. The amount is held from the balance while the request is reviewed.</p>
    </div>
    <aside class="card summary" aria-live="polite">
      <h3>Review</h3>
      <dl>
        <div><dt>Method</dt><dd id="sumMethod">-</dd></div>
        <div><dt>Amount</dt><dd id="sumAmount">$0.00</dd></div>
        <div><dt id="sumFeeLabel">Fee</dt><dd id="sumFee">$0.00</dd></div>
        <div class="total"><dt>You receive</dt><dd id="sumGet">$0.00</dd></div>
      </dl>
      <p class="faint" id="sumNote"></p>
      <button class="btn primary block lg" id="wBtn" type="button">Confirm withdrawal</button>
    </aside>
  </div>`;
}

// feePercent() returns the fee for the account being paid out, or null when this page cannot know it.
function bindWithdraw(feePercent){
  const update = () => {
    const m = WITHDRAW_METHODS[$('wMethod').value];
    $('wNetField').hidden = !m.network;
    $('wNet').innerHTML = m.network ? `<option>${escapeHtml(m.network)}</option>` : '';
    $('wDest').placeholder = m.placeholder;
    $('sumMethod').textContent = m.network ? `${m.label} · ${m.network}` : m.label;
    $('sumNote').textContent = m.note;
    const amount = Number($('wAmt').value);
    const pct = feePercent();
    const q = withdrawQuote(amount, pct);
    $('sumAmount').textContent = money(amount > 0 ? amount : 0);
    $('sumFeeLabel').textContent = Number.isFinite(pct) ? `Fee (${pct}%)` : 'Fee';
    $('sumFee').textContent = q ? money(q.fee) : (Number.isFinite(pct) ? '$0.00' : 'Set on their account');
    $('sumGet').textContent = q ? money(q.receive) : (Number.isFinite(pct) ? '$0.00' : 'Shown after submit');
  };
  ['wMethod', 'wAmt'].forEach((id) => { $(id).addEventListener('input', update); $(id).addEventListener('change', update); });
  update();
  return update;
}

window.CPAY_APP = { $, escapeHtml, money, when, layoutLabel, badge, toast, requireSession, loadProfile, roleHome, signOut, layoutPicker, bindExperience, withdrawForm, bindWithdraw };
