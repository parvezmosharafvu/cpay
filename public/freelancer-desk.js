const sb = window.supabaseClient;
const exp = { theme: 'keypad', invoice: 'default', wallet: 'all_wallets' };
let me = null;

const USDT_NETWORKS = [
  ['tron', 'Tron (TRC-20)'],
  ['bsc', 'BNB Smart Chain (BEP-20)'],
  ['ethereum', 'Ethereum (ERC-20)'],
  ['polygon', 'Polygon'],
  ['arbitrum', 'Arbitrum One'],
  ['base', 'Base'],
  ['optimism', 'Optimism'],
  ['avalanche', 'Avalanche'],
  ['solana', 'Solana'],
];

function show(tab) {
  if (!document.getElementById(tab)) tab = 'home';
  document.querySelectorAll('main > section').forEach((s) => { s.hidden = s.id !== tab; });
  document.querySelectorAll('.navi[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  try { localStorage.setItem('cpay-freelancer-tab', tab); } catch (e) {}
}
document.querySelectorAll('.navi[data-tab]').forEach((b) => { b.onclick = () => show(b.dataset.tab); });
try {
  const saved = localStorage.getItem('cpay-freelancer-tab');
  if (saved && document.getElementById(saved)) show(saved);
} catch (e) {}

async function boot() {
  me = await loadProfile();
  if (!me) return;
  if (me.role === 'admin') { location.href = 'admin.html'; return; }
  document.getElementById('hello').textContent = me.display_name || 'Freelancer';
  await Promise.all([renderHome(), renderLinks(), renderPays(), renderCash(), renderChat(), renderProfile()]);
}

async function renderHome() {
  const [{ data: bal }, { data: split }] = await Promise.all([
    sb.rpc('get_my_balance'),
    sb.rpc('my_earnings_split'),
  ]);
  const b = Array.isArray(bal) ? bal[0] : bal || {};
  const s = Array.isArray(split) ? split[0] : split || {};
  const kpis = `<div class="grid kpis">
    <div class="card"><div class="kicker">Available</div><div class="kpi">${money(s.net ?? b.available)}</div><div class="faint">Ready to withdraw</div></div>
    <div class="card"><div class="kicker">Settled on your links</div><div class="kpi">${money(s.settled)}</div><div class="faint">All time, paid by customers</div></div>
    <div class="card"><div class="kicker">Platform fee</div><div class="kpi">${money(s.platform_fee)}</div><div class="faint">All time, CPAY's fee on settled payments</div></div>
    <div class="card"><div class="kicker">Link cost</div><div class="kpi">${Daily.pct(s.cost_percent || 0)}</div><div class="faint">Added to what the payer pays</div></div>
  </div>`;
  const home = document.getElementById('home');
  home.innerHTML = '<div class="stack" id="dailySelf"><p class="muted">Loading…</p></div>';
  await Daily.mountSelf(document.getElementById('dailySelf'), { between: kpis });
}

async function renderLinks() {
  const { data: links } = await sb.from('payment_links').select('*').eq('user_id', me.id).is('deleted_at', null).order('created_at', { ascending: false });
  const list = (links || []).map((l) => `<tr>
    <td><a href="/${escapeHtml(l.slug)}" target="_blank">/${escapeHtml(l.slug)}</a></td>
    <td>${escapeHtml(l.display_name || '')}</td>
    <td>${escapeHtml(layoutLabel(l.theme))}</td>
    <td>${l.wallet_mode === 'cashapp' ? 'Cash App only' : 'All wallets'}</td>
    <td>${badge(l.is_active ? 'live' : 'off')}</td>
  </tr>`).join('');
  document.getElementById('links').innerHTML = `
    <div class="card">
      <h3>New payment link</h3>
      <div class="field"><label for="linkName">Display name</label><input id="linkName" placeholder="The name payers see"></div>
      <div class="field"><label for="linkCost">Link cost %</label><input id="linkCost" type="number" min="0" step="0.1" value="${Number(me.cost_percent || 0)}"></div>
      <p class="hint">Added on top of what the payer pays. This is separate from the platform fee.</p>
      ${layoutPicker(exp.theme, exp.wallet, exp.invoice)}
      <button class="btn primary" id="makeLink">Create link</button>
    </div>
    <div class="card flush">
      <table class="table"><thead><tr><th>Link</th><th>Name</th><th>Design</th><th>Wallets</th><th>Status</th></tr></thead>
      <tbody>${list || '<tr><td colspan="5" class="empty">No links yet</td></tr>'}</tbody></table>
    </div>`;
  bindExperience(exp);
  document.getElementById('makeLink').onclick = makeLink;
}

async function makeLink() {
  const name = document.getElementById('linkName').value.trim();
  if (!name) return toast('Enter a name');
  const { data, error } = await sb.rpc('create_link_variants', { p_display_name: name, p_styles: ['kebab'] });
  if (error) return toast(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  if (row?.slug) {
    const { data: link } = await sb.from('payment_links').select('id').eq('slug', row.slug).maybeSingle();
    if (link?.id) {
      await sb.rpc('set_payment_link_experience', {
        p_link_id: link.id, p_theme: exp.theme, p_wallet_mode: exp.wallet, p_invoice_theme: exp.invoice,
      });
    }
    const costError = await applyLinkCost(link?.id);
    if (costError) return toast(costError);
  }
  toast('Link ready', true);
  await renderLinks();
}

async function applyLinkCost(linkId) {
  if (!linkId) return null;
  const raw = document.getElementById('linkCost').value;
  if (raw === '') return null;
  const cost = Number(raw);
  if (!Number.isFinite(cost)) return 'Enter a valid link cost';
  const { error } = await sb.rpc('set_link_cost_percent', { p_link_id: linkId, p_percent: cost });
  return error ? error.message : null;
}

async function renderPays() {
  const { data, error } = await sb.rpc('get_my_payments', { p_limit: 50, p_offset: 0 });
  if (error) { document.getElementById('pay').innerHTML = `<p class="err">${escapeHtml(error.message)}</p>`; return; }
  const rows = (data || []).map((p) => `<tr><td class="num">${money(p.amount_settled || p.amount_requested)}</td><td>${badge(p.status)}</td><td>/${escapeHtml(p.link_slug || '')}</td><td>${escapeHtml(when(p.settled_at || p.created_at))}</td></tr>`).join('');
  document.getElementById('pay').innerHTML = `<div class="card flush"><table class="table"><thead><tr><th class="num">Amount</th><th>Status</th><th>Link</th><th>When</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="empty">No payments yet</td></tr>'}</tbody></table></div>`;
}


async function renderWithdrawHistory() {
  const host = document.getElementById('wHist');
  if (!host) return;
  const { data, error } = await sb.from('withdrawals')
    .select('requested_at,status,chain,coin,amount_requested,amount_after_fee,quoted_fee,destination,processed_at')
    .order('requested_at', { ascending: false })
    .limit(30);
  if (error) { host.innerHTML = `<p class="err" role="alert">${escapeHtml(error.message)}</p>`; return; }
  const rows = (data || []).map((w) => `<tr>
    <td>${escapeHtml(when(w.requested_at))}</td>
    <td>${badge(w.status)}</td>
    <td>${escapeHtml(w.chain || w.coin || 'USDT')}</td>
    <td class="num">${money(w.amount_requested)}</td>
    <td class="num">${money(w.amount_after_fee)}</td>
    <td class="mono">${escapeHtml(String(w.destination || '').slice(0, 18))}</td>
  </tr>`).join('');
  host.innerHTML = `<div class="card flush"><h3 style="padding:16px 20px 0">Withdrawal history</h3>
    <table class="table"><thead><tr><th>When</th><th>Status</th><th>Network</th><th class="num">Requested</th><th class="num">After fee</th><th>Address</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6" class="empty">No withdrawals yet</td></tr>'}</tbody></table></div>`;
}

async function renderCash() {
  const [{ data: bal }, { data: ws }, { data: book }] = await Promise.all([
    sb.rpc('get_my_balance'),
    sb.rpc('my_withdraw_settings'),
    sb.rpc('my_payout_book'),
  ]);
  const b = Array.isArray(bal) ? bal[0] : bal || {};
  const fee = Number(ws?.fee_percent ?? 0);
  const wallets = book?.wallets || [];
  const savedNote = wallets.length
    ? `<p class="hint">Saved USDT wallets: ${wallets.map((w) => escapeHtml(w.network)).join(', ')}. Open Profile to add more networks.</p>`
    : `<p class="hint">Save a USDT address in Profile first. Lightning payouts are off.</p>`;
  document.getElementById('cash').innerHTML = withdrawForm(`<p class="muted">Available balance <strong id="wAvail">${money(b.available)}</strong></p>`
    + savedNote)
    + '<div id="wHist"></div>';
  bindWithdraw(() => fee, {
    submitManual: async () => {
      const { data, error } = await sb.rpc('request_withdrawal', {
        p_amount: Number(document.getElementById('wAmt').value),
        p_method: document.getElementById('wMethod').value,
        p_destination: document.getElementById('wDest').value.trim(),
      });
      if (error) { toast(error.message); return false; }
      const row = Array.isArray(data) ? data[0] : data;
      toast(row?.amount_after_fee != null ? `Withdrawal requested. You receive ${money(row.amount_after_fee)} after an admin approves it.` : 'Withdrawal requested', true);
      return true;
    },
    onDone: async () => {
      renderHome();
      renderWithdrawHistory();
      const { data: now } = await sb.rpc('get_my_balance');
      const nb = Array.isArray(now) ? now[0] : now || {};
      document.getElementById('wAvail').textContent = money(nb.available);
    },
  });
  renderWithdrawHistory();
    const dest = document.getElementById('wDest');
  const preferred = wallets.find((w) => w.network === book?.preferred_usdt_network) || wallets[0];
  if (dest && preferred && !dest.value) dest.value = preferred.address;
}

async function renderChat() {
  const { data: adminMsgs } = await sb.from('support_messages').select('*').eq('user_id', me.id).order('created_at', { ascending: true }).limit(80);
  const adminThread = (adminMsgs || []).map((m) => `<div class="msg"><span class="faint">${m.sender === 'admin' ? 'Admin' : 'You'}</span>${escapeHtml(m.message)}</div>`).join('');
  document.getElementById('chat').innerHTML = `<div class="stack">
    <div class="card"><h3>Admin</h3><div class="thread">${adminThread || '<p class="muted">No messages with the admin.</p>'}</div>
      <div class="compose"><input class="input" id="adminMsg" placeholder="Write a message" aria-label="Message to the admin"><button class="btn primary" id="sendAdmin">Send</button></div></div>
  </div>`;
  document.getElementById('sendAdmin').onclick = async () => {
    const { error } = await sb.from('support_messages').insert({ user_id: me.id, sender: 'creator', message: document.getElementById('adminMsg').value.trim() });
    if (error) return toast(error.message);
    renderChat();
  };
}

async function renderProfile() {
  const { data: book } = await sb.rpc('my_payout_book');
  const wallets = book?.wallets || [];
  const netOpts = USDT_NETWORKS.map(([id, label]) => `<option value="${id}">${label}</option>`).join('');
  const prefOpts = `<option value="">None yet</option>` + USDT_NETWORKS.map(([id, label]) =>
    `<option value="${id}" ${book?.preferred_usdt_network === id ? 'selected' : ''}>${label}</option>`).join('');
  const rows = wallets.map((w) => {
    const label = (USDT_NETWORKS.find(([id]) => id === w.network) || [w.network, w.network])[1];
    return `<tr><td>${escapeHtml(label)}</td><td><code>${escapeHtml(w.address)}</code></td>
      <td><button class="btn ghost" data-del-net="${escapeHtml(w.network)}">Remove</button></td></tr>`;
  }).join('');
  document.getElementById('profile').innerHTML = `<div class="grid split">
    <div class="card">
      <h3>Public profile</h3>
      <div class="field"><label for="pName">Display name</label><input id="pName" value="${escapeHtml(me.display_name || '')}"></div>
      <div class="field"><label for="pBio">Bio</label><textarea id="pBio">${escapeHtml(me.bio || '')}</textarea></div>
      <div class="field"><label for="pSlug">Store address</label><input id="pSlug" value="${escapeHtml(me.public_slug || '')}"></div>
      <div class="row"><button class="btn primary" id="saveProf">Save profile</button><a class="btn ghost" href="store.html?u=${encodeURIComponent(me.id)}">Open public store</a></div>
    </div>
    <div class="card">
      <h3>USDT payout</h3>
      <p class="hint">One address per network. Withdraw sends USDT there. Lightning payouts are off.</p>
      <div class="field"><label for="usdtNet">Network</label><select id="usdtNet">${netOpts}</select></div>
      <div class="field"><label for="usdtAddr">Wallet address</label><input id="usdtAddr" placeholder="Address for that network" autocomplete="off" spellcheck="false"></div>
      <button class="btn primary" id="saveUsdt">Save address</button>
      <div class="card flush" style="margin-top:16px">
        <table class="table"><thead><tr><th>Network</th><th>Address</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="3" class="empty">No USDT address saved</td></tr>'}</tbody></table>
      </div>
      <div class="field"><label for="prefNet">Preferred network</label><select id="prefNet">${prefOpts}</select></div>
      <div class="field"><label for="thresh">Auto-withdraw threshold (USD)</label>
        <input id="thresh" type="number" min="5" step="1" placeholder="Leave empty to only withdraw by hand" value="${book?.withdraw_threshold ?? ''}"></div>
      <label class="row"><input type="checkbox" id="autoOn" ${book?.auto_withdraw_enabled ? 'checked' : ''}> Queue a payout when the balance reaches the threshold</label>
      <button class="btn" id="savePrefs">Save payout settings</button>
    </div>
  </div>`;
  document.getElementById('saveProf').onclick = async () => {
    const { error } = await sb.rpc('update_my_public_profile', {
      p_display_name: document.getElementById('pName').value,
      p_bio: document.getElementById('pBio').value,
      p_public_slug: document.getElementById('pSlug').value,
    });
    if (error) return toast(error.message);
    toast('Saved', true);
  };
  document.getElementById('saveUsdt').onclick = async () => {
    const { error } = await sb.rpc('set_my_usdt_wallet', {
      p_network: document.getElementById('usdtNet').value,
      p_address: document.getElementById('usdtAddr').value.trim(),
    });
    if (error) return toast(error.message);
    toast('USDT address saved', true);
    renderProfile();
  };
  document.querySelectorAll('[data-del-net]').forEach((btn) => {
    btn.onclick = async () => {
      const { error } = await sb.rpc('delete_my_usdt_wallet', { p_network: btn.dataset.delNet });
      if (error) return toast(error.message);
      renderProfile();
    };
  });
  document.getElementById('savePrefs').onclick = async () => {
    const raw = document.getElementById('thresh').value.trim();
    const { error } = await sb.rpc('set_my_payout_prefs', {
      p_threshold: raw === '' ? null : Number(raw),
      p_network: document.getElementById('prefNet').value || null,
      p_auto_enabled: document.getElementById('autoOn').checked,
    });
    if (error) return toast(error.message);
    toast('Payout settings saved', true);
  };
}

boot();

const logoutBtn = document.getElementById("logoutBtn");
if (logoutBtn) logoutBtn.onclick = signOut;
