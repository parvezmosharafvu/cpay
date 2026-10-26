// Bounded read-only requests; administrative mutations are never retried here.
let overviewReadVersion = 0;
async function overviewRead(read) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(read), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Read timed out')), 12000);
  })]); } catch (error) { return { data: null, error }; }
  finally { clearTimeout(timer); }
}
// Live Overview: one summary card (wallet, books, totals, queues) and the
// "All payments" card list below it.
const OVERVIEW_PAGE = 25;
async function overviewPayments({ offset = 0, limit = OVERVIEW_PAGE, search = null } = {}) {
  const { data, error } = await overviewRead(() => sb.rpc('admin_list_payments', { p_limit: limit, p_offset: offset, p_search: search }));
  return { rows: data || [], total: data && data[0] && data[0].total_count != null ? Number(data[0].total_count) : null, error };
}
async function renderHomeLive() {
  const el = document.getElementById('home');
  if (!el) return;
  const version = ++overviewReadVersion;
  el.setAttribute('aria-busy', 'true');
  const [{ data: stats, error: stErr }, apps, pays, peopleRes] = await Promise.all([
    () => sb.rpc('admin_global_stats'),
    () => sb.rpc('admin_list_account_applications'),
    () => sb.rpc('admin_list_payments', { p_limit: OVERVIEW_PAGE, p_offset: 0, p_search: null }),
    () => sb.rpc('admin_list_business_profiles'),
  ].map(overviewRead));
  if (version !== overviewReadVersion) return;
  el.setAttribute('aria-busy', 'false');
  const s = Array.isArray(stats) ? stats[0] : stats || {};
  const owed = (peopleRes.data || []).reduce((n, p) => n + Number(p.available || 0), 0);
  const pendingApps = (apps.data || []).filter((a) => ['pending', 'submitted'].includes(String(a.status)));
  const dash = '—';
  const stat = (label, value, attrs = '') => `<div class="ov-stat"><span class="ov-label">${label}</span><span class="ov-value"${attrs}>${value}</span></div>`;
  const chip = (tab, label, n) => `<a class="ov-chip" href="#${tab}" data-jump-tab="${tab}"><span>${label}</span>${n == null ? '' : `<b>${n}</b>`}</a>`;
  el.innerHTML = `<section class="card ov-summary" aria-labelledby="ovTitle">
    <div class="ov-head"><div><h2 id="ovTitle">Platform overview</h2><p class="faint">Balances, totals and work waiting for you.</p></div><button id="overview-refresh" class="btn ghost sm" type="button">Refresh overview</button></div>
    ${stErr ? '<p class="err" role="alert">Summary unavailable. Refresh overview to try again.</p>' : ''}
    <div class="ov-hero" id="overview-wallet"><span class="ov-label">Wallet value (USD)</span><span class="kpi">-</span><span class="faint">Loading wallet…</span><a class="ov-link" href="#wallet" data-jump-tab="wallet">Open wallet</a></div>
    <div class="ov-stats">
      ${stat('Owed to freelancers', peopleRes.error ? dash : money(owed))}
      ${stat('Spendable', '-', ' data-overview-spendable')}
      ${stat('Settled volume', stErr ? dash : money(s.total_settled))}
      ${stat('Platform fees', stErr ? dash : money(s.total_admin_profit))}
      ${stat('Paid out', stErr ? dash : money(s.total_withdrawn))}
      ${stat('Pending payouts', stErr ? dash : Number(s.pending_withdrawals_count || 0))}
      ${stat('Active accounts', stErr ? dash : Number(s.active_creators || 0))}
      ${stat('Waiting applications', apps.error ? dash : pendingApps.length)}
    </div>
    <div class="ov-chips">${chip('apps', 'Applications', apps.error ? null : pendingApps.length)}${chip('payouts', 'Payouts', stErr ? null : Number(s.pending_withdrawals_count || 0))}${chip('people', 'Users', null)}${chip('health', 'Service checks', null)}</div>
  </section>
  <div id="overviewPays">${pays.error ? '<p class="err" role="alert">Could not load this section. Refresh overview to try again.</p>' : ''}</div>`;
  document.getElementById('overview-refresh').onclick = renderHomeLive;
  const paysHost = document.getElementById('overviewPays');
  if (window.cpayPayCards && paysHost) {
    window.cpayPayCards.mount(paysHost, {
      mode: 'admin', title: 'All payments', pageSize: OVERVIEW_PAGE, fetch: overviewPayments,
      initial: { rows: pays.data || [], error: pays.error },
      actions: (p) => (p.status !== 'settled' && p.status !== 'expired' && typeof adminFn === 'function') ? [{
        label: 'Mark settled', cls: 'btn ghost sm',
        run: async () => {
          try { await adminFn('admin-mark-settled', { paymentId: p.id }); toast('Marked settled', true); renderHomeLive(); }
          catch (e) { toast(e.message); }
        },
      }] : [],
    });
  }
  overviewRead(() => walletCall('info')).then(result => {
    if (version !== overviewReadVersion) return;
    const panel = document.getElementById('overview-wallet');
    if (!panel) return;
    panel.querySelector('.kpi').textContent = result.balanceUsd != null ? money(Number(result.balanceUsd)) : '—';
    panel.querySelector('.faint').textContent = result.error ? 'Wallet unavailable. Refresh overview to try again.' : (result.balanceSats != null ? Number(result.balanceSats).toLocaleString('en-US') + ' sats × wallet rate' : 'Wallet value unavailable');
    const spendable = el.querySelector('[data-overview-spendable]');
    if (spendable) spendable.textContent = result.spendableSat != null ? Number(result.spendableSat).toLocaleString('en-US') + ' sats' : '—';
  });
  el.querySelectorAll('[data-jump-tab]').forEach((a) => {
    a.addEventListener('click', (e) => {
      const nav = document.querySelector(`.side .navi[data-tab="${a.dataset.jumpTab}"]`);
      if (nav) { e.preventDefault(); nav.click(); }
    });
  });
}

window.renderHome = renderHomeLive;
const __showHome = window.show;
window.show = function (tab) {
  if (typeof __showHome === 'function') __showHome(tab);
  if (tab === 'home') renderHomeLive();
};
setTimeout(renderHomeLive, 900);
