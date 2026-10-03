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
  if (!res.ok) throw new Error(payload.error || 'Request failed');
  return payload;
}

async function renderPayouts() {
  const el = document.getElementById('payouts');
  if (!el) return;
  const { data, error } = await sb.from('withdrawals').select('*').order('requested_at', { ascending: false }).limit(80);
  if (error) { el.innerHTML = `<p class="err">${escapeHtml(error.message)}</p>`; return; }
  const rows = (data || []).map((w) => {
    const open = ['pending', 'approved', 'processing'].includes(String(w.status));
    const acts = open ? `<button class="btn primary sm" data-wd="${w.id}" data-act="mark_paid_manual">Mark paid</button> <button class="btn danger sm" data-wd="${w.id}" data-act="reject">Reject</button>` : '';
    return `<tr><td class="num">${money(w.amount_requested)}</td><td class="num">${w.fee_percent != null ? Number(w.fee_percent) + '%' : '-'}</td><td class="num">${w.amount_after_fee != null ? money(w.amount_after_fee) : '-'}</td><td>${escapeHtml(methodLabel(w.method, w))}</td><td>${badge(w.status)}</td><td class="mono">${escapeHtml(w.destination || '')}</td><td>${escapeHtml(when(w.requested_at))}</td><td>${acts}</td></tr>`;
  }).join('');
  el.innerHTML = `<div class="card flush"><table class="table"><thead><tr><th class="num">Amount</th><th class="num">Fee</th><th class="num">Receives</th><th>Network</th><th>Status</th><th>Address</th><th>Requested</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="8" class="empty">No withdrawals</td></tr>'}</tbody></table></div>`;
  el.querySelectorAll('[data-wd]').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await adminFn('process-withdrawal', { withdrawalId: btn.dataset.wd, action: btn.dataset.act });
        toast(btn.dataset.act === 'reject' ? 'Rejected' : 'Marked paid', true);
        renderPayouts(); renderHome();
      } catch (e) { toast(e.message); btn.disabled = false; }
    };
  });
}

async function renderPayments() {
  const el = document.getElementById('payments');
  if (!el) return;
  const { data, error } = await sb.rpc('admin_list_payments', { p_limit: 80, p_offset: 0, p_search: null });
  if (error) {
    const message = document.createElement('p');
    message.className = 'err';
    message.textContent = error.message;
    el.replaceChildren(message);
    return;
  }
  const card = document.createElement('div');
  card.className = 'card flush';
  const table = document.createElement('table');
  table.className = 'table';
  const head = document.createElement('thead');
  const header = document.createElement('tr');
  for (const label of ['When', 'Status', 'Amount', 'Account', 'Link', 'Invoice', '']) {
    const th = document.createElement('th');
    th.textContent = label;
    if (label === 'Amount') th.className = 'num';
    header.append(th);
  }
  head.append(header);
  table.append(head);
  const body = document.createElement('tbody');
  const addCell = (row, value, className = '') => {
    const td = document.createElement('td');
    td.textContent = value;
    if (className) td.className = className;
    row.append(td);
    return td;
  };
  if (!data?.length) {
    const row = document.createElement('tr');
    const cell = addCell(row, 'No payments yet', 'empty');
    cell.colSpan = 7;
    body.append(row);
  } else {
    for (const p of data) {
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
  card.append(table);
  el.replaceChildren(card);
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
  if (error) { el.innerHTML = `<p class="err">${escapeHtml(error.message)}</p>`; return; }
  const rows = (data || []).map((l) => `<tr>
    <td class="mono">${escapeHtml(l.slug)}</td>
    <td>${escapeHtml(l.display_name || '')}</td>
    <td>${escapeHtml(l.owner_name || l.owner_email || '')}</td>
    <td>${l.is_active ? badge('active') : badge('off')}</td>
    <td class="num">${Number(l.payment_count || 0)}</td>
    <td class="num">${money(l.total_earned)}</td>
    <td>${escapeHtml(l.theme || '-')}</td>
  </tr>`).join('');
  el.innerHTML = `<div class="card flush"><table class="table"><thead><tr><th>Slug</th><th>Name</th><th>Owner</th><th>Status</th><th class="num">Pays</th><th class="num">Earned</th><th>Theme</th></tr></thead>
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

async function renderChat() {
  const el = document.getElementById('chat');
  if (!el) return;
  el.innerHTML = `<div class="card">
      <h3>Select freelancer</h3>
      <div class="field"><label for="creatorSelect">Account</label>
        <select id="creatorSelect"><option value="">— Choose a freelancer —</option></select></div>
      <p class="faint">Red dot = unread from that freelancer. Same list as the old Messages tab.</p>
    </div>
    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:center">
        <h3>Conversation</h3>
        <button class="btn danger sm" id="clearThreadBtn" type="button">Clear history</button>
      </div>
      <div class="thread" id="threadList"><p class="muted">Select a freelancer above</p></div>
      <div class="compose">
        <input class="input" id="adminMsgInput" placeholder="Type a message to this freelancer…">
        <button class="btn primary" id="adminMsgSend" type="button">Send</button>
      </div>
    </div>`;
  document.getElementById('creatorSelect').onchange = loadThread;
  document.getElementById('adminMsgSend').onclick = sendAdminMessage;
  document.getElementById('adminMsgInput').onkeydown = (e) => { if (e.key === 'Enter') sendAdminMessage(); };
  document.getElementById('clearThreadBtn').onclick = clearThread;
  await loadCreatorList();
}

async function loadCreatorList() {
  const sel = document.getElementById('creatorSelect');
  if (!sel) return;
  const { data, error } = await sb.rpc('admin_list_creators');
  if (error) { sel.innerHTML = `<option value="">${escapeHtml(error.message)}</option>`; return; }
  const list = (data || []).slice().sort((a, b) => (b.unread_count || 0) - (a.unread_count || 0));
  const prev = sel.value || selectedCreatorId;
  sel.innerHTML = '<option value="">— Choose a freelancer —</option>' + list.map((c) => {
    const unread = Number(c.unread_count || 0);
    const label = `${unread ? '🔴 ' : ''}${c.display_name || c.email}${unread ? ` (${unread} new)` : ''}`;
    return `<option value="${escapeHtml(c.id)}">${escapeHtml(label)}</option>`;
  }).join('');
  if (prev) sel.value = prev;
  const inboxBtn = document.querySelector('.navi[data-tab="chat"]');
  if (inboxBtn) {
    const total = list.reduce((s, c) => s + Number(c.unread_count || 0), 0);
    inboxBtn.textContent = total ? `Inbox (${total})` : 'Inbox';
  }
}

async function loadThread() {
  selectedCreatorId = document.getElementById('creatorSelect')?.value || '';
  const list = document.getElementById('threadList');
  if (!list) return;
  if (!selectedCreatorId) { list.innerHTML = '<p class="muted">Select a freelancer above</p>'; return; }
  const { data: newestFirst, error } = await sb.from('support_messages').select('*').eq('user_id', selectedCreatorId).order('created_at', { ascending: false }).limit(300);
  if (error) { list.innerHTML = `<p class="err">${escapeHtml(error.message)}</p>`; return; }
  const rows = (newestFirst || []).slice().reverse();
  if (!rows.length) { list.innerHTML = '<p class="muted">No messages yet</p>'; return; }
  list.innerHTML = rows.map((m) => {
    const who = m.sender === 'admin' ? 'You (admin)' : 'Freelancer';
    const deleted = m.deleted_by_creator ? ' · deleted by user' : '';
    const edited = m.edited_at ? ' · edited' : '';
    const side = m.sender === 'admin' ? 'admin' : 'creator';
    return `<div class="msg-bubble ${side}"><div class="faint">${escapeHtml(who)}</div>${escapeHtml(m.message)}<div class="faint">${escapeHtml(when(m.created_at))}${edited}${deleted}</div></div>`;
  }).join('');
  list.scrollTop = list.scrollHeight;
  const unread = rows.filter((m) => m.sender !== 'admin' && m.read_by_admin === false);
  if (unread.length) {
    await sb.from('support_messages').update({ read_by_admin: true }).in('id', unread.map((m) => m.id));
    loadCreatorList();
  }
}

async function sendAdminMessage() {
  const text = document.getElementById('adminMsgInput')?.value.trim();
  if (!text || !selectedCreatorId) return toast('Select a freelancer first');
  const { error } = await sb.from('support_messages').insert({ user_id: selectedCreatorId, sender: 'admin', message: text });
  if (error) return toast(error.message);
  document.getElementById('adminMsgInput').value = '';
  await loadThread();
}

async function clearThread() {
  if (!selectedCreatorId) return toast('Select a freelancer first');
  if (!confirm('Clear this entire conversation?')) return;
  const { error } = await sb.rpc('clear_message_thread', { p_user_id: selectedCreatorId });
  if (error) return toast(error.message);
  toast('Conversation cleared', true);
  await loadThread();
}

const _show = typeof show === 'function' ? show : null;
window.show = function (tab) {
  if (_show) _show(tab);
  if (tab === 'chat') { loadCreatorList(); if (selectedCreatorId) loadThread(); }
};

setTimeout(() => {
  renderPayouts();
  renderPayments();
  renderLinks();
  renderDomains();
  attachAppsToAccounts();
  renderChat();
}, 800);
