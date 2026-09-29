// Loaded after admin-desk.js. Replaces the ops-panel handoff.
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
  const { data, error } = await sb.from('withdrawals').select('*').order('requested_at', { ascending: false }).limit(40);
  if (error) { el.innerHTML = `<p class="err">${escapeHtml(error.message)}</p>`; return; }
  const rows = (data || []).map((w) => {
    const open = ['pending', 'approved', 'processing'].includes(String(w.status));
    const acts = open ? `<button class="btn primary sm" data-wd="${w.id}" data-act="mark_paid_manual">Mark paid</button> <button class="btn danger sm" data-wd="${w.id}" data-act="reject">Reject</button>` : '';
    return `<tr><td class="num">${money(w.amount_requested)}</td><td class="num">${w.fee_percent != null ? Number(w.fee_percent) + '%' : '-'}</td><td class="num">${w.amount_after_fee != null ? money(w.amount_after_fee) : '-'}</td><td>${escapeHtml(methodLabel(w.method, w))}</td><td>${badge(w.status)}</td><td class="mono">${escapeHtml(w.destination || '')}</td><td>${escapeHtml(when(w.requested_at))}</td><td>${acts}</td></tr>`;
  }).join('');
  el.innerHTML = `<div class="card flush"><table class="table"><thead><tr><th class="num">Amount</th><th class="num">Fee</th><th class="num">Receives</th><th>Network</th><th>Status</th><th>Address</th><th>Requested</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="8" class="empty">No withdrawals</td></tr>'}</tbody></table></div>
    <p class="faint">USDT only. Mark paid after the transfer is sent. Reject returns the balance.</p>`;
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
  const { data, error } = await sb.from('payments').select('id, status, amount_settled, amount_requested, created_at, settled_at, invoice_id, user_id').order('created_at', { ascending: false }).limit(50);
  if (error) { el.innerHTML = `<p class="err">${escapeHtml(error.message)}</p>`; return; }
  const nameOf = (id) => {
    const p = (typeof people !== 'undefined' ? people : []).find((x) => x.id === id);
    return p ? (p.display_name || p.email) : '';
  };
  const rows = (data || []).map((p) => `<tr>
    <td>${escapeHtml(when(p.settled_at || p.created_at))}</td>
    <td>${badge(p.status)}</td>
    <td class="num">${money(p.amount_settled ?? p.amount_requested)}</td>
    <td>${escapeHtml(nameOf(p.user_id))}</td>
    <td class="mono">${escapeHtml(String(p.invoice_id || p.id || '').slice(0, 12))}</td>
  </tr>`).join('');
  el.innerHTML = `<div class="card flush"><table class="table"><thead><tr><th>When</th><th>Status</th><th class="num">Amount</th><th>Account</th><th>Invoice</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5" class="empty">No payments yet</td></tr>'}</tbody></table></div>`;
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

setTimeout(() => {
  renderPayouts();
  renderPayments();
  attachAppsToAccounts();
}, 1200);
