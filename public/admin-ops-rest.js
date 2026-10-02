// Ops tabs plus settings binds and localStorage tab restore.
const OPS_LABEL = {
  emergency_payments_stop: 'Stop new customer payments',
  emergency_withdrawals_stop: 'Stop withdrawals',
  manual_withdrawals_enabled: 'Manual withdrawals',
  auto_withdraw_enabled: 'Auto-queue USDT payouts',
  pending_count: 'Waiting', pending_amount: 'Waiting amount', processing_count: 'Processing',
  last_webhook_at: 'Last webhook', last_daily_stat_at: 'Last daily close',
  last_settled_at: 'Last settled payment', oldest_pending_payment_at: 'Oldest unpaid invoice',
  oldest_pending_withdrawal_at: 'Oldest waiting payout', active_onchain_addresses: 'Saved on-chain addresses',
  active: 'Active', pending: 'Pending', suspended: 'Suspended', payment_ready: 'Payment-ready',
  size_bytes: 'Database bytes', size_pretty: 'Database size',
  settled_24h: 'Settled last 24h', payments_24h: 'Payments last 24h',
  withdrawals_24h: 'Withdrawals last 24h', new_profiles_24h: 'New accounts last 24h',
  new_payments: 'New invoices', pending_payments: 'Unpaid invoices',
  pending_withdrawals: 'Waiting payouts', pending_applications: 'Waiting applications',
  processing_withdrawals: 'Payouts in flight', domains: 'Domains', profiles: 'Accounts',
  active_links: 'Active links', payment_links: 'Payment links', active_profiles: 'Active accounts',
};
function opsLabel(k) { return OPS_LABEL[k] || k.replace(/_/g, ' '); }
function opsValue(v) {
  if (v === true) return 'On'; if (v === false) return 'Off';
  if (v == null || v === '') return '\u2014';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && typeof when === 'function') return when(v);
  if (v && typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
function kvCard(title, obj) {
  const src = { ...(obj || {}) }; delete src.auto_withdraw_enabled;
  const rows = Object.entries(src).map(([k, v]) => `<tr><td>${escapeHtml(opsLabel(k))}</td><td class="mono">${escapeHtml(opsValue(v))}</td></tr>`).join('');
  return `<div class="card flush"><h3 style="padding:16px 20px 0">${escapeHtml(title)}</h3><table class="table"><tbody>${rows || '<tr><td class="empty">No data</td></tr>'}</tbody></table></div>`;
}
function flagOn(value) {
  if (value === true || value === 'true') return true;
  if (value && typeof value === 'object' && 'value' in value) return flagOn(value.value);
  return false;
}
const FLAG_ROWS = [
  ['emergency_payments_stop', 'Emergency: stop new customer payments'],
  ['emergency_withdrawals_stop', 'Emergency: stop withdrawals'],
  ['manual_withdrawals_enabled', 'Manual withdrawals enabled'],
  ['feature_affiliate_enabled', 'Reseller affiliate attach'],
  ['feature_reseller_team_withdraw', 'Reseller can cash out team books'],
  ['feature_reseller_notices', 'Reseller notices'],
  ['hide_small_payments_enabled', 'Global hide-small-payments'],
];
async function renderFlagsLive() {
  if (typeof renderFlags === 'function') return renderFlags();
}
async function renderHealth() {
  const el = document.getElementById('health'); if (!el) return;
  const { data, error } = await sb.rpc('admin_ops_snapshot');
  if (error) { el.innerHTML = `<p class="err">${escapeHtml(error.message)}</p>`; return; }
  const s = data || {};
  el.innerHTML = `<div class="card"><h3>Health</h3><p class="faint">Can payments and payouts run right now?</p></div>${kvCard('Switches', s.flags)}${kvCard('Payouts', s.withdrawals)}${kvCard('Pipeline', s.pipeline)}${kvCard('Receiving', s.receiving)}${kvCard('Accounts', s.profiles)}${kvCard('Domains', s.domains)}`;
}
async function renderSystem() {
  const el = document.getElementById('system'); if (!el) return;
  const snap = await sb.rpc('admin_system_snapshot');
  const alerts = await sb.rpc('admin_system_alerts');
  if (snap.error) { el.innerHTML = `<p class="err">${escapeHtml(snap.error.message)}</p>`; return; }
  const s = snap.data || {};
  const alertRows = ((alerts.data && alerts.data.alerts) || []).map((a) => `<tr><td>${escapeHtml(a.severity || '')}</td><td>${escapeHtml(a.title || '')}</td><td>${escapeHtml(a.detail || '')}</td></tr>`).join('');
  el.innerHTML = `<div class="card"><h3>System</h3><p class="faint">Database, traffic and queues. Read only.</p></div>${kvCard('Database', s.database)}${kvCard('Last 24 hours', s.traffic)}${kvCard('Queues', s.queues)}${kvCard('Platform', s.platform)}${kvCard('Timing', s.latency)}<div class="card flush"><h3 style="padding:16px 20px 0">Alerts</h3><table class="table"><thead><tr><th>Level</th><th>Title</th><th>Detail</th></tr></thead><tbody>${alertRows || '<tr><td colspan="3" class="empty">No alerts</td></tr>'}</tbody></table></div>`;
}
async function renderAudit() {
  const el = document.getElementById('audit'); if (!el) return;
  const { data, error } = await sb.from('audit_log').select('id,occurred_at,actor_email,action,subject_type,subject_id,note').order('occurred_at', { ascending: false }).limit(80);
  if (error) { el.innerHTML = `<p class="err">${escapeHtml(error.message)}</p>`; return; }
  const rows = (data || []).map((r) => `<tr><td>${escapeHtml(when(r.occurred_at))}</td><td>${escapeHtml(r.actor_email || '')}</td><td>${escapeHtml(r.action || '')}</td><td>${escapeHtml(r.subject_type || '')}</td><td class="mono">${escapeHtml(String(r.subject_id || '').slice(0, 8))}</td><td>${escapeHtml(r.note || '')}</td></tr>`).join('');
  el.innerHTML = `<div class="card flush"><table class="table"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Type</th><th>Id</th><th>Note</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="empty">No audit rows</td></tr>'}</tbody></table></div>`;
}
function rememberedTab() {
  try { return localStorage.getItem('cpay-admin-tab'); } catch (e) { return null; }
}
const __show = window.show;
window.show = function (tab) {
  if (!tab) tab = rememberedTab() || 'home';
  if (typeof __show === 'function') __show(tab);
  try { localStorage.setItem('cpay-admin-tab', tab); } catch (e) {}
  if (tab === 'health') renderHealth();
  if (tab === 'system') renderSystem();
  if (tab === 'audit') renderAudit();
  if (tab === 'settings') renderFlagsLive();
};
setTimeout(() => {
  renderHealth(); renderSystem(); renderAudit(); renderFlagsLive();
}, 800);
document.getElementById('settings')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn || !document.getElementById('settings').contains(btn)) return;
  const id = btn.id;
  async function save(rpc, args, ok) {
    btn.disabled = true;
    const { error } = await sb.rpc(rpc, args);
    btn.disabled = false;
    if (error) return toast(error.message);
    toast(ok, true);
  }
  if (id === 'saveDefFee') return save('admin_set_default_platform_fee', { p_percent: Number(document.getElementById('defFee').value) }, 'Default fee saved');
  if (id === 'saveDefComm') return save('admin_set_default_reseller_commission', { p_percent: Number(document.getElementById('defComm').value) }, 'Default commission saved');
  if (id === 'saveDefWfee') return save('admin_set_default_withdrawal_fee', { p_percent: Number(document.getElementById('defWfee').value) }, 'Default withdrawal fee saved');
});
