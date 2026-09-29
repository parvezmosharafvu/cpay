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
  if (error) { el.innerHTML = `<p class="err">${escapeHtml(error.message)}</p>`; return; }
  const rows = (data || []).map((p) => {
    const settle = p.status !== 'settled' && p.status !== 'expired'
      ? `<button class="btn ghost sm" data-pay="${p.id}">Mark settled</button>` : '';
    return `<tr>
      <td>${escapeHtml(when(p.settled_at || p.created_at))}</td>
      <td>${badge(p.status)}</td>
      <td class="num">${money(p.amount_settled ?? p.amount_requested)}</td>
      <td>${escapeHtml(p.creator_name || p.creator_email || '')}</td>
      <td class="mono">${escapeHtml(p.link_slug || '')}</td>
      <td class="mono">${escapeHtml(p.invoice_ref || String(p.id).slice(0, 8))}</td>
      <td>${settle}</td>
    </tr>`;
  }).join('');
  el.innerHTML = `<div class="card flush"><table class="table"><thead><tr><th>When</th><th>Status</th><th class="num">Amount</th><th>Account</th><th>Link</th><th>Invoice</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7" class="empty">No payments yet</td></tr>'}</tbody></table></div>`;
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

setTimeout(() => {
  renderPayouts();
  renderPayments();
  renderLinks();
  renderDomains();
  attachAppsToAccounts();
}, 800);
