// After admin-desk.js. Puts Ops actions on this page using the same RPCs.
async function adminFn(path, body) {
  const { data: sess } = await sb.auth.getSession();
  const token = sess?.session?.access_token;
  const res = await fetch(`${window.SUPABASE_URL}/functions/v1/admin-actions/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(payload.error || 'Request failed'); err.code = payload.code; throw err; }
  return payload;
}

let payoutFilter = { status: '', search: '' };
let payoutReadVersion = 0;
const payoutBusy = new Set();
async function renderPayouts() {
  const el = document.getElementById('payouts');
  if (!el) return;
  const version = ++payoutReadVersion;
  el.innerHTML = typeof deskSkeleton === 'function' ? deskSkeleton(4) : '<p class="muted">Loading…</p>';
  const { data, error } = await adminPanelRead(() => sb.from('withdrawals').select('*').order('requested_at', { ascending: false }).limit(120));
  if (version !== payoutReadVersion) return;
  if (error) { adminPanelError(el, error.message, renderPayouts); return; }
  const q = (payoutFilter.search || '').trim().toLowerCase();
  const filtered = (data || []).filter((w) => {
    if (payoutFilter.status && String(w.status) !== payoutFilter.status) return false;
    if (!q) return true;
    const hay = `${w.destination || ''} ${w.method || ''} ${w.chain || ''} ${w.id || ''}`.toLowerCase();
    return hay.includes(q);
  });
  const rows = filtered.map((w) => {
    const open = ['pending', 'approved', 'processing'].includes(String(w.status));
    const acts = open ? `<button type="button" class="btn primary sm" data-wd="${escapeHtml(w.id)}" ${payoutBusy.has(w.id) ? 'disabled' : ''} data-act="mark_paid_manual">Mark paid</button> <button type="button" class="btn danger sm" data-wd="${escapeHtml(w.id)}" ${payoutBusy.has(w.id) ? 'disabled' : ''} data-act="reject">Reject</button>` : '';
    return `<tr><td class="num" data-label="Amount">${money(w.amount_requested)}</td><td class="num" data-label="Fee">${w.fee_percent != null ? Number(w.fee_percent) + '%' : '-'}</td><td class="num" data-label="Receives">${w.amount_after_fee != null ? money(w.amount_after_fee) : '-'}</td><td data-label="Network">${escapeHtml(methodLabel(w.method, w))}</td><td data-label="Status">${badge(w.status)}</td><td class="mono" data-label="Address" title="${escapeHtml(w.destination || '')}">${escapeHtml(w.destination || '')}</td><td data-label="Requested">${escapeHtml(when(w.requested_at))}</td><td class="table-actions"><details><summary>Payout details</summary><dl class="review-details"><dt>Request reference</dt><dd class="mono">${escapeHtml(w.id)}</dd><dt>Account reference</dt><dd class="mono">${escapeHtml(w.user_id || '—')}</dd><dt>Payout reference</dt><dd class="mono">${escapeHtml(w.payout_ref || '—')}</dd><dt>Processed</dt><dd>${w.processed_at ? escapeHtml(when(w.processed_at)) : '—'}</dd><dt>Note</dt><dd>${escapeHtml(w.admin_note || '—')}</dd></dl>${w.status === 'failed' ? '<p class="faint">Check the payout reference and provider result before taking another action.</p>' : ''}</details>${acts}</td></tr>`;
  }).join('');
  const toolbar = typeof deskFilterBar === 'function' ? deskFilterBar(`
    <div class="field short"><label for="payoutStatus">Status</label>
      <select id="payoutStatus">
        <option value="">All</option>
        <option value="pending">Pending</option>
        <option value="approved">Approved</option>
        <option value="processing">Processing</option>
        <option value="sending">Sending</option>
        <option value="paid">Paid</option>
        <option value="failed">Failed</option>
        <option value="rejected">Rejected</option>
      </select></div>
    <div class="field grow"><label for="payoutSearch">Search</label>
      <input id="payoutSearch" type="search" placeholder="Address, method, id" value="${escapeHtml(payoutFilter.search)}"></div>
  `, `<button type="button" class="btn primary" id="payoutApply">Apply</button>
      <button type="button" class="btn ghost" id="payoutClear">Clear</button><button type="button" class="btn ghost" id="payoutRefresh">Refresh payouts</button>`) : '';
  el.innerHTML = `<div class="card flush">
    ${toolbar}
    <div class="card-head"><h3>Payouts</h3><span class="meta-count">${filtered.length} shown</span></div>
    <p class="section-note">Filters apply to the latest 120 requests. Open payout details to check the reference and note before marking a request paid or rejecting it.</p>
    <div class="scroll"><table class="table rtable"><thead><tr><th class="num">Amount</th><th class="num">Fee</th><th class="num">Receives</th><th>Network</th><th>Status</th><th>Address</th><th>Requested</th><th></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="8">${typeof deskEmpty === 'function' ? deskEmpty('No payouts match', 'Clear filters or wait for withdrawal requests.') : '<span class="empty">No withdrawals</span>'}</td></tr>`}</tbody></table></div>
  </div>`;
  const st = document.getElementById('payoutStatus');
  if (st) st.value = payoutFilter.status || '';
  document.getElementById('payoutApply')?.addEventListener('click', () => {
    payoutFilter = {
      status: document.getElementById('payoutStatus')?.value || '',
      search: document.getElementById('payoutSearch')?.value.trim() || '',
    };
    renderPayouts();
  });
  document.getElementById('payoutClear')?.addEventListener('click', () => {
    payoutFilter = { status: '', search: '' };
    renderPayouts();
  });
  document.getElementById('payoutRefresh')?.addEventListener('click', renderPayouts);
  document.getElementById('payoutSearch')?.addEventListener('input', e => { payoutFilter.search = e.target.value; });
  document.getElementById('payoutStatus')?.addEventListener('change', e => { payoutFilter.status = e.target.value; });
  document.getElementById('payoutSearch')?.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('payoutApply')?.click(); });
  el.querySelectorAll('[data-wd]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.wd;
      if (payoutBusy.has(id)) return;
      payoutBusy.add(id);
      const controls = () => el.querySelectorAll('[data-wd]');
      controls().forEach(b => { if (b.dataset.wd === id) b.disabled = true; });
      try {
        const run = () => adminFn('process-withdrawal', { withdrawalId: btn.dataset.wd, action: btn.dataset.act });
        // "Mark paid" needs a recent sign-in, like a send (admin-actions step-up).
        await (window.cpayWithStepUp ? window.cpayWithStepUp(run) : run());
        toast(btn.dataset.act === 'reject' ? 'Rejected' : 'Marked paid', true);
        renderPayouts(); renderHome();
      } catch (e) { toast(e.message); }
      finally { payoutBusy.delete(id); controls().forEach(b => { if (b.dataset.wd === id) b.disabled = false; }); }
    };
  });
}

let paymentFilter = { search: '', status: '' };
async function renderPayments() {
  const el = document.getElementById('payments');
  if (!el) return;
  // Payment cards (pay-cards.js): tap a payment for its full details. The
  // table below stays as the fallback when that script is not loaded.
  if (window.cpayPayCards) {
    window.cpayPayCards.mount(el, {
      mode: 'admin', title: 'All payments', pageSize: 50,
      fetch: async ({ offset, limit, search }) => {
        const { data, error } = await sb.rpc('admin_list_payments', { p_limit: limit, p_offset: offset, p_search: search });
        return { rows: data || [], error };
      },
      actions: (p) => (p.status !== 'settled' && p.status !== 'expired') ? [{
        label: 'Mark settled', cls: 'btn ghost sm',
        run: async () => {
          try { await adminFn('admin-mark-settled', { paymentId: p.id }); toast('Marked settled', true); renderPayments(); renderHome(); renderPayouts(); }
          catch (e) { toast(e.message); }
        },
      }] : [],
    });
    return;
  }
  // Loading: text only (no innerHTML) so XSS unit tests stay green.
  const loading = document.createElement('p');
  loading.className = 'muted';
  loading.textContent = 'Loading…';
  el.replaceChildren(loading);

  const { data, error } = await sb.rpc('admin_list_payments', {
    p_limit: 100,
    p_offset: 0,
    p_search: paymentFilter.search || null,
  });
  if (error) {
    const message = document.createElement('p');
    message.className = 'err';
    message.setAttribute('role', 'alert');
    message.textContent = error.message;
    el.replaceChildren(message);
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'card flush';

  const toolbar = document.createElement('div');
  toolbar.className = 'desk-toolbar';
  toolbar.setAttribute('role', 'search');

  const statusField = document.createElement('div');
  statusField.className = 'field short';
  const statusLabel = document.createElement('label');
  statusLabel.htmlFor = 'adminPayStatus';
  statusLabel.textContent = 'Status';
  const statusSelect = document.createElement('select');
  statusSelect.id = 'adminPayStatus';
  for (const [value, label] of [['', 'All'], ['settled', 'Settled'], ['pending', 'Pending'], ['new', 'New'], ['expired', 'Expired'], ['invalid', 'Invalid']]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    if (value === (paymentFilter.status || '')) opt.selected = true;
    statusSelect.append(opt);
  }
  statusField.append(statusLabel); statusField.append(statusSelect);

  const searchField = document.createElement('div');
  searchField.className = 'field grow';
  const searchLabel = document.createElement('label');
  searchLabel.htmlFor = 'adminPaySearch';
  searchLabel.textContent = 'Search';
  const searchInput = document.createElement('input');
  searchInput.id = 'adminPaySearch';
  searchInput.type = 'search';
  searchInput.placeholder = 'Invoice, email, link slug';
  searchInput.value = paymentFilter.search || '';
  searchField.append(searchLabel); searchField.append(searchInput);

  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'btn primary';
  applyBtn.id = 'adminPayApply';
  applyBtn.textContent = 'Apply';
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'btn ghost';
  clearBtn.id = 'adminPayClear';
  clearBtn.textContent = 'Clear';
  toolbar.append(statusField); toolbar.append(searchField); toolbar.append(applyBtn); toolbar.append(clearBtn);
  wrap.append(toolbar);

  const list = (data || []).filter((p) => !paymentFilter.status || String(p.status) === paymentFilter.status);
  const head = document.createElement('div');
  head.className = 'card-head';
  const h3 = document.createElement('h3');
  h3.textContent = 'Payments';
  const meta = document.createElement('span');
  meta.className = 'meta-count';
  meta.textContent = `${list.length} shown`;
  head.append(h3); head.append(meta);
  wrap.append(head);

  const note = document.createElement('p');
  note.className = 'role-note';
  note.textContent = 'Search uses the admin_list_payments RPC (admin-only). Status filter is applied in the desk for the loaded page.';
  wrap.append(note);

  const scroll = document.createElement('div');
  scroll.className = 'scroll';
  const table = document.createElement('table');
  table.className = 'table rtable';
  const thead = document.createElement('thead');
  const header = document.createElement('tr');
  for (const label of ['When', 'Status', 'Amount', 'Account', 'Link', 'Invoice', '']) {
    const th = document.createElement('th');
    th.textContent = label;
    if (label === 'Amount') th.className = 'num';
    header.append(th);
  }
  thead.append(header);
  table.append(thead);
  const body = document.createElement('tbody');
  const addCell = (row, value, className = '') => {
    const td = document.createElement('td');
    td.textContent = value;
    if (className) td.className = className;
    row.append(td);
    return td;
  };
  if (!list.length) {
    const row = document.createElement('tr');
    const cell = addCell(row, 'No payments match', 'empty');
    cell.colSpan = 7;
    body.append(row);
  } else {
    for (const p of list) {
      const row = document.createElement('tr');
      addCell(row, when(p.settled_at || p.created_at));
      const status = String(p.status || '').toLowerCase();
      const statusCell = document.createElement('td');
      const statusBadge = document.createElement('span');
      statusBadge.className = `badge ${status.replace(/[^a-z0-9_-]/g, '')}`;
      statusBadge.textContent = status || 'unknown';
      statusCell.append(statusBadge);
      row.append(statusCell);
      addCell(row, money(p.amount_settled ?? p.amount_requested), 'num');
      addCell(row, p.creator_name || p.creator_email || '');
      addCell(row, p.link_slug || '', 'mono');
      addCell(row, p.invoice_ref || String(p.id).slice(0, 8), 'mono');
      const actionCell = document.createElement('td');
      if (p.status !== 'settled' && p.status !== 'expired') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn ghost sm';
        button.dataset.pay = p.id;
        button.textContent = 'Mark settled';
        actionCell.append(button);
      }
      row.append(actionCell);
      body.append(row);
    }
  }
  table.append(body);
  scroll.append(table);
  wrap.append(scroll);
  el.replaceChildren(wrap);

  applyBtn.onclick = () => {
    paymentFilter = {
      status: statusSelect.value || '',
      search: searchInput.value.trim() || '',
    };
    renderPayments();
  };
  clearBtn.onclick = () => {
    paymentFilter = { status: '', search: '' };
    renderPayments();
  };
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyBtn.click();
  });
  el.querySelectorAll('[data-pay]').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await adminFn('admin-mark-settled', { paymentId: btn.dataset.pay });
        toast('Marked settled', true);
        renderPayments(); renderHome(); renderPayouts();
      } catch (e) { toast(e.message); btn.disabled = false; }
    };
  });
}

async function renderLinks() {
  const el = document.getElementById('links');
  if (!el) return;
  const { data, error } = await sb.rpc('admin_list_payment_links');
  if (error) { el.innerHTML = typeof deskError === 'function' ? deskError(error.message) : `<p class="err" role="alert">${escapeHtml(error.message)}</p>`; return; }
  const rows = (data || []).map((l) => `<tr>
    <td class="mono">${escapeHtml(l.slug)}</td>
    <td>${escapeHtml(l.display_name || '')}</td>
    <td>${escapeHtml(l.owner_name || l.owner_email || '')}</td>
    <td>${l.is_active ? badge('active') : badge('off')}</td>
    <td class="num">${Number(l.payment_count || 0)}</td>
    <td class="num">${money(l.total_earned)}</td>
    <td>${escapeHtml(l.theme || '-')}</td>
  </tr>`).join('');
  el.innerHTML = `<div class="card flush"><table class="table rtable"><thead><tr><th>Slug</th><th>Name</th><th>Owner</th><th>Status</th><th class="num">Pays</th><th class="num">Earned</th><th>Theme</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7" class="empty">No payment links</td></tr>'}</tbody></table></div>`;
}

async function renderDomains() {
  const host = document.getElementById('alerts');
  if (!host || document.getElementById('domainBox')) return;
  const { data, error } = await sb.from('site_domains').select('hostname, purpose, is_active, is_primary_site, theme').order('sort_order');
  const box = document.createElement('div');
  box.id = 'domainBox';
  box.className = 'card flush';
  if (error) { box.innerHTML = `<p class="err">${escapeHtml(error.message)}</p>`; host.after(box); return; }
  const rows = (data || []).map((d) => `<tr><td class="mono">${escapeHtml(d.hostname)}</td><td>${escapeHtml(d.purpose || '')}</td><td>${d.is_primary_site ? 'Primary' : (d.is_active ? 'On' : 'Off')}</td><td>${escapeHtml(d.theme || '-')}</td></tr>`).join('');
  box.innerHTML = `<h3 style="padding:16px 20px 0">Domains</h3><table class="table"><thead><tr><th>Host</th><th>Purpose</th><th>Status</th><th>Theme</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="empty">No domains</td></tr>'}</tbody></table>`;
  host.after(box);
}

function attachAppsToAccounts() {
  const peopleEl = document.getElementById('people');
  const appsEl = document.getElementById('apps');
  if (!peopleEl || !appsEl || !appsEl.innerHTML) return;
  if (document.getElementById('appsBox')) return;
  const box = document.createElement('div');
  box.id = 'appsBox';
  box.innerHTML = appsEl.innerHTML;
  peopleEl.prepend(box);
}

let selectedCreatorId = '';
let displayedCreatorId = '';
let inboxAccounts = [];
let inboxAccountsReady = false;
let inboxSearch = '';
let creatorReadVersion = 0;
let threadReadVersion = 0;
let inboxMutationBusy = false;
const inboxDrafts = new Map();

function inboxControls() {
  const available = !!selectedCreatorId && inboxAccountsReady && !inboxMutationBusy;
  document.getElementById('adminMsgSend').disabled = !available;
  document.getElementById('clearThreadBtn').disabled = !available;
  document.getElementById('adminMsgInput').disabled = !selectedCreatorId || !inboxAccountsReady;
}
function paintCreatorList() {
  const select = document.getElementById('creatorSelect');
  if (!select) return;
  const query = inboxSearch.trim().toLocaleLowerCase();
  const shown = inboxAccounts.filter((account) => account.id === selectedCreatorId || !query || `${account.display_name || ''} ${account.email || ''}`.toLocaleLowerCase().includes(query));
  select.innerHTML = '<option value="">— Choose a freelancer —</option>' + shown.map((account) => {
    const unread = Number(account.unread_count || 0);
    const label = `${unread ? '🔴 ' : ''}${account.display_name || account.email}${unread ? ` (${unread} new)` : ''}`;
    return `<option value="${escapeHtml(account.id)}">${escapeHtml(label)}</option>`;
  }).join('');
  select.value = selectedCreatorId;
  document.getElementById('creatorResultCount').textContent = `${shown.length} / ${inboxAccounts.length}`;
}
async function renderChat() {
  const el = document.getElementById('chat');
  if (!el || inboxMutationBusy) return;
  const oldInput = document.getElementById('adminMsgInput');
  if (oldInput && displayedCreatorId) inboxDrafts.set(displayedCreatorId, oldInput.value);
  el.innerHTML = `<div class="section-intro"><div><h2>Support inbox</h2><p>Choose an account to review messages and reply.</p></div><button type="button" class="btn ghost sm" id="refreshInbox">Refresh inbox</button></div>
    <div class="inbox-layout"><div class="card inbox-accounts"><h3>Conversations</h3>
      <div class="field"><label for="creatorSearch">Search accounts</label><input id="creatorSearch" type="search" placeholder="Name or email" value="${escapeHtml(inboxSearch)}"></div>
      <div class="field"><label for="creatorSelect">Account</label><select id="creatorSelect"><option value="">— Choose a freelancer —</option></select></div>
      <p class="faint"><span>Accounts shown</span> <strong id="creatorResultCount"></strong></p><p class="faint">Accounts with unread messages appear first.</p><p id="creatorListStatus" role="status"></p></div>
    <div class="card chat-card"><div class="card-title"><h3>Conversation</h3><button class="btn danger sm" id="clearThreadBtn" type="button" disabled>Clear history</button></div>
      <p class="faint">Latest 300 messages, oldest to newest.</p><div class="thread conversation-log" id="threadList" role="log" aria-label="Conversation messages" aria-live="off"><p class="muted">Select a freelancer above</p></div>
      <div class="field chat-composer"><label for="adminMsgInput">Reply to this account</label><textarea id="adminMsgInput" rows="3" aria-describedby="adminChatHelp" disabled></textarea></div>
      <div class="chat-compose-actions"><p class="faint" id="adminChatHelp">Ctrl+Enter or Command+Enter sends. Enter starts a new line.</p><button class="btn primary" id="adminMsgSend" type="button" disabled>Send</button></div>
      <p class="chat-feedback" id="adminChatStatus" role="status" aria-live="polite"></p></div></div>`;
  const input = document.getElementById('adminMsgInput');
  input.value = inboxDrafts.get(selectedCreatorId) || '';
  displayedCreatorId = selectedCreatorId;
  input.oninput = () => { if (displayedCreatorId) inboxDrafts.set(displayedCreatorId, input.value); };
  document.getElementById('creatorSearch').oninput = (event) => { inboxSearch = event.target.value; paintCreatorList(); };
  document.getElementById('creatorSelect').onchange = () => {
    if (displayedCreatorId) inboxDrafts.set(displayedCreatorId, input.value);
    selectedCreatorId = document.getElementById('creatorSelect').value;
    displayedCreatorId = selectedCreatorId;
    input.value = inboxDrafts.get(selectedCreatorId) || '';
    document.getElementById('adminChatStatus').textContent = '';
    inboxControls();
    loadThread();
  };
  document.getElementById('adminMsgSend').onclick = sendAdminMessage;
  input.onkeydown = (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); sendAdminMessage(); } };
  document.getElementById('clearThreadBtn').onclick = clearThread;
  document.getElementById('refreshInbox').onclick = refreshAdminInbox;
  await refreshAdminInbox();
}
async function refreshAdminInbox() {
  await loadCreatorList();
  await loadThread();
}
async function loadCreatorList() {
  const select = document.getElementById('creatorSelect');
  if (!select) return;
  const version = ++creatorReadVersion;
  const status = document.getElementById('creatorListStatus');
  status.textContent = 'Loading conversations…';
  try {
    const { data, error } = await sb.rpc('admin_list_creators');
    if (version !== creatorReadVersion || document.getElementById('creatorSelect') !== select) return;
    if (error) throw error;
    inboxAccounts = (data || []).slice().sort((a,b) => (b.unread_count || 0) - (a.unread_count || 0));
    inboxAccountsReady = true;
    if (selectedCreatorId && !inboxAccounts.some((account) => account.id === selectedCreatorId)) {
      selectedCreatorId = ''; displayedCreatorId = ''; document.getElementById('adminMsgInput').value = '';
    }
    paintCreatorList();
    status.textContent = inboxAccounts.length ? '' : 'No conversations available.';
    const inboxBtn = document.querySelector('.navi[data-tab="chat"]');
    if (inboxBtn) { const total = inboxAccounts.reduce((sum, account) => sum + Number(account.unread_count || 0), 0); (inboxBtn.querySelector('.navi-label') || inboxBtn).textContent = total ? `Inbox (${total})` : 'Inbox'; }
  } catch (error) {
    if (version !== creatorReadVersion) return;
    inboxAccountsReady = false;
    status.textContent = 'Conversations could not be loaded. Refresh inbox to try again.';
  }
  inboxControls();
}
async function loadThread() {
  const userId = selectedCreatorId;
  const list = document.getElementById('threadList');
  if (!list) return;
  const version = ++threadReadVersion;
  if (!userId) { list.innerHTML = '<p class="muted">Select a freelancer above</p>'; return; }
  list.innerHTML = deskSkeleton(2);
  try {
    const { data: newestFirst, error } = await sb.from('support_messages').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(300);
    if (version !== threadReadVersion || userId !== selectedCreatorId || document.getElementById('threadList') !== list) return;
    if (error) throw error;
    const rows = (newestFirst || []).slice().reverse();
    list.innerHTML = rows.map((message) => {
      const who = message.sender === 'admin' ? 'You (admin)' : 'Freelancer';
      const edited = message.edited_at ? ' · edited' : '';
      const deleted = message.deleted_by_creator ? ' · deleted by user' : '';
      return `<div class="msg-bubble ${message.sender === 'admin' ? 'admin' : 'creator'}"><div class="chat-message-meta"><span>${escapeHtml(who)}</span><time>${escapeHtml(when(message.created_at))}${edited}${deleted}</time></div><div class="message-body">${escapeHtml(message.message)}</div></div>`;
    }).join('') || '<p class="muted">No messages yet</p>';
    list.scrollTop = list.scrollHeight;
    const unread = rows.filter((message) => message.sender !== 'admin' && message.read_by_admin === false);
    if (unread.length) { await sb.from('support_messages').update({read_by_admin:true}).in('id',unread.map((message)=>message.id)); loadCreatorList(); }
  } catch (error) { if (version === threadReadVersion && userId === selectedCreatorId) list.innerHTML = deskError(error.message || 'Messages could not be loaded. Refresh inbox to try again.'); }
}
async function sendAdminMessage() {
  if (inboxMutationBusy || !inboxAccountsReady) return;
  const userId = selectedCreatorId;
  const input = document.getElementById('adminMsgInput');
  const text = input.value.trim();
  if (!userId || !text) return toast('Select an account and write a message first.');
  const status = document.getElementById('adminChatStatus');
  inboxDrafts.set(userId,input.value);
  inboxMutationBusy = true; inboxControls();
  status.textContent = 'Sending message…';
  try {
    const { error } = await sb.from('support_messages').insert({user_id:userId,sender:'admin',message:text});
    if (error) throw error;
    if (selectedCreatorId === userId) {
      if (input.value.trim() === text) input.value = '';
      inboxDrafts.set(userId,input.value);
      status.textContent = 'Message sent.';
      await loadThread();
    } else if ((inboxDrafts.get(userId) || '').trim() === text) inboxDrafts.set(userId,'');
  } catch (error) { if (selectedCreatorId === userId) status.textContent = 'Send could not be confirmed. Your draft is kept.'; else toast('Send could not be confirmed. Your draft is kept.'); }
  finally { inboxMutationBusy = false; inboxControls(); }
}
async function clearThread() {
  if (inboxMutationBusy || !inboxAccountsReady) return;
  const userId = selectedCreatorId;
  if (!userId) return toast('Select a freelancer first');
  if (!confirm('Clear this entire conversation?')) return;
  inboxMutationBusy = true; inboxControls();
  try {
    const { error } = await sb.rpc('clear_message_thread',{p_user_id:userId});
    if (error) return toast(error.message);
    toast('Conversation cleared',true);
    if (selectedCreatorId === userId) await loadThread();
  } catch (error) { toast('Conversation clear could not be confirmed. Refresh inbox before trying again.'); }
  finally { inboxMutationBusy = false; inboxControls(); }
}

const _show = typeof show === 'function' ? show : null;
window.show = function (tab) {
  if (_show) _show(tab);
  if (tab === 'chat') refreshAdminInbox();
};

setTimeout(() => {
  renderPayouts();
  renderPayments();
  renderLinks();
  renderDomains();
  attachAppsToAccounts();
  renderChat();
}, 800);
