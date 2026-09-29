// Ops tabs that were missing after the merge.
function kvCard(title, obj) {
  const rows = Object.entries(obj || {}).map(([k, v]) => {
    const val = v && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '-');
    return `<tr><td>${escapeHtml(k)}</td><td class="mono">${escapeHtml(val)}</td></tr>`;
  }).join('');
  return `<div class="card flush"><h3 style="padding:16px 20px 0">${escapeHtml(title)}</h3>
    <table class="table"><tbody>${rows || '<tr><td class="empty">No data</td></tr>'}</tbody></table></div>`;
}

async function renderHealth() {
  const el = document.getElementById('health');
  if (!el) return;
  const { data, error } = await sb.rpc('admin_ops_snapshot');
  if (error) { el.innerHTML = `<p class="err">${escapeHtml(error.message)}</p>`; return; }
  const s = data || {};
  el.innerHTML = `<div class="card"><h3>Operations preflight</h3><p class="faint">Same signals as the old Health tab.</p></div>
    ${kvCard('Flags', s.flags)}
    ${kvCard('Withdrawals', s.withdrawals)}
    ${kvCard('Pipeline', s.pipeline)}
    ${kvCard('Receiving', s.receiving)}
    ${kvCard('Profiles', s.profiles)}
    ${kvCard('Domains', s.domains)}`;
}

async function renderSystem() {
  const el = document.getElementById('system');
  if (!el) return;
  const snap = await sb.rpc('admin_system_snapshot');
  const alerts = await sb.rpc('admin_system_alerts');
  if (snap.error) { el.innerHTML = `<p class="err">${escapeHtml(snap.error.message)}</p>`; return; }
  const s = snap.data || {};
  const alertRows = ((alerts.data && alerts.data.alerts) || []).map((a) =>
    `<tr><td>${escapeHtml(a.severity || '')}</td><td>${escapeHtml(a.title || '')}</td><td>${escapeHtml(a.detail || '')}</td></tr>`
  ).join('');
  el.innerHTML = `<div class="card"><h3>System</h3><p class="faint">Database, traffic and queues. Read only.</p></div>
    ${kvCard('Database', s.database)}
    ${kvCard('Traffic', s.traffic)}
    ${kvCard('Queues', s.queues)}
    ${kvCard('Platform', s.platform)}
    ${kvCard('Latency', s.latency)}
    <div class="card flush"><h3 style="padding:16px 20px 0">Alerts</h3>
      <table class="table"><thead><tr><th>Level</th><th>Title</th><th>Detail</th></tr></thead>
      <tbody>${alertRows || '<tr><td colspan="3" class="empty">No alerts</td></tr>'}</tbody></table></div>`;
}

async function renderAudit() {
  const el = document.getElementById('audit');
  if (!el) return;
  const { data, error } = await sb.from('audit_log')
    .select('id,occurred_at,actor_email,action,subject_type,subject_id,note')
    .order('occurred_at', { ascending: false }).limit(80);
  if (error) { el.innerHTML = `<p class="err">${escapeHtml(error.message)}</p>`; return; }
  const rows = (data || []).map((r) => `<tr>
    <td>${escapeHtml(when(r.occurred_at))}</td>
    <td>${escapeHtml(r.actor_email || '')}</td>
    <td>${escapeHtml(r.action || '')}</td>
    <td>${escapeHtml(r.subject_type || '')}</td>
    <td class="mono">${escapeHtml(String(r.subject_id || '').slice(0, 8))}</td>
    <td>${escapeHtml(r.note || '')}</td>
  </tr>`).join('');
  el.innerHTML = `<div class="card flush"><table class="table"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Type</th><th>Id</th><th>Note</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6" class="empty">No audit rows</td></tr>'}</tbody></table></div>`;
}

const __show = window.show;
window.show = function (tab) {
  if (typeof __show === 'function') __show(tab);
  if (tab === 'health') renderHealth();
  if (tab === 'system') renderSystem();
  if (tab === 'audit') renderAudit();
};

setTimeout(() => { renderHealth(); renderSystem(); renderAudit(); }, 1200);
