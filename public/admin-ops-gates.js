// Staging sign-off ledger. CI requires these RPC names to stay in the admin bundle.
async function loadOpsReleaseGates() {
  const sum = document.getElementById('opsGateSummary');
  const list = document.getElementById('opsGateList');
  if (!sum || !list || typeof sb === 'undefined') return;
  const { data, error } = await sb.rpc('admin_ops_release_gates');
  if (error) {
    list.textContent = error.message;
    return;
  }
  const rows = Array.isArray(data) ? data : [];
  const done = rows.filter((g) => g.completed).length;
  sum.textContent = rows.length ? `${done}/${rows.length} gates signed` : 'No release gates';
  list.innerHTML = rows.map((g) => {
    const key = String(g.gate_key || '');
    const on = !!g.completed;
    return `<label class="row" style="gap:8px;display:flex;align-items:center;padding:6px 0">
      <input type="checkbox" data-gate="${escapeHtml(key)}" ${on ? 'checked' : ''}>
      <span>${escapeHtml(g.title || key)}</span>
    </label>`;
  }).join('');
  list.querySelectorAll('[data-gate]').forEach((el) => {
    el.onchange = async () => {
      const { error: e } = await sb.rpc('admin_set_ops_release_gate', {
        p_gate_key: el.dataset.gate,
        p_completed: el.checked,
        p_evidence_note: el.checked ? 'Signed from admin panel' : 'Reopened from admin panel',
      });
      if (e) toast(e.message);
      else loadOpsReleaseGates();
    };
  });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(loadOpsReleaseGates, 1200));
} else {
  setTimeout(loadOpsReleaseGates, 1200);
}
