const sb = window.supabaseClient;
let me = null;
let people = [];

let walletShown = false;
function show(tab) {
  if (!document.getElementById(tab)) tab = 'home';
  document.querySelectorAll('main > section').forEach((s) => { s.hidden = s.id !== tab; });
  document.querySelectorAll('.navi[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  if (location.hash !== '#' + tab) history.replaceState(null, '', '#' + tab);
  try { localStorage.setItem('cpay-admin-tab', tab); } catch (e) {}
  if (tab === 'wallet') mountWallet();
}

// The Wallet tab renders once the admin profile is known. On a reload the
// tab is restored (hash / remembered tab) before boot() has loaded the
// profile, so boot() calls this again; until then the section shows a
// loading state, and a failed render shows an error with Retry, never a
// blank section.
function walletSectionVisible() {
  const el = document.getElementById('wallet');
  return Boolean(el && !el.hidden);
}
function mountWallet() {
  const root = document.getElementById('wallet');
  if (!root || walletShown) return;
  if (me?.role !== 'admin') {
    if (!root.firstElementChild) {
      const card = document.createElement('div'); card.className = 'card';
      const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'Loading wallet…';
      card.append(p); root.replaceChildren(card);
    }
    return;
  }
  walletShown = true;
  Promise.resolve().then(() => renderWallet()).catch((e) => {
    walletShown = false;
    const card = document.createElement('div'); card.className = 'card';
    const msg = document.createElement('p'); msg.className = 'err';
    msg.textContent = `The wallet did not load: ${String(e?.message || e)}`;
    const retry = document.createElement('button'); retry.className = 'btn ghost'; retry.textContent = 'Retry';
    retry.onclick = () => mountWallet();
    card.append(msg, retry); root.replaceChildren(card);
  });
}
document.querySelectorAll('.navi[data-tab]').forEach((b) => {
  b.addEventListener('click', (e) => { e.preventDefault(); show(b.dataset.tab); });
});
window.addEventListener('hashchange', () => {
  const tab = location.hash.replace('#', '');
  if (tab) show(tab);
});

if (walletSectionVisible() || location.hash === '#wallet') mountWallet();

async function boot() {
  me = await loadProfile();
  if (!me) return;
  // UI redirect only — admin RPCs and admin-actions still require role=admin server-side.
  if (me.role !== 'admin') { location.href = roleHome(me.role); return; }
  if (walletSectionVisible() || location.hash === '#wallet') mountWallet();
  ['home','people','apps','payouts','chat','daily'].forEach((id) => {
    const el = document.getElementById(id);
    if (el && !el.innerHTML) el.innerHTML = typeof deskSkeleton === 'function' ? deskSkeleton(3) : '<p class="muted">Loading…</p>';
  });
  await Promise.all([renderHome(), renderPeople(), renderApps(), renderFees(), renderFlags(), renderAlerts(), renderPayouts(), renderChat()]);
  // Needs the people list renderPeople() loads, for the filters.
  await Daily.mountAdmin(document.getElementById('daily'), people);
}

async function renderHome() {
  const { data, error } = await sb.rpc('admin_global_stats');
  if (error) { document.getElementById('home').innerHTML = `<p class="err">${escapeHtml(error.message)}</p>`; return; }
  const s = Array.isArray(data) ? data[0] : data || {};
  document.getElementById('home').innerHTML = `<div class="row" style="margin-bottom:12px"><a class="btn primary" href="#people" id="manageUsers">Manage users</a><a class="btn ghost" href="#wallet" id="openWallet">Open wallet</a></div><div class="grid kpis">
    <div class="card"><div class="kicker">Settled volume</div><div class="kpi">${money(s.total_settled)}</div><div class="faint">All settled payments</div></div>
    <div class="card"><div class="kicker">Platform fees</div><div class="kpi">${money(s.total_admin_profit)}</div><div class="faint">Earned on settled volume</div></div>
    <div class="card"><div class="kicker">Paid out</div><div class="kpi">${money(s.total_withdrawn)}</div><div class="faint">Withdrawals marked paid</div></div>
    <div class="card"><div class="kicker">Pending payouts</div><div class="kpi">${Number(s.pending_withdrawals_count || 0)}</div><div class="faint">${money(s.pending_withdrawals_amount)} waiting for review</div></div>
    <div class="card"><div class="kicker">Active accounts</div><div class="kpi">${Number(s.active_creators || 0)}</div></div>
    <div class="card"><div class="kicker">Settled payments</div><div class="kpi">${Number(s.payment_count || 0)}</div></div>
  </div>`;
}

// Filter state lives outside the section: the skeleton below replaces the
// toolbar, so reading the inputs after it would always see empty values.
let peopleFilter = { status: '', search: '' };
// Bounded reads only. Mutations below are never passed to this helper.
async function adminPanelRead(read) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(read), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Read timed out. Try refreshing.')), 12000);
  })]); } catch (error) { return { data: null, error }; }
  finally { clearTimeout(timer); }
}
function adminPanelError(el, message, retry) {
  el.innerHTML = `<div class="card"><p class="err" role="alert">${escapeHtml(message || 'Could not load this section.')}</p><button type="button" class="btn ghost" data-panel-retry>Refresh section</button></div>`;
  el.querySelector('[data-panel-retry]').onclick = retry;
}
let peopleReadVersion = 0;
async function renderPeople() {
  const el = document.getElementById('people');
  if (!el) return;
  const version = ++peopleReadVersion;
  el.innerHTML = typeof deskSkeleton === 'function' ? deskSkeleton(4) : '<p class="muted">Loading…</p>';
  const [{ data, error }, usageRes, feeRes, walletsRes, awRes] = await Promise.all([
    () => sb.rpc('admin_list_business_profiles'), () => sb.rpc('admin_link_usage'),
    () => sb.rpc('admin_withdraw_fee_overview'), () => sb.rpc('admin_list_user_wallets'),
    () => sb.rpc('admin_auto_withdraw_overview'),
  ].map(adminPanelRead));
  if (version !== peopleReadVersion) return;
  if (error) { adminPanelError(el, error.message, renderPeople); return; }
  const usage = usageRes.data, wfees = feeRes.data, wallets = walletsRes.data, awData = awRes.data;
  // Auto withdraw per profile (20261021010000): Default follows Settings.
  const aw = Object.fromEntries(((awData && awData.users) || []).map((u) => [u.user_id, u]));
  const AW_LABEL = { default: 'Default', on: 'On', off: 'Off' };
  const awCell = (id) => {
    const u = aw[id];
    if (!u) return '-';
    return `${u.auto_withdraw ? 'On' : 'Off'}<div class="faint">${u.override === 'default' ? 'Default' : 'Set: ' + AW_LABEL[u.override]}</div>`;
  };
  const EXPLORER = { tron:'https://tronscan.org/#/address/', bsc:'https://bscscan.com/address/', ethereum:'https://etherscan.io/address/', polygon:'https://polygonscan.com/address/', arbitrum:'https://arbiscan.io/address/', base:'https://basescan.org/address/', optimism:'https://optimistic.etherscan.io/address/', avalanche:'https://snowtrace.io/address/', solana:'https://solscan.io/account/' };
  const byWallet = {};
  for (const w of wallets || []) (byWallet[w.user_id] ||= []).push(w);
  const walletLinks = (id) => (byWallet[id] || []).map((w) => `<a href="${EXPLORER[w.network] || '#'}${encodeURIComponent(w.address)}" target="_blank" rel="noopener">${escapeHtml(w.network)}</a>`).join(' · ') || `<span class="faint">${walletsRes.error ? 'Unavailable' : 'No wallet'}</span>`;
  const links = Object.fromEntries((usage || []).map((u) => [u.user_id, u]));
  const wfee = Object.fromEntries((wfees || []).map((f) => [f.user_id, f]));
  if (error) { el.innerHTML = typeof deskError === 'function' ? deskError(error.message) : `<p class="err">${escapeHtml(error.message)}</p>`; return; }
  people = data || [];
  const statusFilter = peopleFilter.status || '';
  const searchFilter = (peopleFilter.search || '').trim().toLowerCase();
  const filtered = people.filter((p) => {
    if (statusFilter && String(p.account_status || '') !== statusFilter) return false;
    if (!searchFilter) return true;
    const hay = `${p.display_name || ''} ${p.email || ''}`.toLowerCase();
    return hay.includes(searchFilter);
  });
  const rows = filtered.map((p) => {
    const roleLabel = p.role === 'creator' ? 'Freelancer' : (p.role === 'admin' ? 'Admin' : escapeHtml(p.role || ''));
    // Unexpected role strings stay raw; only creator maps to Freelancer.
    return `<tr>
    <td>${escapeHtml(p.display_name || '')}<div class="faint">${escapeHtml(p.email)}</div><details><summary>Account reference</summary><span class="mono">${escapeHtml(p.id)}</span></details></td>
    <td>${roleLabel}</td>
    <td>${badge(p.account_status)}</td>
    <td class="num nowrap">${links[p.id] ? `${links[p.id].links_used} / ${links[p.id].link_limit}` : '-'}</td>
    <td class="num">${Number(p.platform_fee_percent || 0).toFixed(2)}%</td>
    <td class="num nowrap">${wfee[p.id] ? `${Number(wfee[p.id].fee_percent).toFixed(2)}%<div class="faint">${FEE_SOURCE[wfee[p.id].source] || ''}</div>` : '-'}</td>
    <td>${escapeHtml(p.hide_small_payments_mode)}</td>
    <td>${walletLinks(p.id)}</td>
    <td class="num">${money(p.available)}</td>
    <td class="nowrap" data-aw-cell="${escapeHtml(p.id)}">${awCell(p.id)}</td>
    <td><div class="table-actions">
      <button type="button" class="btn ghost sm" data-aw="${escapeHtml(p.id)}" ${awRes.error ? 'disabled' : ''} data-aw-cur="${escapeHtml(aw[p.id]?.override || 'default')}" data-aw-name="${escapeHtml(p.display_name || p.email || '')}">Auto withdraw</button>
      ${links[p.id] ? `<button type="button" class="btn ghost sm" data-limit="${escapeHtml(p.id)}" data-cur="${links[p.id].link_limit}">Link limit</button>` : ''}
      <button type="button" class="btn ghost sm" data-fee="${escapeHtml(p.id)}">Platform fee</button>
      <button type="button" class="btn ghost sm" data-wfee="${escapeHtml(p.id)}" ${feeRes.error ? 'disabled' : ''} data-cur="${wfee[p.id]?.own_fee_percent ?? ''}">Withdraw fee</button>
      <button type="button" class="btn ghost sm" data-hide="${escapeHtml(p.id)}">Hide &lt;$10</button>
      <button type="button" class="btn ghost sm" data-status="${escapeHtml(p.id)}" data-role="${escapeHtml(p.role || 'creator')}" data-st="${escapeHtml(p.account_status || 'active')}">Status</button>
    </div></td>
  </tr>`;
  }).join('');
  const toolbar = typeof deskFilterBar === 'function' ? deskFilterBar(`
    <div class="field short"><label for="peopleStatus">Status</label>
      <select id="peopleStatus">
        <option value="">All</option>
        <option value="active">Active</option>
        <option value="pending">Pending</option>
        <option value="suspended">Suspended</option>
        <option value="rejected">Rejected</option>
      </select></div>
    <div class="field grow"><label for="peopleSearch">Search</label>
      <input id="peopleSearch" type="search" placeholder="Name or email" value="${escapeHtml(peopleFilter.search)}"></div>
  `, `<button type="button" class="btn primary" id="peopleApply">Apply</button>
      <button type="button" class="btn ghost" id="peopleClear">Clear</button><button type="button" class="btn ghost" id="peopleRefresh">Refresh accounts</button>`) : '';
  el.innerHTML = `<div class="card flush">
    ${toolbar}
    ${[usageRes, feeRes, walletsRes, awRes].some(r => r.error) ? '<p class="section-note" role="status">Some account details are unavailable. Refresh accounts to try again.</p>' : ''}
    <div class="card-head"><h3>Accounts</h3><span class="meta-count">${filtered.length} shown · ${people.length} total</span></div>
    <p class="section-note">Review the account identity before changing status, fees or withdrawal settings.</p>
    <div class="scroll"><table class="table"><thead><tr><th>Account</th><th>Role</th><th>Status</th><th class="num">Links</th><th class="num">Platform fee</th><th class="num">Withdraw fee</th><th>Small payments</th><th>Wallet</th><th class="num">Available</th><th>Auto withdraw</th><th></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="11">${typeof deskEmpty === 'function' ? deskEmpty('No accounts match', 'Clear filters or wait for applications.') : '<span class="empty">No accounts</span>'}</td></tr>`}</tbody></table></div>
  </div>`;
  if (document.getElementById('peopleStatus')) document.getElementById('peopleStatus').value = statusFilter;
  document.getElementById('peopleRefresh')?.addEventListener('click', renderPeople);
  document.getElementById('peopleSearch')?.addEventListener('input', e => { peopleFilter.search = e.target.value; });
  document.getElementById('peopleStatus')?.addEventListener('change', e => { peopleFilter.status = e.target.value; });
  document.getElementById('peopleApply')?.addEventListener('click', () => {
    peopleFilter = {
      status: document.getElementById('peopleStatus')?.value || '',
      search: document.getElementById('peopleSearch')?.value.trim() || '',
    };
    renderPeople();
  });
  document.getElementById('peopleClear')?.addEventListener('click', () => {
    peopleFilter = { status: '', search: '' };
    renderPeople();
  });
  document.getElementById('peopleSearch')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('peopleApply')?.click();
  });
  document.querySelectorAll('[data-limit]').forEach((btn) => {
    btn.onclick = async () => {
      const raw = prompt('Active payment links this account may have (0 to 10). A name with several spellings counts as one link.', btn.dataset.cur);
      if (raw == null) return;
      const { error: e } = await sb.rpc('admin_set_link_limit', { p_creator_id: btn.dataset.limit, p_limit: Number(raw) });
      if (e) return toast(e.message);
      toast('Link limit saved', true); renderPeople();
    };
  });
  document.querySelectorAll('[data-fee]').forEach((btn) => {
    btn.onclick = async () => {
      const raw = prompt('Platform fee % on this book\'s settled earnings');
      if (raw == null) return;
      const { error: e } = await sb.rpc('admin_set_platform_fee', { p_user_id: btn.dataset.fee, p_percent: Number(raw) });
      if (e) return toast(e.message);
      toast('Fee saved', true); renderPeople(); renderHome();
    };
  });
  document.querySelectorAll('[data-wfee]').forEach((btn) => {
    btn.onclick = async () => {
      const raw = prompt('Withdrawal fee % for this account only. Leave empty to use the global default.', btn.dataset.cur);
      if (raw == null) return;
      const v = raw.trim() === '' ? null : Number(raw);
      if (v != null && !(v >= 0 && v <= 100)) return toast('Enter 0 to 100, or leave empty');
      const { error: e } = await sb.rpc('admin_update_creator_fee', { p_creator_id: btn.dataset.wfee, p_fee_percent: v });
      if (e) return toast(e.message);
      toast(v == null ? 'Override cleared' : 'Withdrawal fee saved', true); renderPeople();
    };
  });
  document.querySelectorAll('[data-wallet]').forEach((btn) => {
    btn.onclick = async () => {
      const network = prompt('USDT network: tron, bsc, ethereum, polygon, arbitrum, base, optimism, avalanche, solana', 'tron');
      if (network == null) return;
      const address = prompt('USDT address for ' + network.trim().toLowerCase());
      if (!address) return;
      const { error: e } = await sb.rpc('admin_set_user_usdt_wallet', { p_user_id: btn.dataset.wallet, p_network: network.trim().toLowerCase(), p_address: address.trim() });
      if (e) return toast(e.message);
      toast('Wallet link saved', true); renderPeople();
    };
  });
  document.querySelectorAll('[data-status]').forEach((btn) => {
    btn.onclick = async () => {
      const next = prompt('Account status: active, pending, suspended, or rejected', btn.dataset.st || 'active');
      if (next == null) return;
      const status = next.trim().toLowerCase();
      if (!['active','pending','suspended','rejected'].includes(status)) return toast('Use active, pending, suspended, or rejected');
      // Status control never promotes to admin — only preserves an existing admin role.
      const role = btn.dataset.role === 'admin' ? 'admin' : 'creator';
      const { error: e } = await sb.rpc('admin_update_account_control', {
        p_user_id: btn.dataset.status, p_role: role, p_account_status: status, p_review_note: 'Set from Manage users'
      });
      if (e) return toast(e.message);
      toast('Account updated', true); renderPeople();
    };
  });
  document.querySelectorAll('[data-aw]').forEach((btn) => {
    btn.onclick = () => openAutoWithdraw(btn.dataset.aw, btn.dataset.awName, btn.dataset.awCur);
  });
  document.querySelectorAll('[data-hide]').forEach((btn) => {
    btn.onclick = async () => {
      const raw = prompt('inherit / on / off', 'inherit');
      if (!raw) return;
      const { error: e } = await sb.rpc('admin_set_profile_hide_small', { p_user_id: btn.dataset.hide, p_mode: raw.trim() });
      if (e) return toast(e.message);
      toast('Filter saved', true); renderPeople();
    };
  });
}

let applicationFilter = { status: 'pending', search: '' };
let applicationReadVersion = 0;
const applicationBusy = new Set();
async function renderApps() {
  const el = document.getElementById('apps');
  if (!el) return;
  const version = ++applicationReadVersion;
  el.innerHTML = typeof deskSkeleton === 'function' ? deskSkeleton(3) : '<p>Loading…</p>';
  const { data, error } = await adminPanelRead(() => sb.rpc('admin_list_account_applications', { p_status: null }));
  if (version !== applicationReadVersion) return;
  if (error) { adminPanelError(el, error.message, renderApps); return; }
  const all = data || [];
  const query = applicationFilter.search.trim().toLowerCase();
  const filtered = all.filter(a => (!applicationFilter.status || a.status === applicationFilter.status) && `${a.display_name || ''} ${a.email || ''} ${a.id || ''}`.toLowerCase().includes(query));
  const rows = filtered.map(a => {
    const open = ['pending', 'submitted'].includes(String(a.status));
    return `<tr><td>${escapeHtml(a.display_name || a.email)}<div class="faint">${escapeHtml(a.email || '')}</div><details><summary>Review details</summary><dl class="review-details"><dt>Application reference</dt><dd class="mono">${escapeHtml(a.id)}</dd><dt>Submitted</dt><dd>${escapeHtml(when(a.created_at))}</dd><dt>Reviewed</dt><dd>${a.reviewed_at ? escapeHtml(when(a.reviewed_at)) : '—'}</dd><dt>Review note</dt><dd>${escapeHtml(a.review_note || '—')}</dd></dl></details></td>
    <td>${escapeHtml(a.requested_role)}</td><td>${escapeHtml(accountTypeText(a))}</td><td>${badge(a.status)}</td><td class="table-actions">${open ? `<button type="button" class="btn primary sm" data-approve="${escapeHtml(a.id)}" ${applicationBusy.has(a.id) ? 'disabled' : ''}>Approve</button> <button type="button" class="btn danger sm" data-reject="${escapeHtml(a.id)}" ${applicationBusy.has(a.id) ? 'disabled' : ''}>Reject</button>` : ''}</td></tr>`;
  }).join('');
  el.innerHTML = `<div class="card flush"><div class="desk-toolbar" role="search"><div class="field short"><label for="applicationStatus">Status</label><select id="applicationStatus">${[['pending','Pending'],['','All'],['approved','Approved'],['rejected','Rejected'],['suspended','Suspended']].map(([value,label]) => `<option value="${value}" ${value === applicationFilter.status ? 'selected' : ''}>${label}</option>`).join('')}</select></div><div class="field grow"><label for="applicationSearch">Search applications</label><input id="applicationSearch" type="search" placeholder="Name, email or reference" value="${escapeHtml(applicationFilter.search)}"></div><button type="button" class="btn primary" id="applicationApply">Apply</button><button type="button" class="btn ghost" id="applicationClear">Clear</button><button type="button" class="btn ghost" id="applicationRefresh">Refresh applications</button></div><div class="card-head"><h3>Applications</h3><span class="meta-count">${filtered.length} / ${all.length}</span></div><p class="section-note">Only waiting applications have review actions. Open review details for the reference and decision history.</p><div class="scroll"><table class="table"><thead><tr><th>Applicant</th><th>Role</th><th>Account type</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="empty">No applications match these filters.</td></tr>'}</tbody></table></div></div>`;
  document.getElementById('applicationSearch').oninput = e => { applicationFilter.search = e.target.value; };
  document.getElementById('applicationSearch').onkeydown = e => { if (e.key === 'Enter') renderApps(); };
  document.getElementById('applicationStatus').onchange = e => { applicationFilter.status = e.target.value; renderApps(); };
  document.getElementById('applicationApply').onclick = renderApps;
  document.getElementById('applicationRefresh').onclick = renderApps;
  document.getElementById('applicationClear').onclick = () => { applicationFilter = { status: '', search: '' }; renderApps(); };
  el.querySelectorAll('[data-approve]').forEach(b => { b.onclick = () => review(b.dataset.approve, 'approved'); });
  el.querySelectorAll('[data-reject]').forEach(b => { b.onclick = () => review(b.dataset.reject, 'rejected'); });
}
async function review(id, status) {
  if (applicationBusy.has(id)) return;
  applicationBusy.add(id);
  const el = document.getElementById('apps');
  const controls = () => el?.querySelectorAll('[data-approve], [data-reject]') || [];
  controls().forEach(b => { if ((b.dataset.approve || b.dataset.reject) === id) b.disabled = true; });
  try {
    const { error } = await sb.rpc('admin_review_account_application', { p_application_id: id, p_decision: status });
    if (error) throw error;
    toast('Updated', true); renderApps(); renderPeople();
  } catch (error) { toast(error.message || 'Review could not be confirmed. Refresh before trying again.'); }
  finally {
    applicationBusy.delete(id);
    controls().forEach(b => { if ((b.dataset.approve || b.dataset.reject) === id) b.disabled = false; });
  }
}

const FEE_SOURCE = { account: 'own', global: 'global', none: 'global' };

async function renderFees() {
  const { data: settings } = await sb.from('app_settings').select('key, value').in('key', [
    'default_withdrawal_fee_percent','default_platform_fee_percent','hide_small_payments_threshold','hide_small_payments_enabled'
  ]);
  const byKey = Object.fromEntries((settings || []).map((r) => [r.key, r.value]));
  const pct = (v) => Number((v && typeof v === 'object' ? v.percent : v) ?? 0);
  const globalWfee = pct(byKey.default_withdrawal_fee_percent);
  const platformFee = pct(byKey.default_platform_fee_percent);
  const hideAmt = Number(byKey.hide_small_payments_threshold ?? 10);
  const hideOnNow = byKey.hide_small_payments_enabled === true || byKey.hide_small_payments_enabled === 'true';
  document.getElementById('fees').innerHTML = `<div class="card narrow">
    <h3>Withdrawal fee (Balance mode only)</h3>
    <p class="muted">The platform fee on a USDT withdrawal from a CPAY balance. Not used for instant forwarding, which takes only the payment platform fee; the network fee is always automatic. Each account uses its own fee if one is set, else this default. 0 means no platform fee; users then see only the network fee.</p>
    <div class="field short"><label for="defWfee">Default withdrawal fee %</label><input id="defWfee" type="number" min="0" max="100" step="0.1" value="${globalWfee}"></div>
    <button class="btn primary" id="saveDefWfee">Save withdrawal fee</button>
  </div>
  <div class="card narrow">
    <h3>Defaults</h3>
    <p class="muted">Platform fee is CPAY's cut of settled payments. Link cost is added to what the payer pays.</p>
    <div class="field short"><label for="defFee">Platform fee %</label><input id="defFee" type="number" min="0" max="90" step="0.1" value="${platformFee}"></div>
    <button class="btn primary" id="saveDefFee">Save platform fee</button>
  </div>
  <div class="card narrow">
    <h3>Hide small payments</h3>
    <div class="field short"><label for="hideAmt">Hide settled payments under $</label><input id="hideAmt" type="number" min="0" value="${hideAmt}"></div>
    <div class="row">
      <button class="btn ${hideOnNow ? 'primary' : 'ghost'}" id="hideOn" ${hideOnNow ? 'disabled' : ''}>Turn on for everyone</button>
      <button class="btn ${hideOnNow ? 'ghost' : 'primary'}" id="hideOff" ${hideOnNow ? '' : 'disabled'}>Turn off for everyone</button>
      <span class="faint">Now: ${hideOnNow ? 'On' : 'Off'}</span>
    </div>
    <p class="faint" style="margin:12px 0 0">Each account can still override this with inherit, on or off.</p>
  </div>`;
  document.getElementById('saveDefWfee').onclick = async () => {
    const { error } = await sb.rpc('admin_set_default_withdrawal_fee', { p_percent: Number(document.getElementById('defWfee').value) });
    if (error) return toast(error.message);
    toast('Default withdrawal fee saved', true); renderPeople();
  };
  document.getElementById('saveDefFee').onclick = async () => {
    const { error } = await sb.rpc('admin_set_default_platform_fee', { p_percent: Number(document.getElementById('defFee').value) });
    if (error) return toast(error.message);
    toast('Default fee saved', true);
  };
  document.getElementById('hideOn').onclick = () => setHide(true);
  document.getElementById('hideOff').onclick = () => setHide(false);
}
async function setHide(on) {
  const { error } = await sb.rpc('admin_set_hide_small_payments', { p_enabled: on, p_threshold: Number(document.getElementById('hideAmt').value) || 10 });
  if (error) return toast(error.message);
  toast(on ? 'Global filter on' : 'Global filter off', true); renderFees();
}

async function renderFlags() {
  const keys = [
    ['emergency_payments_stop', 'Emergency: stop new customer payments'],
    ['emergency_withdrawals_stop', 'Emergency: stop withdrawals'],
    ['manual_withdrawals_enabled', 'Manual withdrawals enabled'],
    ['auto_withdraw_enabled', 'Auto-queue USDT payouts when a threshold is set'],
    ['hide_small_payments_enabled', 'Global hide-small-payments'],
    ['admin_mfa_required', 'Require two-step sign-in for admins (enrol in Security first)'],
    ['direct_settlement_enabled', 'Direct payments: Freelancers may take payments straight to their own wallet (turning on needs two-step sign-in; see docs/NON-CUSTODIAL-ARCHITECTURE.md)'],
  ];
  const { data, error } = await sb.from('app_settings').select('key, value').in('key', keys.map((r) => r[0]));
  const map = {};
  for (const row of data || []) {
    const v = row.value;
    map[row.key] = v === true || v === 'true' || (v && v.value === true);
  }
  const el = document.getElementById('flags');
  if (!el) return;
  el.innerHTML = `<div class="card flush"><table class="table"><tbody>${keys.map(([k, label]) => {
    const on = map[k] === true;
    return `<tr>
      <td>${escapeHtml(label)}<div class="faint">Now: ${on ? 'On' : 'Off'}</div></td>
      <td class="num" style="white-space:nowrap">
        <button class="btn ${on ? 'primary' : 'ghost'} sm" data-k="${k}" data-v="true" ${on ? 'disabled' : ''}>On</button>
        <button class="btn ${on ? 'ghost' : 'primary'} sm" data-k="${k}" data-v="false" ${on ? '' : 'disabled'}>Off</button>
      </td>
    </tr>`;
  }).join('')}</tbody></table></div>${error ? `<p class="err" role="alert">${escapeHtml(error.message)}</p>` : ''}`;
  el.querySelectorAll('[data-k]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      const { error: e } = await sb.rpc('admin_set_feature_toggle', { p_key: b.dataset.k, p_enabled: b.dataset.v === 'true' });
      if (e) { toast(e.message); b.disabled = false; return; }
      toast('Toggle saved', true);
      renderFlags();
    };
  });
}

// Payment messages go to the admin Telegram group only
// (ALERT_TELEGRAM_CHAT_ID on the telegram-notify function). Per-team
// groups and the daily close were removed in 20261005020000.
function renderAlerts() {
  const el = document.getElementById('alerts');
  if (!el) return;
  el.innerHTML = `<div class="card narrow">
    <h3>Telegram</h3>
    <p class="muted">Every settled payment is posted to the admin Telegram group. Set the group with ALERT_TELEGRAM_CHAT_ID on the telegram-notify function, and stop the messages with ALERT_ON_SETTLED=false.</p>
  </div>`;
}

// One account's Auto withdraw: Default (follow Settings) / On / Off.
// admin_set_auto_withdraw() needs an active admin at aal2 and is audited.
function openAutoWithdraw(userId, name, current) {
  let dlg = document.getElementById('awDialog');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'awDialog';
    dlg.className = 'card';
    dlg.setAttribute('aria-labelledby', 'awDialogTitle');
    dlg.innerHTML = `<form method="dialog">
      <h3 id="awDialogTitle">Auto withdraw</h3>
      <p class="muted" id="awDialogWho"></p>
      <fieldset class="stack"><legend class="sr-only">Auto withdraw</legend>
        <label class="check"><input type="radio" name="awMode" value="default"> Default (follow Settings)</label>
        <label class="check"><input type="radio" name="awMode" value="on"> On: send each payment to their saved address</label>
        <label class="check"><input type="radio" name="awMode" value="off"> Off: add payments to their balance</label>
      </fieldset>
      <p class="faint">Turning it off moves sends that are still waiting back into their balance.</p>
      <p class="faint" id="awDialogStatus" role="status"></p>
      <div class="row"><button type="button" class="btn primary" id="awDialogSave">Save</button><button type="submit" class="btn ghost" value="cancel">Cancel</button></div>
    </form>`;
    document.body.appendChild(dlg);
  }
  const back = document.activeElement;
  dlg.querySelector('#awDialogWho').textContent = name || '';
  dlg.querySelector('#awDialogStatus').textContent = '';
  dlg.querySelectorAll('input[name="awMode"]').forEach((r) => { r.checked = r.value === (current || 'default'); });
  dlg.querySelector('#awDialogSave').onclick = async () => {
    const mode = dlg.querySelector('input[name="awMode"]:checked')?.value || 'default';
    const st = dlg.querySelector('#awDialogStatus');
    st.textContent = 'Saving…';
    const { error: e } = await sb.rpc('admin_set_auto_withdraw', { p_user: userId, p_mode: mode });
    if (e) { st.textContent = e.message; st.className = 'err'; return; }
    dlg.close();
    toast('Auto withdraw saved', true);
    renderPeople();
  };
  dlg.addEventListener('close', () => { if (back && back.focus) back.focus(); }, { once: true });
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
}

async function renderPayouts() {
  const { data, error } = await sb.from('withdrawals').select('*').order('requested_at', { ascending: false }).limit(40);
  if (error) { document.getElementById('payouts').innerHTML = `<p class="err">${escapeHtml(error.message)}</p>`; return; }
  const rows = (data || []).map((w) => `<tr><td class="num">${money(w.amount_requested)}</td><td class="num">${w.fee_percent != null ? Number(w.fee_percent) + '%' : '-'}</td><td class="num">${w.amount_after_fee != null ? money(w.amount_after_fee) : '-'}</td><td>${escapeHtml(methodLabel(w.method, w))}</td><td>${badge(w.status)}</td><td class="mono">${escapeHtml(w.destination || '')}</td><td>${escapeHtml(when(w.requested_at))}</td></tr>`).join('');
  document.getElementById('payouts').innerHTML = `<div class="card flush"><table class="table"><thead><tr><th class="num">Amount</th><th class="num">Fee</th><th class="num">Receives</th><th>Method</th><th>Status</th><th>Destination</th><th>Requested</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="empty">No withdrawals</td></tr>'}</tbody></table></div>
    <p class="faint">Approve, reject and mark-paid actions are in the <a href="admin-classic.html">ops panel</a>.</p>`;
}

async function renderChat() {
  const freelancers = people.filter((p) => p.role !== 'admin');
  const opts = freelancers.map((p) => `<option value="${p.id}">${escapeHtml(p.display_name || p.email)}</option>`).join('');
  document.getElementById('chat').innerHTML = `<div class="card narrow">
    <div class="field"><label for="cWho">Account</label><select id="cWho">${opts}</select></div>
    <div class="thread" id="cThread"></div>
    <div class="compose"><input class="input" id="cMsg" placeholder="Write a message" aria-label="Message"><button class="btn primary" id="cSend">Send</button></div>
  </div>`;
  async function load() {
    const uid = document.getElementById('cWho').value;
    if (!uid) return;
    const { data } = await sb.from('support_messages').select('*').eq('user_id', uid).order('created_at', { ascending: true }).limit(80);
    document.getElementById('cThread').innerHTML = (data || []).map((m) => `<div class="msg"><span class="faint">${escapeHtml(m.sender)}</span>${escapeHtml(m.message)}</div>`).join('') || '<p class="muted">No messages yet</p>';
  }
  document.getElementById('cWho')?.addEventListener('change', load);
  await load();
  document.getElementById('cSend').onclick = async () => {
    const { error } = await sb.from('support_messages').insert({ user_id: document.getElementById('cWho').value, sender: 'admin', message: document.getElementById('cMsg').value.trim() });
    if (error) return toast(error.message);
    load();
  };
}

boot();

const logoutBtn = document.getElementById("logoutBtn");
if (logoutBtn) logoutBtn.onclick = signOut;
