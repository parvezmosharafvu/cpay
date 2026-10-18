const sb = window.supabaseClient;
const exp = { theme: 'keypad', invoice: 'default', wallet: 'all_wallets' };
let me = null;
let payFilter = { status: '', search: '' };
let wdFilter = { status: '' };

// Saved payout addresses can be used 24 hours after they are saved or
// changed (20261009010000); my_payout_book returns usable_after.
function netLabel(id) {
  return (USDT_NETWORKS.find(([n]) => n === id) || [id, id])[1];
}
function readyText(w) {
  const t = w.usable_after ? new Date(w.usable_after) : null;
  if (!t || isNaN(t) || t <= new Date()) return '<span class="net-ready">Ready</span>';
  return `<span class="net-wait">Usable from ${escapeHtml(t.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}</span>`;
}
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
  // Admin belongs on the admin desk; non-admin roles never get admin via UI.
  if (me.role === 'admin') { location.href = 'admin.html'; return; }
  if (me.role && me.role !== 'creator') {
    toast('This account role is not supported. Contact support.');
  }
  document.getElementById('hello').textContent = me.display_name || 'Freelancer';
  document.getElementById('deskKind').textContent = me.account_type === 'business' ? 'Business / Organization account' : 'Individual account';
  document.getElementById('home').innerHTML = deskSkeleton(3);
  document.getElementById('links').innerHTML = deskSkeleton(3);
  document.getElementById('pay').innerHTML = deskSkeleton(4);
  document.getElementById('cash').innerHTML = deskSkeleton(3);
  document.getElementById('chat').innerHTML = deskSkeleton(2);
  document.getElementById('profile').innerHTML = deskSkeleton(2);
  await Promise.all([renderHome(), renderLinks(), renderPays(), renderCash(), renderChat(), renderProfile()]);
}

async function renderHome() {
  const home = document.getElementById('home');
  home.innerHTML = deskSkeleton(3);
  const [{ data: bal, error: balErr }, { data: split, error: splitErr }, recent] = await Promise.all([
    sb.rpc('get_my_balance'),
    sb.rpc('my_earnings_split'),
    sb.rpc('get_my_payments', { p_limit: 5, p_offset: 0, p_search: null, p_status: null }),
  ]);
  if (balErr || splitErr) {
    home.innerHTML = deskError((balErr || splitErr).message);
    return;
  }
  const b = Array.isArray(bal) ? bal[0] : bal || {};
  const s = Array.isArray(split) ? split[0] : split || {};
  const icon = (id) => `<svg class="ico" aria-hidden="true"><use href="#${id}"/></svg>`;
  const recentRows = (recent.data || []).map((p) => {
    const st = String(p.status || '').toLowerCase();
    return `<li><span class="act-ico ${escapeHtml(st)}" aria-hidden="true">${icon('i-in')}</span>
      <span class="act-main"><b>Payment on /${escapeHtml(p.link_slug || '')}</b><small>${escapeHtml(when(p.settled_at || p.created_at))}</small></span>
      <span class="act-amt${st === 'settled' ? ' plus' : ''}">${money(p.amount_settled || p.amount_requested)}<small>${escapeHtml(st || 'unknown')}</small></span></li>`;
  }).join('');
  const recentHtml = recent.error ? deskError(recent.error.message)
    : (recentRows ? `<ul class="activity">${recentRows}</ul>` : deskEmpty('No payments yet', 'Share a payment link; payments show up here as they arrive.'));
  const lead = `<div class="grid two">
    <div class="overview-left">
      <div class="card balance-card">
        <div class="kicker">Available</div>
        <div class="kpi" data-kpi>${money(s.net ?? b.available)}</div>
        <div class="faint">Held by CPAY, ready to withdraw</div>
        <div class="quick">
          <button type="button" class="btn primary" data-jump="cash">${icon('i-out')}Withdraw USDT</button>
          <button type="button" class="btn ghost" data-jump="links" data-focus="linkName">${icon('i-plus')}New payment link</button>
        </div>
      </div>
      <div class="stat-grid">
        <div class="card stat"><span class="stat-ico" aria-hidden="true">${icon('i-in')}</span><div class="kicker">Settled on your links</div><div class="kpi">${money(s.settled)}</div><div class="faint">All time, paid by customers</div></div>
        <div class="card stat"><span class="stat-ico" aria-hidden="true">${icon('i-file-check')}</span><div class="kicker">Platform fee</div><div class="kpi">${money(s.platform_fee)}</div><div class="faint">All time, CPAY's fee on settled payments</div></div>
        <div class="card stat"><span class="stat-ico" aria-hidden="true">${icon('i-link')}</span><div class="kicker">Link cost</div><div class="kpi">${Daily.pct(s.cost_percent || 0)}</div><div class="faint">Added to what the payer pays</div></div>
      </div>
    </div>
    <div class="card">
      <div class="card-title"><h3>Recent payments</h3><button type="button" class="link-btn" data-jump="pay">View all</button></div>
      ${recentHtml}
    </div>
  </div>`;
  home.innerHTML = '<div class="stack" id="dailySelf"><p class="muted">Loading…</p></div>';
  await Daily.mountSelf(document.getElementById('dailySelf'), { lead });
  bindJumps(home);
}

// Overview shortcuts open another section through its sidebar button.
function bindJumps(root) {
  root.querySelectorAll('[data-jump]').forEach((btn) => {
    btn.onclick = () => {
      const nav = document.querySelector(`.side .navi[data-tab="${btn.dataset.jump}"]`);
      if (nav) nav.click();
      const target = btn.dataset.focus && document.getElementById(btn.dataset.focus);
      if (target) setTimeout(() => target.focus(), 60);
    };
  });
}

async function renderLinks() {
  const el = document.getElementById('links');
  el.innerHTML = deskSkeleton(3);
  const [{ data: links, error }, ds] = await Promise.all([
    sb.from('payment_links').select('*').eq('user_id', me.id).is('deleted_at', null).order('created_at', { ascending: false }),
    window.cpayDirect ? window.cpayDirect.state() : Promise.resolve(null),
  ]);
  if (error) { el.innerHTML = deskError(error.message); return; }
  // Direct payments (direct-settlement.js): a "Payments go to" column once
  // the switch is on or a link already pays the owner's own wallet.
  const direct = window.cpayDirect;
  const showMode = Boolean(direct && ds && (direct.visible(ds) || (links || []).some((l) => l.settlement_mode === 'direct')));
  const list = (links || []).map((l) => `<tr>
    <td data-label="Link"><a href="/${escapeHtml(l.slug)}" target="_blank" rel="noopener">/${escapeHtml(l.slug)}</a></td>
    <td data-label="Name">${escapeHtml(l.display_name || '')}</td>
    <td data-label="Design">${escapeHtml(layoutLabel(l.theme))}</td>
    <td data-label="Wallets">${l.wallet_mode === 'cashapp' ? 'Cash App only' : 'All wallets'}</td>
    <td data-label="Status">${badge(l.is_active ? 'live' : 'off')}</td>
    ${showMode ? direct.linkCell(l, ds) || '<td data-label="Payments go to">CPAY balance</td>' : ''}
    <td class="table-actions">
      <button type="button" class="btn ghost sm" data-copy-link="${escapeHtml(l.slug)}" aria-label="Copy the link /${escapeHtml(l.slug)}">Copy link</button>
      <button type="button" class="btn ghost sm" data-toggle-link="${escapeHtml(l.id)}" data-active="${l.is_active ? '1' : '0'}">${l.is_active ? 'Turn off' : 'Turn on'}</button>
      ${showMode ? direct.linkButton(l, ds) : ''}
    </td>
  </tr>`).join('');
  el.innerHTML = `
    <div class="card flush">
      <div class="card-head"><div><h3>Your links</h3><div class="faint">Share a link; payers choose an amount and pay a Lightning invoice.</div></div><span class="meta-count">${(links || []).length} total</span></div>
      <div class="scroll"><table class="table rtable"><thead><tr><th>Link</th><th>Name</th><th>Design</th><th>Wallets</th><th>Status</th>${showMode ? '<th>Payments go to</th>' : ''}<th><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${list || `<tr><td colspan="${showMode ? 7 : 6}">${deskEmpty('No links yet', 'Create a payment link to start collecting.')}</td></tr>`}</tbody></table></div>
    </div>
    <div class="card">
      <h3>New payment link</h3>
      <p class="role-note">Payers open your link and pay over Lightning. Settled amounts land in your USD book.</p>
      <div class="field"><label for="linkName">Display name</label><input id="linkName" placeholder="The name payers see"></div>
      <div class="field"><label for="linkCost">Link cost %</label><input id="linkCost" type="number" min="0" step="0.1" value="${Number(me.cost_percent || 0)}"></div>
      <p class="hint">Added on top of what the payer pays. This is separate from the platform fee.</p>
      ${layoutPicker(exp.theme, exp.wallet, exp.invoice)}
      ${direct && ds ? direct.newLinkChoice(ds) : ''}
      <button class="btn primary" id="makeLink" type="button">Create link</button>
    </div>`;
  bindExperience(exp);
  document.getElementById('makeLink').onclick = makeLink;
  el.querySelectorAll('[data-copy-link]').forEach((btn) => {
    btn.onclick = async () => {
      const url = `${location.origin}/${btn.dataset.copyLink}`;
      try { await navigator.clipboard.writeText(url); toast('Link copied', true); } catch (e) { toast(url, true); }
    };
  });
  if (showMode) direct.bindLinkButtons(el, renderLinks);
  el.querySelectorAll('[data-toggle-link]').forEach((btn) => {
    btn.onclick = async () => {
      const next = btn.dataset.active !== '1';
      btn.disabled = true;
      const { error: e } = await sb.from('payment_links').update({ is_active: next }).eq('id', btn.dataset.toggleLink).eq('user_id', me.id);
      if (e) { toast(e.message); btn.disabled = false; return; }
      toast(next ? 'Link is live' : 'Link turned off', true);
      renderLinks();
    };
  });
}

async function makeLink() {
  const name = document.getElementById('linkName').value.trim();
  if (!name) return toast('Enter a name');
  const btn = document.getElementById('makeLink');
  btn.disabled = true;
  const { data, error } = await sb.rpc('create_link_variants', { p_display_name: name, p_styles: ['kebab'] });
  if (error) { btn.disabled = false; return toast(error.message); }
  const row = Array.isArray(data) ? data[0] : data;
  if (row?.slug) {
    const { data: link } = await sb.from('payment_links').select('id').eq('slug', row.slug).maybeSingle();
    if (link?.id) {
      await sb.rpc('set_payment_link_experience', {
        p_link_id: link.id, p_theme: exp.theme, p_wallet_mode: exp.wallet, p_invoice_theme: exp.invoice,
      });
    }
    const costError = await applyLinkCost(link?.id);
    if (costError) { btn.disabled = false; return toast(costError); }
    if (link?.id && window.cpayDirect && window.cpayDirect.chosenMode() === 'direct') {
      const { error: modeError } = await sb.rpc('set_link_settlement_mode', { p_link_id: link.id, p_mode: 'direct' });
      if (modeError) { btn.disabled = false; return toast(`Link created, paying your CPAY balance: ${modeError.message}`); }
    }
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
  const el = document.getElementById('pay');
  el.innerHTML = deskSkeleton(4);
  const { data, error } = await sb.rpc('get_my_payments', {
    p_limit: 50,
    p_offset: 0,
    p_search: payFilter.search || null,
    p_status: payFilter.status || null,
  });
  if (error) { el.innerHTML = deskError(error.message); return; }
  const total = data?.[0]?.total_count != null ? Number(data[0].total_count) : (data || []).length;
  const rows = (data || []).map((p) => `<tr>
    <td class="num" data-label="Amount"><span class="cell-main">${money(p.amount_settled || p.amount_requested)}</span></td>
    <td data-label="Status">${badge(p.status)}</td>
    <td data-label="Link">/${escapeHtml(p.link_slug || '')}</td>
    <td class="mono" data-label="Invoice">${escapeHtml(p.invoice_ref || String(p.id || '').slice(0, 8))}</td>
    <td data-label="When">${escapeHtml(when(p.settled_at || p.created_at))}</td>
  </tr>`).join('');
  const toolbar = deskFilterBar(`
    <div class="field short"><label for="payStatus">Status</label>
      <select id="payStatus">
        <option value="">All</option>
        <option value="settled">Settled</option>
        <option value="pending">Pending</option>
        <option value="new">New</option>
        <option value="expired">Expired</option>
        <option value="invalid">Invalid</option>
      </select></div>
    <div class="field grow"><label for="paySearch">Search</label>
      <input id="paySearch" type="search" placeholder="Invoice, link slug…" value="${escapeHtml(payFilter.search)}"></div>
  `, `<button type="button" class="btn primary" id="payApply">Apply</button>
      <button type="button" class="btn ghost" id="payClear">Clear</button>`);
  el.innerHTML = `<div class="card flush">
    ${toolbar}
    <div class="card-head"><h3>Payment history</h3><span class="meta-count">${total} match${total === 1 ? '' : 'es'}</span></div>
    <div class="scroll"><table class="table rtable"><thead><tr><th class="num">Amount</th><th>Status</th><th>Link</th><th>Invoice</th><th>When</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="5">${deskEmpty('No payments match', 'Try another status or clear filters.')}</td></tr>`}</tbody></table></div>
  </div>
  <div id="directPays" hidden></div>`;
  if (window.cpayDirect) window.cpayDirect.paymentsCard(document.getElementById('directPays'));
  const statusEl = document.getElementById('payStatus');
  if (statusEl) statusEl.value = payFilter.status || '';
  document.getElementById('payApply').onclick = () => {
    payFilter = {
      status: document.getElementById('payStatus').value,
      search: document.getElementById('paySearch').value.trim(),
    };
    renderPays();
  };
  document.getElementById('payClear').onclick = () => {
    payFilter = { status: '', search: '' };
    renderPays();
  };
  document.getElementById('paySearch').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('payApply').click();
  });
}

async function renderWithdrawHistory() {
  const host = document.getElementById('wHist');
  if (!host) return;
  host.innerHTML = deskSkeleton(3);
  let q = sb.from('withdrawals')
    .select('requested_at,status,chain,coin,amount_requested,amount_after_fee,quoted_fee,destination,processed_at')
    .order('requested_at', { ascending: false })
    .limit(40);
  if (wdFilter.status) q = q.eq('status', wdFilter.status);
  const { data, error } = await q;
  if (error) { host.innerHTML = deskError(error.message); return; }
  const rows = (data || []).map((w) => `<tr>
    <td data-label="When">${escapeHtml(when(w.requested_at))}</td>
    <td data-label="Status">${badge(w.status)}</td>
    <td data-label="Network">${escapeHtml(w.chain || w.coin || 'USDT')}</td>
    <td class="num" data-label="Requested">${money(w.amount_requested)}</td>
    <td class="num" data-label="After fee"><span class="cell-main">${money(w.amount_after_fee)}</span></td>
    <td class="mono" data-label="Address" title="${escapeHtml(w.destination || '')}">${escapeHtml(String(w.destination || '').slice(0, 18))}</td>
  </tr>`).join('');
  const toolbar = deskFilterBar(`
    <div class="field short"><label for="wdStatus">Status</label>
      <select id="wdStatus">
        <option value="">All</option>
        <option value="pending">Pending</option>
        <option value="approved">Approved</option>
        <option value="processing">Processing</option>
        <option value="sending">Sending</option>
        <option value="paid">Paid</option>
        <option value="failed">Failed</option>
        <option value="rejected">Rejected</option>
      </select></div>
  `, `<button type="button" class="btn primary" id="wdApply">Apply</button>
      <button type="button" class="btn ghost" id="wdClear">Clear</button>`);
  host.innerHTML = `<div class="card flush">
    ${toolbar}
    <div class="card-head"><h3>Withdrawal history</h3><span class="meta-count">${(data || []).length} shown</span></div>
    <div class="scroll"><table class="table rtable"><thead><tr><th>When</th><th>Status</th><th>Network</th><th class="num">Requested</th><th class="num">After fee</th><th>Address</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="6">${deskEmpty('No withdrawals yet', 'Confirm a USDT quote above to see history here.')}</td></tr>`}</tbody></table></div>
  </div>`;
  const st = document.getElementById('wdStatus');
  if (st) st.value = wdFilter.status || '';
  document.getElementById('wdApply').onclick = () => {
    wdFilter = { status: document.getElementById('wdStatus').value };
    renderWithdrawHistory();
  };
  document.getElementById('wdClear').onclick = () => {
    wdFilter = { status: '' };
    renderWithdrawHistory();
  };
}

async function renderCash() {
  const el = document.getElementById('cash');
  el.innerHTML = deskSkeleton(3);
  const [{ data: bal, error: balErr }, { data: ws, error: wsErr }, { data: book, error: bookErr }] = await Promise.all([
    sb.rpc('get_my_balance'),
    sb.rpc('my_withdraw_settings'),
    sb.rpc('my_payout_book'),
  ]);
  if (balErr || wsErr || bookErr) {
    el.innerHTML = deskError((balErr || wsErr || bookErr).message);
    return;
  }
  const b = Array.isArray(bal) ? bal[0] : bal || {};
  const fee = Number(ws?.fee_percent ?? 0);
  const wallets = book?.wallets || [];
  const savedNote = wallets.length
    ? `<p class="hint">Saved USDT wallets: ${wallets.map((w) => `${escapeHtml(netLabel(w.network))} (${readyText(w)})`).join(', ')}. Open Profile to add more networks.</p>`
    : `<p class="hint">Save a USDT address in Profile first. Withdrawals only go to a saved address, starting 24 hours after you save or change it.</p>`;
  el.innerHTML = withdrawForm(`<p class="muted">Available balance <strong id="wAvail">${money(b.available)}</strong>, held by CPAY</p>`
    + savedNote)
    + '<div id="wHist"></div>';
  bindWithdraw(() => fee, {
    saved: wallets,
    preferredNetwork: book?.preferred_usdt_network || null,
    onDone: async () => {
      renderHome();
      renderWithdrawHistory();
      const { data: now } = await sb.rpc('get_my_balance');
      const nb = Array.isArray(now) ? now[0] : now || {};
      const avail = document.getElementById('wAvail');
      if (avail) avail.textContent = money(nb.available);
    },
  });
  renderWithdrawHistory();
}

async function renderChat() {
  const el = document.getElementById('chat');
  el.innerHTML = deskSkeleton(2);
  const { data: adminMsgs, error } = await sb.from('support_messages').select('*').eq('user_id', me.id).order('created_at', { ascending: true }).limit(80);
  if (error) { el.innerHTML = deskError(error.message); return; }
  const adminThread = (adminMsgs || []).map((m) => `<div class="msg${m.sender === 'admin' ? '' : ' mine'}"><span class="faint">${m.sender === 'admin' ? 'Admin' : 'You'}</span>${escapeHtml(m.message)}</div>`).join('');
  el.innerHTML = `<div class="stack">
    <div class="card"><div class="card-title"><div><h3>Messages with the admin</h3><p class="faint">Questions about your account, payments or withdrawals.</p></div></div>
      <div class="thread">${adminThread || deskEmpty('No messages yet', 'Write the admin if you need help with your account.')}</div>
      <div class="compose"><input class="input" id="adminMsg" placeholder="Write a message" aria-label="Message to the admin"><button class="btn primary" id="sendAdmin" type="button">Send</button></div></div>
  </div>`;
  document.getElementById('sendAdmin').onclick = async () => {
    const text = document.getElementById('adminMsg').value.trim();
    if (!text) return toast('Write a message first');
    const { error: e } = await sb.from('support_messages').insert({ user_id: me.id, sender: 'creator', message: text });
    if (e) return toast(e.message);
    renderChat();
  };
}

async function renderProfile() {
  const el = document.getElementById('profile');
  el.innerHTML = deskSkeleton(2);
  const { data: book, error } = await sb.rpc('my_payout_book');
  if (error) { el.innerHTML = deskError(error.message); return; }
  const wallets = book?.wallets || [];
  const netOpts = USDT_NETWORKS.map(([id, label]) => `<option value="${id}">${label}</option>`).join('');
  const prefOpts = `<option value="">None yet</option>` + USDT_NETWORKS.map(([id, label]) =>
    `<option value="${id}" ${book?.preferred_usdt_network === id ? 'selected' : ''}>${label}</option>`).join('');
  const rows = wallets.map((w) => {
    return `<tr><td data-label="Network">${escapeHtml(netLabel(w.network))}</td><td data-label="Address" class="mono"><code>${escapeHtml(w.address)}</code></td><td data-label="Status">${readyText(w)}</td>
      <td class="table-actions"><button type="button" class="btn ghost sm" data-del-net="${escapeHtml(w.network)}">Remove</button></td></tr>`;
  }).join('');
  el.innerHTML = `<div id="directCard" hidden></div>
  <div class="grid split">
    <div class="card">
      <h3>Public profile</h3>
      <p class="role-note">Storefront settings for your public page. Display name is what payers see.</p>
      <div class="field"><label for="pName">Display name</label><input id="pName" value="${escapeHtml(me.display_name || '')}"></div>
      <div class="field"><label for="pBio">Bio</label><textarea id="pBio">${escapeHtml(me.bio || '')}</textarea></div>
      <div class="field"><label for="pSlug">Store address</label><input id="pSlug" value="${escapeHtml(me.public_slug || '')}"></div>
      <div class="row"><button class="btn primary" id="saveProf" type="button">Save profile</button><a class="btn ghost" href="store.html?u=${encodeURIComponent(me.id)}">Open public store</a></div>
    </div>
    <div class="card">
      <h3>USDT payout</h3>
      <p class="hint">One address per network. Withdraw sends USDT there. For your safety, a new or changed address can receive withdrawals 24 hours after you save it. Lightning collect only — payouts are USDT.</p>
      <div class="field"><label for="usdtNet">Network</label><select id="usdtNet">${netOpts}</select></div>
      <div class="field"><label for="usdtAddr">Wallet address</label><input id="usdtAddr" placeholder="Address for that network" autocomplete="off" spellcheck="false"></div>
      <button class="btn primary" id="saveUsdt" type="button">Save address</button>
      <div class="card flush" style="margin-top:16px">
        <table class="table rtable"><thead><tr><th>Network</th><th>Address</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4">${deskEmpty('No USDT address saved', 'Add a network address before withdrawing.')}</td></tr>`}</tbody></table>
      </div>
      <div class="field"><label for="prefNet">Preferred network</label><select id="prefNet">${prefOpts}</select></div>
      <div class="field"><label for="thresh">Auto-withdraw threshold (USD)</label>
        <input id="thresh" type="number" min="5" step="1" placeholder="Leave empty to only withdraw by hand" value="${book?.withdraw_threshold ?? ''}"></div>
      <label class="check"><input type="checkbox" id="autoOn" ${book?.auto_withdraw_enabled ? 'checked' : ''}> Queue a payout when the balance reaches the threshold</label>
      <button class="btn ghost" id="savePrefs" type="button">Save payout settings</button>
    </div>
  </div>`;
  if (window.cpayDirect) window.cpayDirect.card(document.getElementById('directCard'), () => { renderProfile(); renderLinks(); });
  document.getElementById('saveProf').onclick = async () => {
    const { error: e } = await sb.rpc('update_my_public_profile', {
      p_display_name: document.getElementById('pName').value,
      p_bio: document.getElementById('pBio').value,
      p_public_slug: document.getElementById('pSlug').value,
    });
    if (e) return toast(e.message);
    toast('Saved', true);
  };
  document.getElementById('saveUsdt').onclick = async () => {
    const { error: e } = await sb.rpc('set_my_usdt_wallet', {
      p_network: document.getElementById('usdtNet').value,
      p_address: document.getElementById('usdtAddr').value.trim(),
    });
    if (e) return toast(e.message);
    toast('USDT address saved', true);
    renderProfile();
  };
  document.querySelectorAll('[data-del-net]').forEach((btn) => {
    btn.onclick = async () => {
      const { error: e } = await sb.rpc('delete_my_usdt_wallet', { p_network: btn.dataset.delNet });
      if (e) return toast(e.message);
      renderProfile();
    };
  });
  document.getElementById('savePrefs').onclick = async () => {
    const raw = document.getElementById('thresh').value.trim();
    const { error: e } = await sb.rpc('set_my_payout_prefs', {
      p_threshold: raw === '' ? null : Number(raw),
      p_network: document.getElementById('prefNet').value || null,
      p_auto_enabled: document.getElementById('autoOn').checked,
    });
    if (e) return toast(e.message);
    toast('Payout settings saved', true);
  };
}

boot();

const logoutBtn = document.getElementById('logoutBtn');
if (logoutBtn) logoutBtn.onclick = signOut;
