// Live Overview boards (applications, payouts, payments).
async function renderHomeLive() {
  const el = document.getElementById('home');
  if (!el) return;
  const [{ data: stats, error: stErr }, apps, pays, wds, peopleRes, walletsRes] = await Promise.all([
    sb.rpc('admin_global_stats'),
    sb.rpc('admin_list_account_applications'),
    sb.rpc('admin_list_payments', { p_limit: 8, p_offset: 0, p_search: null }),
    sb.from('withdrawals').select('id,amount_requested,status,destination,requested_at,method').order('requested_at', { ascending: false }).limit(8),
    sb.rpc('admin_list_business_profiles'),
    sb.rpc('admin_list_user_wallets'),
  ]);
  let usdt = null, usdtErr = '';
  try { usdt = await walletCall('info'); }
  catch (e) { usdtErr = e.message || 'Wallet did not answer'; }
  if (stErr) { el.innerHTML = `<p class="err" role="alert">${escapeHtml(stErr.message)}</p>`; return; }
  const s = Array.isArray(stats) ? stats[0] : stats || {};
  const books = (peopleRes.data || []).reduce((n, p) => n + Number(p.available || 0), 0);
  const walletUsdt = usdt && usdt.balanceUsd != null ? Number(usdt.balanceUsd) : null;
  const owed = books;
  const usdtCard = `<div class="card"><div class="kicker">USDT balance</div><div class="kpi">${walletUsdt == null ? '-' : money(walletUsdt)}</div><div class="faint">${usdt && usdt.balanceSats != null ? Number(usdt.balanceSats).toLocaleString('en-US') + ' sats × wallet rate' : escapeHtml(usdtErr || 'Platform wallet')}</div><div class="faint"><a href="#wallet">Wallet link</a></div></div>
       <div class="card"><div class="kicker">Owed to freelancers</div><div class="kpi">${money(owed)}</div><div class="faint">Sum of freelancer available balances.</div></div>
       <div class="card"><div class="kicker">Spendable</div><div class="kpi">${usdt && usdt.spendableSat != null ? Number(usdt.spendableSat).toLocaleString('en-US') + ' sats' : '-'}</div><div class="faint">Wallet sats minus freelancer books</div></div>`;
  const byWallet = {};
  for (const w of walletsRes.data || []) (byWallet[w.user_id] ||= []).push(w);
  const EXPLORER = { tron:'https://tronscan.org/#/address/', bsc:'https://bscscan.com/address/', ethereum:'https://etherscan.io/address/', polygon:'https://polygonscan.com/address/', arbitrum:'https://arbiscan.io/address/', base:'https://basescan.org/address/', optimism:'https://optimistic.etherscan.io/address/', avalanche:'https://snowtrace.io/address/', solana:'https://solscan.io/account/' };
  const userRows = (peopleRes.data || []).slice(0, 12).map((p) => {
    const links = (byWallet[p.id] || []).map((w) => `<a href="${EXPLORER[w.network] || '#'}${encodeURIComponent(w.address)}" target="_blank" rel="noopener">${escapeHtml(w.network)}</a>`).join(' · ') || '<span class="faint">No wallet</span>';
    return `<tr><td>${escapeHtml(p.display_name || '')}<div class="faint">${escapeHtml(p.email || '')}</div></td><td>${p.role === 'creator' ? 'Freelancer' : escapeHtml(p.role || '')}</td><td>${badge(p.account_status)}</td><td>${links}</td><td class="num">${money(p.available)}</td></tr>`;
  }).join('');
  const pendingApps = (apps.data || []).filter((a) => ['pending', 'submitted'].includes(String(a.status)));
  const appRows = (apps.data || []).slice(0, 8).map((a) => {
    const open = ['pending', 'submitted'].includes(String(a.status));
    const acts = open
      ? `<button class="btn primary sm" data-ap="${a.id}" data-dec="approved">Approve</button> <button class="btn danger sm" data-ap="${a.id}" data-dec="rejected">Reject</button>`
      : '';
    return `<tr><td>${escapeHtml(a.display_name || a.email || '')}</td><td>${escapeHtml(a.requested_role || '')}</td><td>${badge(a.status)}</td><td class="num">${acts}</td></tr>`;
  }).join('');
  const payRows = (pays.data || []).map((p) => `<tr>
      <td>${escapeHtml(when(p.settled_at || p.created_at))}</td>
      <td>${badge(p.status)}</td>
      <td class="num">${money(p.amount_settled ?? p.amount_requested)}</td>
      <td>${escapeHtml(p.creator_name || p.creator_email || '')}</td>
      <td class="mono">${escapeHtml(p.link_slug || '')}</td>
    </tr>`).join('');
  const wdRows = (wds.data || []).map((w) => {
    const open = ['pending', 'approved', 'processing'].includes(String(w.status));
    const acts = open ? `<button class="btn primary sm" data-wdh="${w.id}">Mark paid</button>` : '';
    return `<tr><td class="num">${money(w.amount_requested)}</td><td>${badge(w.status)}</td><td class="mono">${escapeHtml(w.destination || '')}</td><td>${acts}</td></tr>`;
  }).join('');
  el.innerHTML = `<div class="grid kpis">${usdtCard}</div>
  <div class="card flush"><h3 style="padding:16px 20px 0">Users</h3>
    <table class="table"><thead><tr><th>Account</th><th>Role</th><th>Status</th><th>Wallet link</th><th class="num">Available</th></tr></thead>
    <tbody>${userRows || '<tr><td colspan="5" class="empty">No accounts</td></tr>'}</tbody></table>
    <p style="padding:0 20px 16px"><a class="btn primary" href="#people">Manage users</a></p></div>
  <div class="grid kpis">
    <div class="card"><div class="kicker">Settled volume</div><div class="kpi">${money(s.total_settled)}</div></div>
    <div class="card"><div class="kicker">Platform fees</div><div class="kpi">${money(s.total_admin_profit)}</div></div>
    <div class="card"><div class="kicker">Paid out</div><div class="kpi">${money(s.total_withdrawn)}</div></div>
    <div class="card"><div class="kicker">Pending payouts</div><div class="kpi">${Number(s.pending_withdrawals_count || 0)}</div></div>
    <div class="card"><div class="kicker">Active accounts</div><div class="kpi">${Number(s.active_creators || 0)}</div></div>
    <div class="card"><div class="kicker">Waiting applications</div><div class="kpi">${pendingApps.length}</div></div>
  </div>
  <div class="card flush"><h3 style="padding:16px 20px 0">Applications</h3>
    <table class="table"><thead><tr><th>Applicant</th><th>Role</th><th>Status</th><th></th></tr></thead>
    <tbody>${appRows || '<tr><td colspan="4" class="empty">No applications</td></tr>'}</tbody></table></div>
  <div class="card flush"><h3 style="padding:16px 20px 0">Recent payouts</h3>
    <table class="table"><thead><tr><th class="num">Amount</th><th>Status</th><th>Address</th><th></th></tr></thead>
    <tbody>${wdRows || '<tr><td colspan="4" class="empty">No withdrawals</td></tr>'}</tbody></table></div>
  <div class="card flush"><h3 style="padding:16px 20px 0">Recent payments</h3>
    <table class="table"><thead><tr><th>When</th><th>Status</th><th class="num">Amount</th><th>Account</th><th>Link</th></tr></thead>
    <tbody>${payRows || '<tr><td colspan="5" class="empty">No payments yet</td></tr>'}</tbody></table></div>`;
  el.querySelectorAll('[data-ap]').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      const { error } = await sb.rpc('admin_review_account_application', {
        p_application_id: btn.dataset.ap, p_decision: btn.dataset.dec,
      });
      if (error) { toast(error.message); btn.disabled = false; return; }
      toast('Updated', true);
      renderHomeLive();
      if (typeof renderApps === 'function') renderApps();
      if (typeof renderPeople === 'function') renderPeople();
    };
  });
  el.querySelectorAll('[data-wdh]').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await adminFn('process-withdrawal', { withdrawalId: btn.dataset.wdh, action: 'mark_paid_manual' });
        toast('Marked paid', true);
        renderHomeLive();
        if (typeof renderPayouts === 'function') renderPayouts();
      } catch (e) { toast(e.message); btn.disabled = false; }
    };
  });
}

window.renderHome = renderHomeLive;
const __showHome = window.show;
window.show = function (tab) {
  if (typeof __showHome === 'function') __showHome(tab);
  if (tab === 'home') renderHomeLive();
};
setTimeout(renderHomeLive, 900);
