const sb = window.supabaseClient;
const exp = { theme: 'keypad', invoice: 'default', wallet: 'all_wallets' };
let me = null;
let payFilter = { status: '', search: '' };
let linkFilter = { status: '', search: '' };
let homeRenderVersion = 0;
let openLinkComposerRequested = false;
let wdFilter = { status: '' };
let payOffset = 0;
const PAY_PAGE_SIZE = 50;
let payRenderVersion = 0;
let withdrawHistoryVersion = 0;
let profileRenderVersion = 0;
let profileDraft = null;
let memberChatDraft = '';
let memberChatSending = false;
let memberThreadVersion = 0;

// Saved payout addresses are usable at once after a fresh sign-in when the
// change is confirmed with a passkey; without one it is refused (20261021020000).
// my_payout_book returns usable_after.
const PAYOUT_WAIT = 'Confirm with your passkey to change address. It is used right away. You get a notice in your inbox.';
const USDT_HINT = `One address per network. New payments go here automatically if you have no Lightning address. Saving or changing an address asks you to sign in again. ${PAYOUT_WAIT}`;
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
// Opened from CPAY Wallet with an address to fill in (direct-settlement.js).
if (window.cpayDirect && window.cpayDirect.hasPrefill()) show('profile');

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
  if (window.cpayLoc) window.cpayLoc.touch();
  await Promise.all([renderHome(), renderLinks(), renderPays(), renderCash(), renderChat(), renderProfile()]);
}

// Read failures have a local retry; retries never send money or create links.
function deskReadFailure(root, error, retry) {
  root.innerHTML = `<div class="card">${deskError(error?.message || String(error))}<button type="button" class="btn ghost" data-read-retry>Try again</button></div>`;
  root.querySelector('[data-read-retry]').onclick = retry;
}
async function renderHome() {
  const version = ++homeRenderVersion;
  try { await renderHomeContent(version); }
  catch (error) { if (version === homeRenderVersion) deskReadFailure(document.getElementById('home'), error, renderHome); }
}

async function renderHomeContent(version) {
  const home = document.getElementById('home');
  home.innerHTML = deskSkeleton(3);
  const [{ data: bal, error: balErr }, { data: split, error: splitErr }, recent, { data: rs, error: receiveError }] = await Promise.all([
    sb.rpc('get_my_balance'),
    sb.rpc('my_earnings_split'),
    sb.rpc('get_my_payments', { p_limit: 5, p_offset: 0, p_search: null, p_status: null }),
    sb.rpc('my_receive_settings'),
  ]);
  if (version !== homeRenderVersion) return;
  if (balErr || splitErr) {
    deskReadFailure(home, balErr || splitErr, renderHome);
    return;
  }
  const b = Array.isArray(bal) ? bal[0] : bal || {};
  const s = Array.isArray(split) ? split[0] : split || {};
  const icon = (id) => `<svg class="ico" aria-hidden="true"><use href="#${id}"/></svg>`;
  // Auto withdraw on: new payments go to the saved address; only money from
  // before can be withdrawn. Off: payments are added to the balance and the
  // user withdraws by hand. The Withdraw button shows only with a balance.
  const leftover = Number(s.net ?? b.available ?? 0) > 0;
  const autoOn = receiveError || !rs || typeof rs.auto_withdraw !== 'boolean' ? null : rs.auto_withdraw;
  const availNote = autoOn === null ? 'Receiving settings unavailable. Refresh to check your payment mode.' : autoOn
    ? (leftover ? 'Earlier balance, ready to withdraw' : 'New payments are forwarded to your saved address')
    : (leftover ? 'Held by CPAY, ready to withdraw' : 'New payments are added here');
  const recentRows = (recent.data || []).map((p) => {
    const st = String(p.status || '').toLowerCase();
    return `<li class="act-open" role="button" tabindex="0" data-pay-id="${escapeHtml(p.id)}" aria-label="Payment details: ${escapeHtml(money(p.amount_settled || p.amount_requested))} on /${escapeHtml(p.link_slug || '')}"><span class="act-ico ${escapeHtml(st)}" aria-hidden="true">${icon('i-in')}</span>
      <span class="act-main"><b>Payment on /${escapeHtml(p.link_slug || '')}</b><small>${escapeHtml(when(p.settled_at || p.created_at))}</small></span>
      <span class="act-amt${st === 'settled' ? ' plus' : ''}">${money(p.amount_settled || p.amount_requested)}<small>${escapeHtml(st || 'unknown')}</small></span></li>`;
  }).join('');
  const recentHtml = recent.error ? deskError(recent.error.message)
    : (recentRows ? `<ul class="activity" id="recentPays">${recentRows}</ul>` : deskEmpty('No payments yet', 'Share a payment link; payments show up here as they arrive.'));
  // Balance first, then shortcuts and recent activity. Link cost remains
  // on each link; all displayed amount values still come from the RPCs.
  const lead = `<div class="stack home-stack">
    <div class="overview-tools"><p class="faint">Amounts in US dollars</p><button type="button" class="btn ghost sm" id="refreshHome">Refresh overview</button></div>
    <div class="card summary-card" id="homeSummary">
      <div class="summary-grid">
        <div class="summary-available"><div class="kicker">Available</div><div class="kpi" data-kpi>${money(s.net ?? b.available)}</div><div class="faint">${availNote}</div><div class="faint" id="homeAuto">${autoOn === null ? 'Payment mode unavailable' : autoOn ? 'Auto withdraw: On' : 'Auto withdraw: Off'}</div></div>
        <div><div class="kicker">Settled on your links</div><div class="kpi">${money(s.settled)}</div><div class="faint">All time, paid by customers</div></div>
        <div><div class="kicker">Platform fee</div><div class="kpi">${money(s.platform_fee)}</div><div class="faint">All time, CPAY's fee on settled payments</div></div>
      </div>
    </div>
    <div class="home-actions" id="homeActions">
      ${leftover ? `<button type="button" class="btn primary lg" data-jump="cash" id="homeWithdraw">${icon('i-out')}Withdraw</button>` : ''}
      <button type="button" class="btn ghost lg" data-jump="links" data-focus="linkName">${icon('i-plus')}New payment link</button>
    </div>
    <div class="card" id="homeRecent">
      <div class="card-title"><h3>Recent payments</h3><button type="button" class="link-btn" data-jump="pay">View all</button></div>
      <p class="faint">Tap a payment to see its details.</p>
      ${recentHtml}
    </div>
  </div>`;
  home.innerHTML = lead + '<div class="stack" id="dailySelf"><p class="muted">Loading daily summary…</p></div>';
  document.getElementById('refreshHome').onclick = renderHome;
  bindJumps(home);
  if (window.cpayLoc) window.cpayLoc.bindPaymentRows(home);
  // The optional daily breakdown must not hold up balance or navigation.
  const daily = document.getElementById('dailySelf');
  try { await Daily.mountSelf(daily); }
  catch (error) { deskReadFailure(daily, error, renderHome); }
}

// Overview shortcuts open another section through its sidebar button.
function bindJumps(root) {
  root.querySelectorAll('[data-jump]').forEach((btn) => {
    btn.onclick = () => {
      if (btn.dataset.focus === 'linkName') openLinkComposerRequested = true;
      const nav = document.querySelector(`.side .navi[data-tab="${btn.dataset.jump}"]`);
      if (nav) nav.click();
      const target = btn.dataset.focus && document.getElementById(btn.dataset.focus);
      if (target) {
        const panel = target.closest('details');
        if (panel) panel.open = true;
        if (btn.dataset.focus === 'linkName') openLinkComposerRequested = false;
        setTimeout(() => target.focus(), 60);
      }
    };
  });
}

// Local view filters only: ownership and permissions stay in the server query.
function filterPaymentLinks(links, filters) {
  const search = String(filters.search || '').trim().toLocaleLowerCase();
  return links.filter((link) => {
    const status = filters.status === 'live' ? !!link.is_active : filters.status === 'off' ? !link.is_active : true;
    return status && (!search || String(link.slug || '').toLocaleLowerCase().includes(search) || String(link.display_name || '').toLocaleLowerCase().includes(search));
  });
}
async function renderLinks() {
  try { await renderLinksContent(); }
  catch (error) { deskReadFailure(document.getElementById('links'), error, renderLinks); }
}

async function renderLinksContent() {
  const el = document.getElementById('links');
  el.innerHTML = deskSkeleton(3);
  const [{ data: links, error }, ds] = await Promise.all([
    sb.from('payment_links').select('*').eq('user_id', me.id).is('deleted_at', null).order('created_at', { ascending: false }),
    window.cpayDirect ? window.cpayDirect.state() : Promise.resolve(null),
  ]);
  if (error) { deskReadFailure(el, error, renderLinks); return; }
  // Direct payments (direct-settlement.js): a "Payments go to" column once
  // the switch is on or a link already pays the owner's own wallet.
  const direct = window.cpayDirect;
  const showMode = Boolean(direct && ds && (direct.visible(ds) || (links || []).some((l) => l.settlement_mode === 'direct')));
  const rowsFor = (items) => items.map((l) => `<tr>
    <td data-label="Link"><a href="/${escapeHtml(l.slug)}" target="_blank" rel="noopener">/${escapeHtml(l.slug)}</a></td>
    <td data-label="Name">${escapeHtml(l.display_name || '')}</td>
    <td data-label="Design">${escapeHtml(layoutLabel(l.theme))}</td>
    <td data-label="Wallets">${l.wallet_mode === 'cashapp' ? 'Cash App only' : 'All wallets'}</td>
    <td data-label="Status">${badge(l.is_active ? 'live' : 'off')}</td>
    ${showMode ? direct.linkCell(l, ds) || '<td data-label="Payments go to">CPAY balance</td>' : ''}
    <td class="table-actions">
      <a class="btn ghost sm" href="/${escapeHtml(l.slug)}" target="_blank" rel="noopener">Preview</a>
      <button type="button" class="btn ghost sm" data-copy-link="${escapeHtml(l.slug)}" aria-label="Copy the link /${escapeHtml(l.slug)}">Copy link</button>
      <button type="button" class="btn ghost sm" data-toggle-link="${escapeHtml(l.id)}" data-active="${l.is_active ? '1' : '0'}">${l.is_active ? 'Turn off' : 'Turn on'}</button>
      ${showMode ? direct.linkButton(l, ds) : ''}
    </td>
  </tr>`).join('');
  el.innerHTML = `
    <div class="section-intro"><div><h2>Your payment links</h2><p>Find a link, check its status or create a new one.</p></div><button type="button" class="btn primary" id="newLinkBtn">New payment link</button></div>
    <div class="card flush">
      <div class="card-head"><div><h3>Your links</h3><div class="faint">Share a link; payers choose an amount and pay a Lightning invoice.</div></div><div class="meta-count"><span>Links shown</span> <strong id="linkResultsCount" role="status" aria-live="polite"></strong></div></div>
      ${deskFilterBar(`<div class="field grow"><label for="linkSearch">Search links</label><input id="linkSearch" type="search" value="${escapeHtml(linkFilter.search)}" placeholder="Search by name or link" autocomplete="off"></div><div class="field short"><label for="linkStatus">Link status</label><select id="linkStatus"><option value="">All statuses</option><option value="live" ${linkFilter.status === 'live' ? 'selected' : ''}>Live</option><option value="off" ${linkFilter.status === 'off' ? 'selected' : ''}>Off</option></select></div>`, '<button type="button" class="btn ghost" id="clearLinkFilters">Clear filters</button>')}
      <div class="scroll"><table class="table rtable"><thead><tr><th>Link</th><th>Name</th><th>Design</th><th>Wallets</th><th>Status</th>${showMode ? '<th>Payments go to</th>' : ''}<th><span class="sr-only">Actions</span></th></tr></thead>
      <tbody id="linkRows"></tbody></table></div>
    </div>
    <details class="card link-composer" id="linkComposer" ${(links || []).length ? '' : 'open'}>
      <summary><span>New payment link</span><span class="faint">Name, design and payment options</span></summary>
      <div class="link-composer-body">
      <p class="role-note">Payers open your link and pay over Lightning. Your receiving setting decides where the net amount goes.</p>
      <div class="field"><label for="linkName">Display name</label><input id="linkName" placeholder="The name payers see"></div>
      <div class="field"><label for="linkCost">Link cost %</label><input id="linkCost" type="number" min="0" step="0.1" value="${Number(me.cost_percent || 0)}"></div>
      <p class="hint">Added on top of what the payer pays. This is separate from the platform fee.</p>
      ${layoutPicker(exp.theme, exp.wallet, exp.invoice)}
      ${direct && ds ? direct.newLinkChoice(ds) : ''}
      <button class="btn primary" id="makeLink" type="button">Create link</button>
      </div>
    </details>`;
  const openComposer = () => {
    document.getElementById('linkComposer').open = true;
    document.getElementById('linkName').focus();
    openLinkComposerRequested = false;
  };
  if (openLinkComposerRequested) openComposer();
  document.getElementById('newLinkBtn').onclick = openComposer;
  const paintRows = () => {
    const shown = filterPaymentLinks(links || [], linkFilter);
    const empty = (links || []).length ? deskEmpty('No links match', 'Try another search or clear the filters.') : deskEmpty('No links yet', 'Create a payment link to start collecting.');
    document.getElementById('linkRows').innerHTML = rowsFor(shown) || `<tr><td colspan="${showMode ? 7 : 6}">${empty}</td></tr>`;
    document.getElementById('linkResultsCount').textContent = `${shown.length} / ${(links || []).length}`;
    bindLinkRowActions();
  };
  document.getElementById('linkSearch').oninput = (event) => { linkFilter.search = event.target.value; paintRows(); };
  document.getElementById('linkStatus').onchange = (event) => { linkFilter.status = event.target.value; paintRows(); };
  document.getElementById('clearLinkFilters').onclick = () => {
    linkFilter = { status: '', search: '' };
    document.getElementById('linkSearch').value = '';
    document.getElementById('linkStatus').value = '';
    paintRows();
    document.getElementById('linkSearch').focus();
  };
  bindExperience(exp);
  document.getElementById('makeLink').onclick = makeLink;
  function bindLinkRowActions() {
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
        try {
          const { error: e } = await sb.from('payment_links').update({ is_active: next }).eq('id', btn.dataset.toggleLink).eq('user_id', me.id);
          if (e) { toast(e.message); return; }
          const changed = (links || []).find((link) => String(link.id) === btn.dataset.toggleLink);
          if (changed) changed.is_active = next;
          toast(next ? 'Link is live' : 'Link turned off', true);
          paintRows();
        } catch (error) { toast(error.message || 'Could not update the link. Try again.'); }
        finally { btn.disabled = false; }
      };
    });
  }
  paintRows();
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
  const version = ++payRenderVersion;
  try { await renderPaysContent(version); }
  catch (error) { if (version === payRenderVersion) deskReadFailure(document.getElementById('pay'), error, renderPays); }
}
async function renderPaysContent(version) {
  const el = document.getElementById('pay');
  el.innerHTML = deskSkeleton(4);
  const { data, error } = await sb.rpc('get_my_payments', {
    p_limit: PAY_PAGE_SIZE,
    p_offset: payOffset,
    p_search: payFilter.search || null,
    p_status: payFilter.status || null,
  });
  if (version !== payRenderVersion) return;
  if (error) { deskReadFailure(el, error, renderPays); return; }
  const total = data?.[0]?.total_count != null ? Number(data[0].total_count) : (data || []).length;
  const hasNext = (data || []).length === PAY_PAGE_SIZE && (data?.[0]?.total_count == null || payOffset + (data || []).length < total);
  const rows = (data || []).map((p) => `<tr class="row-open" data-pay-id="${escapeHtml(p.id)}" tabindex="0" title="Show details">
    <td class="num" data-label="Amount"><span class="cell-main">${money(p.amount_settled || p.amount_requested)}</span></td>
    <td data-label="Status">${badge(p.status)}</td>
    <td data-label="Link">/${escapeHtml(p.link_slug || '')}</td>
    <td class="mono" data-label="Invoice">${escapeHtml(p.invoice_ref || String(p.id || '').slice(0, 8))}</td>
    <td data-label="When">${escapeHtml(when(p.settled_at || p.created_at))}</td>
    <td data-label="Details"><button type="button" class="btn ghost sm" data-pay-id="${escapeHtml(p.id)}">View details</button></td>
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
  el.innerHTML = `<div class="section-intro"><div><h2>Your payments</h2><p>Search your history, then open a payment to review its details.</p></div></div>
  <div class="card flush">
    ${toolbar}
    <div class="card-head"><h3>Payment history</h3><span class="meta-count"><span>Matching payments</span> <strong>${total}</strong></span></div>
    <div class="scroll"><table class="table rtable"><thead><tr><th class="num">Amount</th><th>Status</th><th>Link</th><th>Invoice</th><th>When</th><th>Details</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="6">${deskEmpty('No payments match', 'Try another status or clear filters.')}</td></tr>`}</tbody></table></div>
    <div class="history-pagination"><p class="faint"><span>Showing</span> <strong>${(data || []).length ? `${payOffset + 1}–${payOffset + data.length}` : '0'}</strong></p><div class="row"><button type="button" class="btn ghost sm" id="payPrevious" ${payOffset ? '' : 'disabled'}>Previous</button><button type="button" class="btn ghost sm" id="payNext" ${hasNext ? '' : 'disabled'}>Next</button></div></div>
  </div>
  <div id="directPays" hidden></div>`;
  if (window.cpayDirect) window.cpayDirect.paymentsCard(document.getElementById('directPays'));
  if (window.cpayLoc) window.cpayLoc.bindPaymentRows(el);
  const statusEl = document.getElementById('payStatus');
  if (statusEl) statusEl.value = payFilter.status || '';
  document.getElementById('payPrevious').onclick = () => { if (payOffset > 0) { payOffset = Math.max(0, payOffset - PAY_PAGE_SIZE); renderPays(); } };
  document.getElementById('payNext').onclick = () => { if (hasNext) { payOffset += PAY_PAGE_SIZE; renderPays(); } };
  document.getElementById('payApply').onclick = () => {
    payOffset = 0;
    payFilter = {
      status: document.getElementById('payStatus').value,
      search: document.getElementById('paySearch').value.trim(),
    };
    renderPays();
  };
  document.getElementById('payClear').onclick = () => {
    payOffset = 0;
    payFilter = { status: '', search: '' };
    renderPays();
  };
  document.getElementById('paySearch').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); document.getElementById('payApply').click(); }
  });
}

async function renderWithdrawHistory() {
  const host = document.getElementById('wHist');
  if (!host) return;
  const version = ++withdrawHistoryVersion;
  try { await renderWithdrawHistoryContent(host, version); }
  catch (error) { if (version === withdrawHistoryVersion) deskReadFailure(host, error, renderWithdrawHistory); }
}
async function renderWithdrawHistoryContent(host, version) {
  host.innerHTML = deskSkeleton(3);
  let q = sb.from('withdrawals')
    .select('requested_at,status,method,chain,coin,amount_requested,amount_after_fee,quoted_fee,amount_out,destination,processed_at,admin_note')
    .order('requested_at', { ascending: false })
    .limit(40);
  if (wdFilter.status) q = q.eq('status', wdFilter.status);
  const { data, error } = await q;
  if (version !== withdrawHistoryVersion || document.getElementById('wHist') !== host) return;
  if (error) { deskReadFailure(host, error, renderWithdrawHistory); return; }
  const rows = (data || []).map((w) => `<tr>
    <td data-label="When">${escapeHtml(when(w.requested_at))}</td>
    <td data-label="Status">${badge(w.status)}</td>
    <td data-label="Network">${escapeHtml(w.method === 'lightning' ? 'Lightning' : (w.chain || w.coin || 'USDT'))}</td>
    <td class="num" data-label="Requested">${money(w.amount_requested)}</td>
    <td class="num" data-label="After fee"><span class="cell-main">${money(w.amount_after_fee)}</span></td>
    <td class="mono" data-label="Address" title="${escapeHtml(w.destination || '')}">${escapeHtml(String(w.destination || '').slice(0, 18))}</td>
    <td data-label="Details"><details><summary>Details</summary><dl class="faint">
      <div><dt>Sent</dt><dd>${escapeHtml(w.amount_out != null ? `${w.amount_out} ${w.method === 'lightning' ? 'sats' : (w.coin || 'USDT')}` : '-')}</dd></div>
      <div><dt>Finished</dt><dd>${escapeHtml(w.processed_at ? when(w.processed_at) : '-')}</dd></div>
      ${w.status === 'failed' && w.admin_note ? `<div><dt>Note</dt><dd>${escapeHtml(String(w.admin_note).slice(0, 160))}</dd></div>` : ''}
      <div><dt>To</dt><dd class="mono">${escapeHtml(w.destination || '')}</dd></div></dl></details></td>
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
    <div class="card-head"><div><h3>Withdrawal history</h3><p class="faint">Up to 40 latest matching withdrawals.</p></div><div><span class="meta-count">${(data || []).length}</span> <button type="button" class="btn ghost sm" id="wdRefresh">Refresh history</button></div></div>
    <div class="scroll"><table class="table rtable"><thead><tr><th>When</th><th>Status</th><th>Network</th><th class="num">Requested</th><th class="num">After fee</th><th>Address</th><th>Details</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="7">${wdFilter.status ? deskEmpty('No withdrawals match', 'Try another status or clear the filter.') : deskEmpty('No withdrawals yet', 'Confirmed withdrawals show up here.')}</td></tr>`}</tbody></table></div>
  </div>`;
  document.getElementById('wdRefresh').onclick = renderWithdrawHistory;
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
  try { await renderCashContent(); }
  catch (error) { deskReadFailure(document.getElementById('cash'), error, renderCash); }
}
async function renderCashContent() {
  const el = document.getElementById('cash');
  el.innerHTML = deskSkeleton(3);
  const [{ data: bal, error: balErr }, { data: ws, error: wsErr }, { data: book, error: bookErr }, { data: rs, error: receiveError }] = await Promise.all([
    sb.rpc('get_my_balance'),
    sb.rpc('my_withdraw_settings'),
    sb.rpc('my_payout_book'),
    sb.rpc('my_receive_settings'),
  ]);
  if (balErr || wsErr || bookErr) {
    deskReadFailure(el, balErr || wsErr || bookErr, renderCash);
    return;
  }
  const b = Array.isArray(bal) ? bal[0] : bal || {};
  const fee = Number(ws?.fee_percent ?? 0);
  const wallets = book?.wallets || [];
  const autoOn = receiveError || !rs || typeof rs.auto_withdraw !== 'boolean' ? null : rs.auto_withdraw;
  const lnSaved = rs?.lightning_address || null;
  let availNow = Number(b.available || 0);
  const savedNote = (wallets.length
    ? `<p class="hint">Saved USDT wallets: ${wallets.map((w) => `${escapeHtml(netLabel(w.network))} (${readyText(w)})`).join(', ')}. Open Profile to add more networks.</p>`
    : `<p class="hint">USDT goes only to an address saved in Profile.</p>`)
    + (lnSaved ? `<p class="hint">Saved Lightning address: <code>${escapeHtml(lnSaved)}</code></p>` : `<p class="hint">For Lightning, paste a Lightning invoice, or save a Lightning address in Profile.</p>`);
  const autoNote = `<p class="hint" id="wAuto">${autoOn === null ? 'Receiving settings unavailable. Your available balance is still shown.' : autoOn
    ? 'Auto withdraw is on: new payments go to your saved address by themselves. Use this page for money that is still in your balance.'
    : 'Auto withdraw is off: payments are added to your balance. Withdraw here whenever you like.'}</p>`;
  const journey = `<div class="section-intro"><div><h2>Withdraw your balance</h2><p>Choose a destination, review the quote and confirm with your passkey.</p></div></div>
    <ol class="withdraw-journey" aria-label="Withdrawal steps"><li><strong>1</strong><span>Choose destination and amount</span></li><li><strong>2</strong><span>Review what you receive</span></li><li><strong>3</strong><span>Confirm with your passkey</span></li></ol>`;
  if (!(availNow > 0)) {
    el.innerHTML = journey + `<div class="card" id="wNone"><h3>Withdraw</h3><p class="muted">Available balance <strong id="wAvail">${money(0)}</strong></p>${autoNote}
      <p class="faint">Nothing to withdraw right now.</p>${savedNote}<button type="button" class="btn ghost" data-jump="profile">Manage saved addresses</button></div><div id="wHist"></div>`;
    bindJumps(el);
    renderWithdrawHistory();
    return;
  }
  el.innerHTML = journey + withdrawForm(`<p class="muted">Available balance <strong id="wAvail">${money(b.available)}</strong>, held by CPAY</p>`
    + autoNote + savedNote)
    + '<div class="withdraw-history-head"><p class="faint">History can be refreshed without changing your current quote.</p></div><div id="wHist"></div>';
  bindWithdraw(() => fee, {
    saved: wallets,
    savedLightning: lnSaved,
    available: () => availNow,
    preferredNetwork: book?.preferred_usdt_network || null,
    onDone: async () => {
      renderHome();
      renderWithdrawHistory();
      const { data: now } = await sb.rpc('get_my_balance');
      const nb = Array.isArray(now) ? now[0] : now || {};
      availNow = Number(nb.available || 0);
      const avail = document.getElementById('wAvail');
      if (avail) avail.textContent = money(nb.available);
    },
  });
  renderWithdrawHistory();
}

async function renderChat() {
  if (memberChatSending) return;
  const el = document.getElementById('chat');
  el.innerHTML = `<div class="section-intro"><div><h2>Account support</h2><p>Keep questions and replies together in one conversation.</p></div></div>
    <div class="card chat-card"><div class="card-title"><div><h3>Messages with the admin</h3><p class="faint">Latest 80 messages, oldest to newest.</p></div><button type="button" class="btn ghost sm" id="refreshMemberChat">Refresh messages</button></div>
      <div class="thread conversation-log" id="memberThread" role="log" aria-label="Conversation messages" aria-live="off"></div>
      <div class="field chat-composer"><label for="adminMsg">Message to the admin</label><textarea id="adminMsg" rows="3" aria-describedby="memberChatHelp">${escapeHtml(memberChatDraft)}</textarea></div>
      <div class="chat-compose-actions"><p class="faint" id="memberChatHelp">Ctrl+Enter or Command+Enter sends. Enter starts a new line.</p><button class="btn primary" id="sendAdmin" type="button">Send</button></div>
      <p class="chat-feedback" id="memberChatStatus" role="status" aria-live="polite"></p></div>`;
  const input = document.getElementById('adminMsg');
  input.oninput = () => { memberChatDraft = input.value; };
  input.onkeydown = (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); sendMemberMessage(); } };
  document.getElementById('sendAdmin').onclick = sendMemberMessage;
  document.getElementById('refreshMemberChat').onclick = loadMemberThread;
  await loadMemberThread();
}
async function loadMemberThread() {
  const host = document.getElementById('memberThread');
  if (!host) return;
  const version = ++memberThreadVersion;
  host.innerHTML = deskSkeleton(2);
  try {
    const { data: newestFirst, error } = await sb.from('support_messages').select('*').eq('user_id', me.id).order('created_at', { ascending: false }).limit(80);
    if (version !== memberThreadVersion || document.getElementById('memberThread') !== host) return;
    if (error) { deskReadFailure(host, error, loadMemberThread); return; }
    const rows = (newestFirst || []).slice().reverse();
    host.innerHTML = rows.map((m) => `<div class="msg${m.sender === 'admin' ? '' : ' mine'}"><div class="chat-message-meta"><span>${m.sender === 'admin' ? 'Admin' : 'You'}</span><time>${escapeHtml(when(m.created_at))}</time></div><div class="message-body">${escapeHtml(m.message)}</div></div>`).join('') || deskEmpty('No messages yet', 'Write the admin if you need help with your account.');
    host.scrollTop = host.scrollHeight;
  } catch (error) { if (version === memberThreadVersion) deskReadFailure(host, error, loadMemberThread); }
}
async function sendMemberMessage() {
  if (memberChatSending) return;
  const input = document.getElementById('adminMsg');
  const text = input.value.trim();
  if (!text) return toast('Write a message first');
  const button = document.getElementById('sendAdmin');
  const status = document.getElementById('memberChatStatus');
  memberChatDraft = input.value;
  memberChatSending = true;
  button.disabled = true;
  status.textContent = 'Sending message…';
  try {
    const { error } = await sb.from('support_messages').insert({ user_id: me.id, sender: 'creator', message: text });
    if (error) { status.textContent = 'Send could not be confirmed. Your draft is kept.'; return; }
    if (input.value.trim() === text) input.value = '';
    memberChatDraft = input.value;
    status.textContent = 'Message sent.';
    await loadMemberThread();
  } catch (error) { status.textContent = 'Send could not be confirmed. Your draft is kept.'; }
  finally { memberChatSending = false; button.disabled = false; }
}

async function profileAction(button, action) {
  if (button.disabled) return;
  button.disabled = true;
  try { await action(); }
  catch (error) { toast('The action did not finish. Check your connection and try again.'); }
  finally { button.disabled = false; }
}
async function renderProfile() {
  const version = ++profileRenderVersion;
  try { await renderProfileContent(version); }
  catch (error) { if (version === profileRenderVersion) deskReadFailure(document.getElementById('profile'), error, renderProfile); }
}
async function renderProfileContent(version) {
  const el = document.getElementById('profile');
  el.innerHTML = deskSkeleton(2);
  const [{ data: book, error }, { data: rs, error: receiveError }] = await Promise.all([sb.rpc('my_payout_book'), sb.rpc('my_receive_settings')]);
  if (version !== profileRenderVersion) return;
  if (error) { deskReadFailure(el, error, renderProfile); return; }
  const receivingUnknown = Boolean(receiveError || !rs || typeof rs.auto_withdraw !== 'boolean');
  const profileView = profileDraft || me;
  const wallets = book?.wallets || [];
  const netOpts = USDT_NETWORKS.map(([id, label]) => `<option value="${id}">${label}</option>`).join('');
  const prefOpts = `<option value="">None yet</option>` + USDT_NETWORKS.map(([id, label]) =>
    `<option value="${id}" ${book?.preferred_usdt_network === id ? 'selected' : ''}>${label}</option>`).join('');
  const rows = wallets.map((w) => {
    return `<tr><td data-label="Network">${escapeHtml(netLabel(w.network))}</td><td data-label="Address" class="mono"><code>${escapeHtml(w.address)}</code></td><td data-label="Status">${readyText(w)}</td>
      <td class="table-actions"><button type="button" class="btn ghost sm" data-del-net="${escapeHtml(w.network)}">Remove</button></td></tr>`;
  }).join('');
  // No choice to make: saving a USDT or Lightning address is enough
  // (receive_target_for, 20261020080000). Lightning first, then USDT.
  const target = rs?.target_address || '';
  const where = rs?.method === 'usdt' ? `USDT on ${netLabel(rs.usdt_network)}` : rs?.method === 'lightning' ? 'Lightning address' : '';
  el.innerHTML = `<div class="section-intro"><div><h2>Your profile and addresses</h2><p>Keep public information separate from your private receiving details.</p></div></div>
  <nav class="profile-sections" aria-label="Profile sections"><a href="#publicProfileCard">Public profile</a><a href="#savedUsdtCard">Saved USDT addresses</a><a href="#receiveCard">Receiving mode</a><a href="#locationHost">Account location</a></nav>
  <div id="profileReceiveHost"></div>
  <div class="grid split profile-workspace">
    <div class="card" id="publicProfileCard" tabindex="-1">
      <div class="card-title"><h3>Public profile</h3><span class="badge">Visible to payers</span></div>
      <p class="role-note">Storefront settings for your public page. Display name is what payers see.</p>
      <div class="field"><label for="pName">Display name</label><input id="pName" value="${escapeHtml(profileView.display_name || '')}"></div>
      <div class="field"><label for="pBio">Bio</label><textarea id="pBio">${escapeHtml(profileView.bio || '')}</textarea></div>
      <div class="field"><label for="pSlug">Store address</label><input id="pSlug" aria-describedby="storeSlugHint" autocapitalize="none" spellcheck="false" value="${escapeHtml(profileView.public_slug || '')}"></div>
      <p class="hint" id="storeSlugHint">Use 3–48 lowercase letters, numbers or hyphens.</p>
      <div class="row"><button class="btn primary" id="saveProf" type="button">Save profile</button><a class="btn ghost" href="store.html?u=${encodeURIComponent(me.id)}">Open public store</a></div>
    </div>
    <div class="card" id="savedUsdtCard" tabindex="-1">
      <div class="card-title"><h3>USDT addresses</h3><span class="badge">Private account settings</span></div>
      <p class="hint" id="usdtAddressHint">One address per network. When Auto withdraw is on and no Lightning address is saved, new payments use your USDT address. Saving or changing an address requires your passkey; it is usable right away.</p>
      <div class="field"><label for="usdtNet">Network</label><select id="usdtNet">${netOpts}</select></div>
      <div class="field"><label for="usdtAddr">Wallet address</label><input id="usdtAddr" aria-describedby="usdtAddressHint" placeholder="Address for that network" autocomplete="off" spellcheck="false"></div>
      <button class="btn primary" id="saveUsdt" type="button">Save address</button>
      <div class="card flush profile-address-list">
        <table class="table rtable"><thead><tr><th>Network</th><th>Address</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4">${deskEmpty('No USDT address saved', 'Add a network address before withdrawing.')}</td></tr>`}</tbody></table>
      </div>
      <details class="profile-preferences" id="payoutPreferences"><summary>Balance payout preferences</summary>
      <p class="hint">These threshold settings do not change the receiving mode shown above.</p>
      <div class="field"><label for="prefNet">Preferred network</label><select id="prefNet">${prefOpts}</select></div>
      <div class="field"><label for="thresh">USDT payout threshold (USD)</label>
        <input id="thresh" type="number" min="5" step="1" placeholder="Leave empty to only withdraw by hand" value="${escapeHtml(book?.withdraw_threshold ?? '')}"></div>
      <label class="check"><input type="checkbox" id="autoOn" ${book?.auto_withdraw_enabled ? 'checked' : ''}> Queue a USDT payout when the balance reaches the threshold</label>
      <button class="btn ghost" id="savePrefs" type="button">Save payout settings</button>
      </details>
    </div>
  </div><div id="directCard" hidden></div><div id="locationHost" tabindex="-1"></div>`;
  // Built from DOM nodes: the address is account data.
  const node = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text ? { textContent: text } : {});
  const recvCard = node('div', 'card');
  recvCard.id = 'receiveCard';
  recvCard.tabIndex = -1;
  const head = node('div', 'card-title');
  const headIn = node('div');
  headIn.append(node('h3', '', 'Where to receive'),
    node('p', 'faint', receivingUnknown ? 'Receiving settings unavailable. Refresh to check your payment mode.' : rs?.auto_withdraw
      ? 'CPAY receives each payment, keeps its fee and forwards the rest to your saved address. Amounts waiting to be sent remain owed to you.'
      : 'CPAY receives each payment, keeps its fee and adds the rest to your balance. You withdraw when you like.'));
  head.append(headIn);
  const autoLine = node('p');
  autoLine.id = 'recvAuto';
  autoLine.append('Auto withdraw: ', node('strong', '', receivingUnknown ? 'Unavailable' : rs?.auto_withdraw ? 'On' : 'Off'),
    rs?.auto_withdraw_source === 'account' ? ' (set for your account by the admin)' : '');
  const recvNow = node('p');
  recvNow.id = 'recvNow';
  if (receivingUnknown) {
    recvNow.textContent = 'Your saved addresses are listed below. The current receiving mode could not be checked.';
  } else if (!rs?.auto_withdraw) {
    recvNow.textContent = 'Payments are added to your CPAY balance. Open Withdraw to send money to your Lightning or USDT address.';
  } else if (target) {
    recvNow.append('Payments go to: ', node('strong', '', where), ' ', node('code', '', target));
  } else if (wallets.length) {
    recvNow.textContent = 'Your saved address is not ready yet. Payments start once it is.';
  } else {
    recvNow.className = 'err';
    recvNow.textContent = 'No address yet. Save a USDT or Lightning address to start receiving payments.';
  }
  recvCard.append(head, autoLine, recvNow, node('p', 'hint', 'Save a USDT address below or a Lightning address. If you save both, Lightning is used.'));
  document.getElementById('profileReceiveHost').append(recvCard);
  const mountPanel = (host, mount) => Promise.resolve().then(mount).catch((failure) => { host.hidden = false; deskReadFailure(host, failure, () => mountPanel(host, mount)); });
  if (window.cpayLoc) { const host = document.getElementById('locationHost'); mountPanel(host, () => window.cpayLoc.profileCard(host)); }
  if (window.cpayDirect) { const host = document.getElementById('directCard'); mountPanel(host, () => window.cpayDirect.card(host, () => { renderProfile(); renderLinks(); })); }
  ['pName', 'pBio', 'pSlug'].forEach((id) => document.getElementById(id).addEventListener('input', () => {
    profileDraft = { display_name: document.getElementById('pName').value, bio: document.getElementById('pBio').value, public_slug: document.getElementById('pSlug').value };
  }));
  document.getElementById('saveProf').onclick = () => profileAction(document.getElementById('saveProf'), async () => {
    const { error: e } = await sb.rpc('update_my_public_profile', {
      p_display_name: document.getElementById('pName').value,
      p_bio: document.getElementById('pBio').value,
      p_public_slug: document.getElementById('pSlug').value,
    });
    if (e) return toast(e.message);
    toast('Saved', true);
  });
  document.getElementById('saveUsdt').onclick = () => profileAction(document.getElementById('saveUsdt'), async () => {
    // A change needs a fresh sign-in (20261020040000): the database answers
    // "reauth_required: ..." and the step-up dialog asks once, then retries.
    const call = () => sb.rpc('set_my_usdt_wallet', {
      p_network: document.getElementById('usdtNet').value,
      p_address: document.getElementById('usdtAddr').value.trim(),
    });
    const needsReauth = (r) => /^reauth_required|Confirm with your passkey to change address/.test(String(r?.error?.message || ''));
    const { error: e } = window.cpayWithStepUp ? await window.cpayWithStepUp(call, needsReauth) : await call();
    if (e) return toast(String(e.message).replace(/^reauth_required:\s*/, ''));
    toast('USDT address saved', true);
    renderProfile();
  });
  document.querySelectorAll('[data-del-net]').forEach((btn) => {
    btn.onclick = () => profileAction(btn, async () => {
      if (!window.confirm(window.cpayI18n ? window.cpayI18n.t('Remove this saved address?') : 'Remove this saved address?')) return;
      const { error: e } = await sb.rpc('delete_my_usdt_wallet', { p_network: btn.dataset.delNet });
      if (e) return toast(e.message);
      renderProfile();
    });
  });
  document.getElementById('savePrefs').onclick = () => profileAction(document.getElementById('savePrefs'), async () => {
    const raw = document.getElementById('thresh').value.trim();
    const { error: e } = await sb.rpc('set_my_payout_prefs', {
      p_threshold: raw === '' ? null : Number(raw),
      p_network: document.getElementById('prefNet').value || null,
      p_auto_enabled: document.getElementById('autoOn').checked,
    });
    if (e) return toast(e.message);
    toast('Payout settings saved', true);
  });
}

boot();

const logoutBtn = document.getElementById('logoutBtn');
if (logoutBtn) logoutBtn.onclick = signOut;
