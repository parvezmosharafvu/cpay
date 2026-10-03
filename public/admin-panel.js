// Paginated, filterable admin views. Loaded last; every read is an RPC that
// re-checks is_admin() on the server, so hiding a tab here is cosmetic only.
const PANEL_SIZE = 25;

function panelPage(id, { title, filters = '', head, load, row, empty, afterRender }) {
  const state = { offset: 0, q: '', f: '' };
  async function draw() {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = `<div class="card flush"><h3 style="padding:16px 20px 0">${escapeHtml(title)}</h3>
      <div class="row" style="display:flex;gap:8px;flex-wrap:wrap;padding:12px 20px">
        <input type="search" data-q placeholder="Search" aria-label="Search ${escapeHtml(title)}" value="${escapeHtml(state.q)}">
        ${filters}
        <button class="btn ghost sm" data-go>Apply</button>
      </div>
      <div data-body class="faint" style="padding:0 20px 16px" role="status">Loading…</div></div>`;
    const fsel = el.querySelector('[data-f]');
    if (fsel) fsel.value = state.f;
    const apply = () => {
      state.q = el.querySelector('[data-q]').value;
      state.f = fsel ? fsel.value : '';
      state.offset = 0;
      draw();
    };
    el.querySelector('[data-go]').onclick = apply;
    el.querySelector('[data-q]').onkeydown = (e) => { if (e.key === 'Enter') apply(); };
    const body = el.querySelector('[data-body]');
    const { data, error } = await load({ limit: PANEL_SIZE, offset: state.offset, q: state.q.trim() || null, f: state.f || null });
    if (error) { body.className = 'err'; body.setAttribute('role', 'alert'); body.textContent = error.message; return; }
    const rows = data || [];
    const total = rows.length ? Number(rows[0].total_count ?? rows.length) : 0;
    const from = rows.length ? state.offset + 1 : 0;
    body.className = ''; body.removeAttribute('role'); body.style.padding = '0';
    body.innerHTML = `<table class="table"><thead><tr>${head}</tr></thead><tbody>${rows.map(row).join('') || `<tr><td colspan="9" class="empty">${escapeHtml(empty)}</td></tr>`}</tbody></table>
      <div class="row" style="display:flex;gap:8px;align-items:center;padding:12px 20px">
        <button class="btn ghost sm" data-prev ${state.offset === 0 ? 'disabled' : ''}>Previous</button>
        <span class="faint">${from}–${state.offset + rows.length} of ${total}</span>
        <button class="btn ghost sm" data-next ${state.offset + rows.length >= total ? 'disabled' : ''}>Next</button>
      </div>`;
    body.querySelector('[data-prev]').onclick = () => { state.offset = Math.max(0, state.offset - PANEL_SIZE); draw(); };
    body.querySelector('[data-next]').onclick = () => { state.offset += PANEL_SIZE; draw(); };
    if (afterRender) afterRender(body, draw);
  }
  return draw;
}

const STATUS_OPTS = (list) => `<select data-f aria-label="Status"><option value="">All</option>${list.map((s) => `<option>${s}</option>`).join('')}</select>`;

window.renderPayouts = panelPage('payouts', {
  title: 'Withdrawals',
  filters: STATUS_OPTS(['pending', 'approved', 'processing', 'paid', 'rejected', 'failed']),
  head: '<th class="num">Amount</th><th class="num">Fee</th><th class="num">Receives</th><th>Account</th><th>Network</th><th>Status</th><th>Address</th><th>Requested</th><th></th>',
  load: ({ limit, offset, q, f }) => sb.rpc('admin_list_withdrawals_page', { p_limit: limit, p_offset: offset, p_status: f, p_search: q }),
  empty: 'No withdrawals match',
  row: (w) => {
    const open = ['pending', 'approved', 'processing'].includes(String(w.status));
    const acts = open ? `<button class="btn primary sm" data-wd="${escapeHtml(w.id)}" data-act="mark_paid_manual">Mark paid</button> <button class="btn danger sm" data-wd="${escapeHtml(w.id)}" data-act="reject">Reject</button>` : '';
    return `<tr><td class="num">${money(w.amount_requested)}</td><td class="num">${w.fee_percent != null ? Number(w.fee_percent) + '%' : '-'}</td><td class="num">${w.amount_after_fee != null ? money(w.amount_after_fee) : '-'}</td><td>${escapeHtml(w.account_email || '')}</td><td>${escapeHtml(methodLabel(w.method, w))}</td><td>${badge(w.status)}</td><td class="mono">${escapeHtml(w.destination || '')}</td><td>${escapeHtml(when(w.requested_at))}</td><td>${acts}</td></tr>`;
  },
  afterRender: (body, draw) => body.querySelectorAll('[data-wd]').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await adminFn('process-withdrawal', { withdrawalId: btn.dataset.wd, action: btn.dataset.act });
        toast(btn.dataset.act === 'reject' ? 'Rejected' : 'Marked paid', true);
        draw();
      } catch (e) { toast(e.message); btn.disabled = false; }
    };
  }),
});

window.renderPayments = panelPage('payments', {
  title: 'Transactions',
  filters: '',
  head: '<th>When</th><th>Status</th><th class="num">Amount</th><th>Account</th><th>Link</th><th>Invoice</th><th></th>',
  load: ({ limit, offset, q }) => sb.rpc('admin_list_payments', { p_limit: limit, p_offset: offset, p_search: q }),
  empty: 'No payments match',
  row: (p) => `<tr><td>${escapeHtml(when(p.settled_at || p.created_at))}</td><td>${badge(p.status)}</td><td class="num">${money(p.amount_settled ?? p.amount_requested)}</td><td>${escapeHtml(p.creator_name || p.creator_email || '')}</td><td class="mono">${escapeHtml(p.link_slug || '')}</td><td class="mono">${escapeHtml(p.invoice_ref || String(p.id).slice(0, 8))}</td>
    <td><button class="btn ghost sm" data-detail="${escapeHtml(p.id)}">Details</button>${p.status !== 'settled' && p.status !== 'expired' ? ` <button class="btn ghost sm" data-pay="${escapeHtml(p.id)}">Mark settled</button>` : ''}</td></tr>`,
  afterRender: (body, draw) => {
    body.querySelectorAll('[data-pay]').forEach((btn) => {
      btn.onclick = async () => {
        btn.disabled = true;
        try { await adminFn('admin-mark-settled', { paymentId: btn.dataset.pay }); toast('Marked settled', true); draw(); }
        catch (e) { toast(e.message); btn.disabled = false; }
      };
    });
    body.querySelectorAll('[data-detail]').forEach((btn) => {
      btn.onclick = async () => {
        const { data, error } = await sb.rpc('admin_payment_detail', { p_payment_id: btn.dataset.detail });
        let host = document.getElementById('paymentDetail');
        if (!host) { host = document.createElement('div'); host.id = 'paymentDetail'; document.getElementById('payments').appendChild(host); }
        host.hidden = false;
        if (error) { host.innerHTML = `<p class="err" role="alert">${escapeHtml(error.message)}</p>`; return; }
        host.innerHTML = kvCard('Payment details', { ...data, receipts: undefined })
          + `<div class="card flush"><h3 style="padding:16px 20px 0">Lightning receipts</h3><table class="table"><thead><tr><th>Received</th><th>Outcome</th><th class="num">Sats</th></tr></thead><tbody>${(data.receipts || []).map((r) => `<tr><td>${escapeHtml(when(r.received_at))}</td><td>${badge(r.outcome)}</td><td class="num">${escapeHtml(r.receipt_amount_sat ?? '-')}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">No receipts</td></tr>'}</tbody></table></div>
          <button class="btn ghost sm" id="closeDetail">Close</button>`;
        document.getElementById('closeDetail').onclick = () => { host.hidden = true; };
        host.scrollIntoView({ block: 'nearest' });
      };
    });
  },
});

window.renderReconciliation = panelPage('reconciliation', {
  title: 'Lightning reconciliation',
  filters: STATUS_OPTS(['unknown', 'underpaid', 'overpaid', 'already_settled', 'not_settleable']),
  head: '<th>Received</th><th>Outcome</th><th>Breez receipt</th><th>Payment hash</th><th class="num">Received sats</th><th class="num">Invoice sats</th><th>Account</th>',
  load: ({ limit, offset, f }) => sb.rpc('admin_reconciliation_page', { p_limit: limit, p_offset: offset, p_outcome: f }),
  empty: 'No unmatched or discrepant receipts',
  row: (r) => `<tr><td>${escapeHtml(when(r.received_at))}</td><td>${badge(r.settlement_outcome)}</td><td class="mono">${escapeHtml(r.breez_payment_id || '')}</td><td class="mono">${escapeHtml(r.payment_hash || 'No payment hash')}</td><td class="num">${escapeHtml(r.receipt_amount_sat ?? '-')}</td><td class="num">${escapeHtml(r.invoice_amount_sat ?? '-')}</td><td>${escapeHtml(r.creator_email || (r.payment_id ? '—' : 'Unmatched receipt'))}</td></tr>`,
});

window.renderAudit = panelPage('audit', {
  title: 'Audit log',
  head: '<th>When</th><th>Who</th><th>Action</th><th>Type</th><th>Id</th><th>Note</th>',
  load: ({ limit, offset, q }) => sb.rpc('admin_audit_log', { p_limit: limit, p_offset: offset, p_action: q }),
  empty: 'No audit rows',
  row: (r) => `<tr><td>${escapeHtml(when(r.occurred_at))}</td><td>${escapeHtml(r.actor_email || '')}</td><td>${escapeHtml(r.action || '')}</td><td>${escapeHtml(r.subject_type || '')}</td><td class="mono">${escapeHtml(String(r.subject_id || '').slice(0, 8))}</td><td>${escapeHtml(r.note || '')}</td></tr>`,
});

window.renderSecurity = panelPage('security', {
  title: 'Security events',
  head: '<th>When</th><th>Who</th><th>Action</th><th>Type</th><th>Id</th><th>Note</th>',
  load: ({ limit, offset, q }) => sb.rpc('admin_security_events', { p_limit: limit, p_offset: offset, p_search: q }),
  empty: 'No security events',
  row: (r) => `<tr><td>${escapeHtml(when(r.occurred_at))}</td><td>${escapeHtml(r.actor_email || '')}</td><td>${escapeHtml(r.action || '')}</td><td>${escapeHtml(r.subject_type || '')}</td><td class="mono">${escapeHtml(String(r.subject_id || '').slice(0, 8))}</td><td>${escapeHtml(r.note || '')}</td></tr>`,
});

async function renderRoles() {
  const el = document.getElementById('roles');
  if (!el) return;
  el.innerHTML = '<p class="faint" role="status">Loading…</p>';
  const { data, error } = await sb.rpc('admin_role_overview');
  if (error) { el.innerHTML = `<p class="err" role="alert">${escapeHtml(error.message)}</p>`; return; }
  const cell = (v) => (v === true ? 'Yes' : v === false ? 'No' : escapeHtml(String(v)));
  el.innerHTML = `<div class="card flush"><h3 style="padding:16px 20px 0">Permissions</h3><p class="faint" style="padding:0 20px">Enforced on the server by every admin RPC; this table is informational.</p>
    <table class="table"><thead><tr><th>Area</th><th>Admin</th><th>Reseller</th><th>Freelancer</th></tr></thead><tbody>${(data.permissions || []).map((p) => `<tr><td>${escapeHtml(p.area)}</td><td>${cell(p.admin)}</td><td>${cell(p.moderator)}</td><td>${cell(p.creator)}</td></tr>`).join('')}</tbody></table></div>
    <div class="card flush"><h3 style="padding:16px 20px 0">Role counts</h3><table class="table"><tbody>${(data.roles || []).map((r) => `<tr><td>${escapeHtml(r.role)}</td><td class="num">${Number(r.accounts)}</td></tr>`).join('') || '<tr><td class="empty">No accounts</td></tr>'}</tbody></table></div>
    <div class="card flush"><h3 style="padding:16px 20px 0">Administrators</h3><table class="table"><thead><tr><th>Email</th><th>Name</th><th>Status</th></tr></thead><tbody>${(data.admins || []).map((a) => `<tr><td>${escapeHtml(a.email || '')}</td><td>${escapeHtml(a.display_name || '')}</td><td>${badge(a.account_status)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">No admins</td></tr>'}</tbody></table></div>`;
}

const __panelShow = window.show;
window.show = function (tab) {
  if (typeof __panelShow === 'function') __panelShow(tab);
  if (tab === 'payments') window.renderPayments();
  if (tab === 'payouts') window.renderPayouts();
  if (tab === 'reconciliation') window.renderReconciliation();
  if (tab === 'security') window.renderSecurity();
  if (tab === 'roles') renderRoles();
};
