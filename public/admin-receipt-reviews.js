// Receipt review queue (20261007130000): Lightning receipts that did not
// settle a payment cleanly — underpaid, overpaid, unmatched, paid twice or
// without a payment hash. Flag only: closing an item changes nothing in the
// ledger. A money correction, if one is needed, is a separate admin action.
// Server: admin_list_receipt_reviews / admin_resolve_receipt_review (is_admin()).
const RECEIPT_KIND_TEXT = {
  underpaid: 'Underpaid — less than the invoice; not credited',
  overpaid: 'Overpaid — credited the invoice amount only',
  unmatched: 'No matching payment for this payment hash',
  unsettled: 'Matches a payment that is still not settled',
  already_settled: 'Second receipt for an already settled payment',
  not_settleable: 'Payment was not in a settleable state',
  no_hash: 'Receipt without a payment hash (not from a CPAY invoice)',
};

let receiptReadVersion = 0;
let receiptSearch = '';
const receiptBusy = new Set();
async function renderReceiptReviews() {
  const el = document.getElementById('receipts');
  if (!el || typeof sb === 'undefined') return;
  const filter = el.dataset.filter || 'open';
  const version = ++receiptReadVersion;
  el.setAttribute('aria-busy','true');
  const { data, error } = await adminPanelRead(() => sb.rpc('admin_list_receipt_reviews', { p_status: filter, p_limit: 200 }));
  if (version !== receiptReadVersion) return;
  el.setAttribute('aria-busy','false');
  if (error) { adminPanelError(el, error.message, renderReceiptReviews); return; }
  const query = receiptSearch.trim().toLowerCase();
  const loaded = data || [];
  const visible = loaded.filter(r => `${r.kind || ''} ${r.merchant_name || ''} ${r.payment_id || ''} ${r.provider_payment_id || ''} ${r.payment_hash || ''} ${r.resolution_note || ''}`.toLowerCase().includes(query));
  const rows = visible.map((r) => `<tr>
      <td>${escapeHtml(RECEIPT_KIND_TEXT[r.kind] || r.kind)}</td>
      <td class="num">${r.received_sat != null ? escapeHtml(String(r.received_sat)) : '-'}</td>
      <td class="num">${r.expected_sat != null ? escapeHtml(String(r.expected_sat)) : '-'}</td>
      <td>${r.payment_id ? `${escapeHtml(r.merchant_name || '')} ${r.amount_requested != null ? money(r.amount_requested) : ''} ${badge(r.payment_status || '')}` : '<span class="faint">none</span>'}</td>
      <td class="mono">${escapeHtml(String(r.provider_payment_id || '—').slice(0, 24))}<details><summary>Receipt evidence</summary><dl class="review-details"><dt>Receipt reference</dt><dd>${escapeHtml(r.provider_payment_id || '—')}</dd><dt>Payment hash</dt><dd>${escapeHtml(r.payment_hash || '—')}</dd><dt>Payment reference</dt><dd>${escapeHtml(r.payment_id || '—')}</dd><dt>Detected by</dt><dd>${escapeHtml(r.detected_by || '—')}</dd><dt>Settle outcome</dt><dd>${escapeHtml(r.settle_outcome || '—')}</dd><dt>Last seen</dt><dd>${r.last_seen_at ? escapeHtml(when(r.last_seen_at)) : '—'}</dd><dt>Resolved at</dt><dd>${r.resolved_at ? escapeHtml(when(r.resolved_at)) : '—'}</dd></dl></details></td>
      <td>${escapeHtml(when(r.first_seen_at))}${r.seen_count > 1 ? ` <span class="faint">×${escapeHtml(String(r.seen_count))}</span>` : ''}</td>
      <td>${r.status === 'open'
        ? `<button class="btn" type="button" data-rr="${escapeHtml(String(r.id))}" ${receiptBusy.has(String(r.id)) ? 'disabled' : ''} data-rr-status="resolved">Resolve</button>
           <button class="btn" type="button" data-rr="${escapeHtml(String(r.id))}" ${receiptBusy.has(String(r.id)) ? 'disabled' : ''} data-rr-status="dismissed">Dismiss</button>`
        : `${badge(r.status)} <span class="faint">${escapeHtml(r.resolution_note || '')}</span>`}</td>
    </tr>`).join('');
  const opt = (v, label) => `<option value="${v}" ${filter === v ? 'selected' : ''}>${label}</option>`;
  el.innerHTML = `<div class="card">
      <div class="card-head"><h3>Receipt review</h3><button id="rrRefresh" class="btn ghost" type="button">Refresh receipt queue</button></div>
      <p class="muted">Receipts the wallet got that did not settle a payment cleanly. Nothing here moves money: resolving only records your decision (audited).</p>
      <p class="faint">Showing up to 200 receipts for the selected status. Search checks these loaded records.</p><p class="faint">${visible.length} / ${loaded.length}</p><div class="desk-toolbar"><div class="field"><label for="rrFilter">Show</label><select id="rrFilter">${opt('open', 'Open')}${opt('resolved', 'Resolved')}${opt('dismissed', 'Dismissed')}${opt('all', 'All')}</select></div><div class="field grow"><label for="rrSearch">Search receipts</label><input id="rrSearch" type="search" value="${escapeHtml(receiptSearch)}" placeholder="Issue, merchant, reference or note"></div><button id="rrApply" class="btn primary" type="button">Apply</button><button id="rrClear" class="btn ghost" type="button">Clear</button></div>
    </div>
    <div class="card flush"><div class="scroll"><table class="table"><thead><tr><th>Issue</th><th class="num">Received sats</th><th class="num">Invoice sats</th><th>Payment</th><th>Receipt</th><th>First seen</th><th></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="7" class="empty">${query ? 'No receipts match this search' : filter === 'open' ? 'No open receipt reviews' : 'Nothing here'}</td></tr>`}</tbody></table></div></div>`;
  document.getElementById('rrRefresh').onclick = renderReceiptReviews;
  document.getElementById('rrSearch').oninput = e => { receiptSearch = e.target.value; };
  document.getElementById('rrSearch').onkeydown = e => { if (e.key === 'Enter') renderReceiptReviews(); };
  document.getElementById('rrApply').onclick = renderReceiptReviews;
  document.getElementById('rrClear').onclick = () => { receiptSearch = ''; el.dataset.filter = 'open'; renderReceiptReviews(); };
  document.getElementById('rrFilter').onchange = (e) => { el.dataset.filter = e.target.value; renderReceiptReviews(); };
  el.querySelectorAll('[data-rr]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.rr;
      if (receiptBusy.has(id)) return;
      const note = window.prompt('Note for the audit log (what you checked or did):', '');
      if (note === null) return;
      receiptBusy.add(id);
      const controls = () => el.querySelectorAll('[data-rr]');
      controls().forEach(b => { if (b.dataset.rr === id) b.disabled = true; });
      try {
      const { error: e } = await sb.rpc('admin_resolve_receipt_review', {
        p_id: Number(btn.dataset.rr), p_status: btn.dataset.rrStatus, p_note: note,
      });
      if (e) throw e;
      toast('Saved', true); renderReceiptReviews();
      } catch (error) { toast(error.message || 'Decision could not be confirmed. Refresh before trying again.'); }
      finally { receiptBusy.delete(id); controls().forEach(b => { if (b.dataset.rr === id) b.disabled = false; }); }
    };
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(renderReceiptReviews, 800));
else setTimeout(renderReceiptReviews, 800);
