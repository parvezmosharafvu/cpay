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
  const ico = (id) => `<span class="stat-ico" aria-hidden="true"><svg class="ico" aria-hidden="true"><use href="#${id}"/></svg></span>`;
  const usdtCard = `<div class="card stat">${ico('i-wallet')}<div class="kicker">USDT balance</div><div class="kpi">${walletUsdt == null ? '-' : money(walletUsdt)}</div><div class="faint">${usdt && usdt.balanceSats != null ? Number(usdt.balanceSats).toLocaleString('en-US') + ' sats × wallet rate' : escapeHtml(usdtErr || 'Platform wallet')}</div><div class="faint"><a href="#wallet">Wallet link</a></div></div>
       <div class="card stat">${ico('i-users')}<div class="kicker">Owed to freelancers</div><div class="kpi">${money(owed)}</div><div class="faint">Sum of freelancer available balances.</div></div>
       <div class="card stat">${ico('i-dollar')}<div class="kicker">Spendable</div><div class="kpi">${usdt && usdt.spendableSat != null ? Number(usdt.spendableSat).toLocaleString('en-US') + ' sats' : '-'}</div><div class="faint">Wallet sats minus freelancer books</div></div>`;
  const byWallet = {};
  for (const w of walletsRes.data || []) (byWallet[w.user_id] ||= []).push(w);
  const EXPLORER = { tron:'https://tronscan.org/#/address/', bsc:'https://bscscan.com/address/', ethereum:'https://etherscan.io/address/', polygon:'https://polygonscan.com/address/', arbitrum:'https://arbiscan.io/address/', base:'https://basescan.org/address/', optimism:'https://optimistic.etherscan.io/address/', avalanche:'https://snowtrace.io/address/', solana:'https://solscan.io/account/' };
  const userRows = (peopleRes.data || []).slice(0, 12).map((p) => {
    const links = (byWallet[p.id] || []).map((w) => `<a href="${EXPLORER[w.network] || '#'}${encodeURIComponent(w.address)}" target="_blank" rel="noopener">${escapeHtml(w.network)}</a>`).join(' · ') || '<span class="faint">No wallet</span>';
    return `<tr><td class="lead"><span class="cell-main">${escapeHtml(p.display_name || '')}</span><span class="cell-sub">${escapeHtml(p.email || '')}</span></td><td data-label="Role">${p.role === 'creator' ? 'Freelancer' : escapeHtml(p.role || '')}</td><td data-label="Status">${badge(p.account_status)}</td><td data-label="Wallet link">${links}</td><td class="num" data-label="Available">${money(p.available)}</td></tr>`;
  }).join('');
  const pendingApps = (apps.data || []).filter((a) => ['pending', 'submitted'].includes(String(a.status)));
  const appRows = (apps.data || []).slice(0, 8).map((a) => {
    const open = ['pending', 'submitted'].includes(String(a.status));
    const acts = open
      ? `<button class="btn primary sm" data-ap="${a.id}" data-dec="approved">Approve</button> <button class="btn danger sm" data-ap="${a.id}" data-dec="rejected">Reject</button>`
      : '';
    return `<tr><td class="lead"><span class="cell-main">${escapeHtml(a.display_name || a.email || '')}</span></td><td data-label="Role">${escapeHtml(a.requested_role || '')}</td><td data-label="Account type">${escapeHtml(accountTypeText(a))}</td><td data-label="Status">${badge(a.status)}</td><td class="num table-actions">${acts}</td></tr>`;
  }).join('');
  const payRows = (pays.data || []).map((p) => `<tr>
      <td data-label="When">${escapeHtml(when(p.settled_at || p.created_at))}</td>
      <td data-label="Status">${badge(p.status)}</td>
      <td class="num" data-label="Amount"><span class="cell-main">${money(p.amount_settled ?? p.amount_requested)}</span></td>
      <td data-label="Account">${escapeHtml(p.creator_name || p.creator_email || '')}</td>
      <td class="mono" data-label="Link">${escapeHtml(p.link_slug || '')}</td>
    </tr>`).join('');
  const wdRows = (wds.data || []).map((w) => {
    const open = ['pending', 'approved', 'processing'].includes(String(w.status));
    const acts = open ? `<button class="btn primary sm" data-wdh="${w.id}">Mark paid</button>` : '';
    return `<tr><td class="num" data-label="Amount"><span class="cell-main">${money(w.amount_requested)}</span></td><td data-label="Status">${badge(w.status)}</td><td class="mono" data-label="Address">${escapeHtml(w.destination || '')}</td><td class="table-actions">${acts}</td></tr>`;
  }).join('');
  const head = (title, sub, extra = '') => `<div class="card-head"><div><h3>${title}</h3>${sub ? `<div class="faint">${sub}</div>` : ''}</div>${extra}</div>`;
  el.innerHTML = `<div class="grid kpis kpi-strip">${usdtCard}
    <div class="card stat">${ico('i-in')}<div class="kicker">Settled volume</div><div class="kpi">${money(s.total_settled)}</div><div class="faint">All settled payments</div></div>
    <div class="card stat">${ico('i-file-check')}<div class="kicker">Platform fees</div><div class="kpi">${money(s.total_admin_profit)}</div><div class="faint">Earned on settled volume</div></div>
    <div class="card stat">${ico('i-out')}<div class="kicker">Paid out</div><div class="kpi">${money(s.total_withdrawn)}</div><div class="faint">Withdrawals marked paid</div></div>
    <div class="card stat">${ico('i-clock')}<div class="kicker">Pending payouts</div><div class="kpi">${Number(s.pending_withdrawals_count || 0)}</div><div class="faint">Waiting to be sent or reviewed</div></div>
    <div class="card stat">${ico('i-user')}<div class="kicker">Active accounts</div><div class="kpi">${Number(s.active_creators || 0)}</div><div class="faint">Freelancers who can sign in</div></div>
    <div class="card stat">${ico('i-user-check')}<div class="kicker">Waiting applications</div><div class="kpi">${pendingApps.length}</div><div class="faint">New accounts to review</div></div>
  </div>
  <div class="card flush">${head('Applications', 'Approve or reject new accounts.', '<a class="link-btn" href="#apps" data-jump-tab="apps">All applications</a>')}
      <table class="table rtable"><thead><tr><th>Applicant</th><th>Role</th><th>Account type</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${appRows || `<tr><td colspan="5">${deskEmpty('No applications', 'New sign-ups wait here for review.')}</td></tr>`}</tbody></table></div>
  <div class="card flush">${head('Recent payouts', '', '<a class="link-btn" href="#payouts" data-jump-tab="payouts">All payouts</a>')}
      <table class="table rtable"><thead><tr><th class="num">Amount</th><th>Status</th><th>Address</th><th><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${wdRows || `<tr><td colspan="4">${deskEmpty('No withdrawals', 'USDT payouts appear here.')}</td></tr>`}</tbody></table></div>
  <div class="card flush">${head('Recent payments', '', '<a class="link-btn" href="#payments" data-jump-tab="payments">All payments</a>')}
    <table class="table rtable"><thead><tr><th>When</th><th>Status</th><th class="num">Amount</th><th>Account</th><th>Link</th></tr></thead>
    <tbody>${payRows || `<tr><td colspan="5">${deskEmpty('No payments yet', 'Settled and open invoices appear here.')}</td></tr>`}</tbody></table></div>
  <div class="card flush">${head('Users', 'The first 12 accounts and their saved payout networks.', '<a class="btn primary sm" href="#people">Manage users</a>')}
    <table class="table rtable"><thead><tr><th>Account</th><th>Role</th><th>Status</th><th>Wallet link</th><th class="num">Available</th></tr></thead>
    <tbody>${userRows || `<tr><td colspan="5">${deskEmpty('No accounts', '')}</td></tr>`}</tbody></table></div>`;
  el.querySelectorAll('[data-jump-tab]').forEach((a) => {
    a.addEventListener('click', (e) => {
      const nav = document.querySelector(`.side .navi[data-tab="${a.dataset.jumpTab}"]`);
      if (nav) { e.preventDefault(); nav.click(); }
    });
  });
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
        const run = () => adminFn('process-withdrawal', { withdrawalId: btn.dataset.wdh, action: 'mark_paid_manual' });
        await (window.cpayWithStepUp ? window.cpayWithStepUp(run) : run());
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
