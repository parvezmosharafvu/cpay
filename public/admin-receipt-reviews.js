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

async function renderReceiptReviews() {
  const el = document.getElementById('receipts');
  if (!el || typeof sb === 'undefined') return;
  const filter = el.dataset.filter || 'open';
  const { data, error } = await sb.rpc('admin_list_receipt_reviews', { p_status: filter, p_limit: 200 });
  if (error) { el.innerHTML = `<p class="err">${escapeHtml(error.message)}</p>`; return; }
  const rows = (data || []).map((r) => `<tr>
      <td>${escapeHtml(RECEIPT_KIND_TEXT[r.kind] || r.kind)}</td>
      <td class="num">${r.received_sat != null ? escapeHtml(String(r.received_sat)) : '-'}</td>
      <td class="num">${r.expected_sat != null ? escapeHtml(String(r.expected_sat)) : '-'}</td>
      <td>${r.payment_id ? `${escapeHtml(r.merchant_name || '')} ${r.amount_requested != null ? money(r.amount_requested) : ''} ${badge(r.payment_status || '')}` : '<span class="faint">none</span>'}</td>
      <td class="mono">${escapeHtml(String(r.provider_payment_id).slice(0, 24))}</td>
      <td>${escapeHtml(when(r.first_seen_at))}${r.seen_count > 1 ? ` <span class="faint">×${escapeHtml(String(r.seen_count))}</span>` : ''}</td>
      <td>${r.status === 'open'
        ? `<button class="btn" type="button" data-rr="${escapeHtml(String(r.id))}" data-rr-status="resolved">Resolve</button>
           <button class="btn" type="button" data-rr="${escapeHtml(String(r.id))}" data-rr-status="dismissed">Dismiss</button>`
        : `${badge(r.status)} <span class="faint">${escapeHtml(r.resolution_note || '')}</span>`}</td>
    </tr>`).join('');
  const opt = (v, label) => `<option value="${v}" ${filter === v ? 'selected' : ''}>${label}</option>`;
  el.innerHTML = `<div class="card">
      <h3>Receipt review</h3>
      <p class="muted">Receipts the wallet got that did not settle a payment cleanly. Nothing here moves money: resolving only records your decision (audited).</p>
      <div class="field"><label for="rrFilter">Show</label><select id="rrFilter">${opt('open', 'Open')}${opt('resolved', 'Resolved')}${opt('dismissed', 'Dismissed')}${opt('all', 'All')}</select></div>
    </div>
    <div class="card flush"><table class="table"><thead><tr><th>Issue</th><th class="num">Received sats</th><th class="num">Invoice sats</th><th>Payment</th><th>Receipt</th><th>First seen</th><th></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="7" class="empty">${filter === 'open' ? 'No open receipt reviews' : 'Nothing here'}</td></tr>`}</tbody></table></div>`;
  document.getElementById('rrFilter').onchange = (e) => { el.dataset.filter = e.target.value; renderReceiptReviews(); };
  el.querySelectorAll('[data-rr]').forEach((btn) => {
    btn.onclick = async () => {
      const note = window.prompt('Note for the audit log (what you checked or did):', '');
      if (note === null) return;
      const { error: e } = await sb.rpc('admin_resolve_receipt_review', {
        p_id: Number(btn.dataset.rr), p_status: btn.dataset.rrStatus, p_note: note,
      });
      if (e) toast(e.message);
      else { toast('Saved', true); renderReceiptReviews(); }
    };
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(renderReceiptReviews, 800));
else setTimeout(renderReceiptReviews, 800);
