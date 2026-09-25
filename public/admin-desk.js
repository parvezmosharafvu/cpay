const sb = window.supabaseClient;
let me = null;
let people = [];

let walletShown = false;
function show(tab) {
  document.querySelectorAll('main > section').forEach((s) => { s.hidden = s.id !== tab; });
  document.querySelectorAll('.navi[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  // The wallet talks to the payment service, so it loads on first open only.
  if (tab === 'wallet' && me?.role === 'admin' && !walletShown) { walletShown = true; renderWallet(); }
}
document.querySelectorAll('.navi[data-tab]').forEach((b) => { b.onclick = () => show(b.dataset.tab); });

async function boot() {
  me = await loadProfile();
  if (!me) return;
  if (me.role !== 'admin') { location.href = roleHome(me.role); return; }
  await Promise.all([renderHome(), renderPeople(), renderApps(), renderFees(), renderFlags(), renderAlerts(), renderPayouts(), renderChat()]);
  // Needs the people list renderPeople() loads, for the filters.
  await Daily.mountAdmin(document.getElementById('daily'), people);
}

async function renderHome() {
  const { data, error } = await sb.rpc('admin_global_stats');
  if (error) { document.getElementById('home').innerHTML = `<p class="err">${escapeHtml(error.message)}</p>`; return; }
  const s = Array.isArray(data) ? data[0] : data || {};
  document.getElementById('home').innerHTML = `<div class="grid kpis">
    <div class="card"><div class="kicker">Settled volume</div><div class="kpi">${money(s.total_settled)}</div><div class="faint">All settled payments</div></div>
    <div class="card"><div class="kicker">Platform fees</div><div class="kpi">${money(s.total_admin_profit)}</div><div class="faint">Earned on settled volume</div></div>
    <div class="card"><div class="kicker">Paid out</div><div class="kpi">${money(s.total_withdrawn)}</div><div class="faint">Withdrawals marked paid</div></div>
    <div class="card"><div class="kicker">Pending payouts</div><div class="kpi">${Number(s.pending_withdrawals_count || 0)}</div><div class="faint">${money(s.pending_withdrawals_amount)} waiting for review</div></div>
    <div class="card"><div class="kicker">Active accounts</div><div class="kpi">${Number(s.active_creators || 0)}</div></div>
    <div class="card"><div class="kicker">Settled payments</div><div class="kpi">${Number(s.payment_count || 0)}</div></div>
  </div>`;
}

async function renderPeople() {
  const [{ data, error }, { data: usage }, { data: wfees }] = await Promise.all([
    sb.rpc('admin_list_business_profiles'), sb.rpc('admin_link_usage'), sb.rpc('admin_withdraw_fee_overview'),
  ]);
  const links = Object.fromEntries((usage || []).map((u) => [u.user_id, u]));
  const wfee = Object.fromEntries((wfees || []).map((f) => [f.user_id, f]));
  if (error) { document.getElementById('people').innerHTML = `<p class="err">${escapeHtml(error.message)}</p>`; return; }
  people = data || [];
  const rows = people.map((p) => `<tr>
    <td>${escapeHtml(p.display_name || '')}<div class="faint">${escapeHtml(p.email)}</div></td>
    <td>${p.role === 'moderator' ? 'Reseller' : p.role === 'creator' ? 'Freelancer' : p.role}</td>
    <td>${badge(p.account_status)}</td>
    <td class="num nowrap">${links[p.id] ? `${links[p.id].links_used} / ${links[p.id].link_limit}` : '-'}</td>
    <td>${escapeHtml(p.reseller_name || '-')}</td>
    <td class="num">${Number(p.platform_fee_percent || 0).toFixed(2)}%</td>
    <td class="num nowrap">${wfee[p.id] ? `${Number(wfee[p.id].fee_percent).toFixed(2)}%<div class="faint">${FEE_SOURCE[wfee[p.id].source] || ''}</div>` : '-'}</td>
    <td>${escapeHtml(p.hide_small_payments_mode)}</td>
    <td class="num">${money(p.available)}</td>
    <td style="white-space:nowrap">
      ${links[p.id] ? `<button class="btn ghost sm" data-limit="${p.id}" data-cur="${links[p.id].link_limit}">Link limit</button>` : ''}
      <button class="btn ghost sm" data-fee="${p.id}">Platform fee</button>
      <button class="btn ghost sm" data-wfee="${p.id}" data-cur="${wfee[p.id]?.own_fee_percent ?? ''}">Withdraw fee</button>
      ${p.role === 'moderator' ? `<button class="btn ghost sm" data-comm="${p.id}">Commission</button>` : ''}
      <button class="btn ghost sm" data-hide="${p.id}">Hide &lt;$10</button>
    </td>
  </tr>`).join('');
  document.getElementById('people').innerHTML = `<div class="card flush">
    <table class="table"><thead><tr><th>Account</th><th>Role</th><th>Status</th><th class="num">Links</th><th>Reseller</th><th class="num">Platform fee</th><th class="num">Withdraw fee</th><th>Small payments</th><th class="num">Available</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="10" class="empty">No accounts</td></tr>'}</tbody></table>
  </div>`;
  document.querySelectorAll('[data-limit]').forEach((btn) => {
    btn.onclick = async () => {
      const raw = prompt('Active payment links this account may have (0 to 10). A name with several spellings counts as one link.', btn.dataset.cur);
      if (raw == null) return;
      const { error: e } = await sb.rpc('admin_set_link_limit', { p_creator_id: btn.dataset.limit, p_limit: Number(raw) });
      if (e) return toast(e.message);
      toast('Link limit saved', true); renderPeople();
    };
  });
  document.querySelectorAll('[data-fee]').forEach((btn) => {
    btn.onclick = async () => {
      const raw = prompt('Platform fee % on this book\'s settled earnings');
      if (raw == null) return;
      const { error: e } = await sb.rpc('admin_set_platform_fee', { p_user_id: btn.dataset.fee, p_percent: Number(raw) });
      if (e) return toast(e.message);
      toast('Fee saved', true); renderPeople(); renderHome();
    };
  });
  document.querySelectorAll('[data-wfee]').forEach((btn) => {
    btn.onclick = async () => {
      const raw = prompt('Withdrawal fee % for this account only. Leave empty to inherit (reseller team fee, then the global default).', btn.dataset.cur);
      if (raw == null) return;
      const v = raw.trim() === '' ? null : Number(raw);
      if (v != null && !(v >= 0 && v <= 100)) return toast('Enter 0 to 100, or leave empty');
      const { error: e } = await sb.rpc('admin_update_creator_fee', { p_creator_id: btn.dataset.wfee, p_fee_percent: v });
      if (e) return toast(e.message);
      toast(v == null ? 'Override cleared' : 'Withdrawal fee saved', true); renderPeople();
    };
  });
  document.querySelectorAll('[data-comm]').forEach((btn) => {
    btn.onclick = async () => {
      const raw = prompt('Reseller commission % on affiliate net (after platform fee, not link cost)');
      if (raw == null) return;
      const { error: e } = await sb.rpc('admin_set_reseller_commission', { p_reseller_id: btn.dataset.comm, p_percent: Number(raw) });
      if (e) return toast(e.message);
      toast('Commission saved', true); renderPeople();
    };
  });
  document.querySelectorAll('[data-hide]').forEach((btn) => {
    btn.onclick = async () => {
      const raw = prompt('inherit / on / off', 'inherit');
      if (!raw) return;
      const { error: e } = await sb.rpc('admin_set_profile_hide_small', { p_user_id: btn.dataset.hide, p_mode: raw.trim() });
      if (e) return toast(e.message);
      toast('Filter saved', true); renderPeople();
    };
  });
}

async function renderApps() {
  const { data, error } = await sb.rpc('admin_list_account_applications');
  if (error) { document.getElementById('apps').innerHTML = `<p class="muted">Applications RPC: ${escapeHtml(error.message)}</p>`; return; }
  const rows = (data || []).map((a) => `<tr>
    <td>${escapeHtml(a.display_name || a.email)}</td>
    <td>${escapeHtml(a.requested_role)}</td>
    <td>${badge(a.status)}</td>
    <td class="num">
      <button class="btn primary sm" data-approve="${a.user_id}">Approve</button>
      <button class="btn danger sm" data-reject="${a.user_id}">Reject</button>
    </td>
  </tr>`).join('');
  document.getElementById('apps').innerHTML = `<div class="card flush"><table class="table"><thead><tr><th>Applicant</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="empty">No applications waiting</td></tr>'}</tbody></table></div>`;
  document.querySelectorAll('[data-approve]').forEach((b) => b.onclick = () => review(b.dataset.approve, 'approved'));
  document.querySelectorAll('[data-reject]').forEach((b) => b.onclick = () => review(b.dataset.reject, 'rejected'));
}
async function review(id, status) {
  const { error } = await sb.rpc('admin_review_account_application', { p_user_id: id, p_status: status });
  if (error) return toast(error.message);
  toast('Updated', true); renderApps(); renderPeople();
}

const FEE_SOURCE = { account: 'own', reseller: 'reseller', global: 'global', none: 'global' };

async function renderFees() {
  const { data: settings } = await sb.from('app_settings').select('key, value').eq('key', 'default_withdrawal_fee_percent');
  const globalWfee = Number(settings?.[0]?.value?.percent ?? 0);
  document.getElementById('fees').innerHTML = `<div class="card narrow">
    <h3>Withdrawal fee</h3>
    <p class="muted">The platform fee on a withdrawal. Each account uses its own fee if one is set, else its reseller's team fee, else this default. 0 means no platform fee; users then see only the network fee.</p>
    <div class="field short"><label for="defWfee">Default withdrawal fee %</label><input id="defWfee" type="number" min="0" max="100" step="0.1" value="${globalWfee}"></div>
    <button class="btn primary" id="saveDefWfee">Save withdrawal fee</button>
  </div>
  <div class="card" id="resellerWithdraw"><p class="muted">Loading resellers…</p></div>
  <div class="card narrow">
    <h3>Defaults</h3>
    <p class="muted">Platform fee is CPAY's cut of settled payments. Link cost is added to what the payer pays. Reseller commission is the reseller's cut of the net after the platform fee.</p>
    <div class="field short"><label for="defFee">Platform fee %</label><input id="defFee" type="number" min="0" max="90" step="0.1" value="3"></div>
    <button class="btn primary" id="saveDefFee">Save platform fee</button>
    <hr>
    <div class="field short"><label for="defComm">Reseller commission %</label><input id="defComm" type="number" min="0" max="50" step="0.1" value="8"></div>
    <p class="hint">Applies to freelancers who joined through a reseller's link.</p>
    <button class="btn primary" id="saveDefComm">Save commission</button>
  </div>
  <div class="card narrow">
    <h3>Hide small payments</h3>
    <div class="field short"><label for="hideAmt">Hide settled payments under $</label><input id="hideAmt" type="number" min="0" value="10"></div>
    <div class="row">
      <button class="btn primary" id="hideOn">Turn on for everyone</button>
      <button class="btn ghost" id="hideOff">Turn off for everyone</button>
    </div>
    <p class="faint" style="margin:12px 0 0">Each account can still override this with inherit, on or off.</p>
  </div>`;
  document.getElementById('saveDefWfee').onclick = async () => {
    const { error } = await sb.rpc('admin_set_default_withdrawal_fee', { p_percent: Number(document.getElementById('defWfee').value) });
    if (error) return toast(error.message);
    toast('Default withdrawal fee saved', true); renderPeople(); renderResellerWithdraw();
  };
  await renderResellerWithdraw();
  document.getElementById('saveDefFee').onclick = async () => {
    const { error } = await sb.rpc('admin_set_default_platform_fee', { p_percent: Number(document.getElementById('defFee').value) });
    if (error) return toast(error.message);
    toast('Default fee saved', true);
  };
  document.getElementById('saveDefComm').onclick = async () => {
    const { error } = await sb.rpc('admin_set_default_reseller_commission', { p_percent: Number(document.getElementById('defComm').value) });
    if (error) return toast(error.message);
    toast('Default commission saved', true);
  };
  document.getElementById('hideOn').onclick = () => setHide(true);
  document.getElementById('hideOff').onclick = () => setHide(false);
}
// Per reseller: may their freelancers withdraw by themselves (off by
// default), and the team withdrawal fee (empty = global default). The
// reseller can flip the same switch from their own desk.
async function renderResellerWithdraw() {
  const el = document.getElementById('resellerWithdraw');
  if (!el) return;
  const { data, error } = await sb.rpc('admin_list_reseller_settings');
  if (error) { el.innerHTML = `<p class="err">${escapeHtml(error.message)}</p>`; return; }
  const rows = (data || []).map((r) => `<tr>
    <td>${escapeHtml(r.display_name || r.email)}<div class="faint">${escapeHtml(r.email)}</div></td>
    <td class="num">${Number(r.team_size || 0)}</td>
    <td><label class="switch"><input type="checkbox" data-selfw="${r.reseller_id}" ${r.allow_freelancer_self_withdraw ? 'checked' : ''} aria-label="Freelancers can withdraw by themselves"> <span>${r.allow_freelancer_self_withdraw ? 'On' : 'Off'}</span></label></td>
    <td class="nowrap"><input class="input" style="width:90px" type="number" min="0" max="100" step="0.1" data-tfee="${r.reseller_id}" value="${r.team_withdrawal_fee_percent ?? ''}" placeholder="Default" aria-label="Team withdrawal fee %">
      <button class="btn ghost sm" data-tfee-save="${r.reseller_id}">Save</button></td>
  </tr>`).join('');
  el.classList.add('flush');
  el.innerHTML = `<h3>Reseller withdrawals</h3>
    <p class="muted" style="padding:0 20px">Self-withdraw off: the reseller's freelancers see their balance but cannot withdraw; the reseller withdraws for them. Team fee applies to the reseller's freelancers who have no fee of their own. Leave it empty for the default.</p>
    <table class="table"><thead><tr><th>Reseller</th><th class="num">Team</th><th>Freelancers self-withdraw</th><th>Team withdrawal fee %</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4" class="empty">No resellers</td></tr>'}</tbody></table>`;
  el.querySelectorAll('[data-selfw]').forEach((box) => {
    box.onchange = async () => {
      box.disabled = true;
      const { error: e } = await sb.rpc('admin_set_reseller_self_withdraw', { p_reseller_id: box.dataset.selfw, p_allowed: box.checked });
      box.disabled = false;
      if (e) { box.checked = !box.checked; return toast(e.message); }
      box.nextElementSibling.textContent = box.checked ? 'On' : 'Off';
      toast(box.checked ? 'Freelancers can withdraw by themselves' : 'Reseller handles withdrawals', true);
      renderPeople();
    };
  });
  el.querySelectorAll('[data-tfee-save]').forEach((btn) => {
    btn.onclick = async () => {
      const raw = el.querySelector(`[data-tfee="${btn.dataset.tfeeSave}"]`).value.trim();
      const v = raw === '' ? null : Number(raw);
      if (v != null && !(v >= 0 && v <= 100)) return toast('Enter 0 to 100, or leave empty');
      const { error: e } = await sb.rpc('admin_set_reseller_withdrawal_fee', { p_reseller_id: btn.dataset.tfeeSave, p_fee_percent: v });
      if (e) return toast(e.message);
      toast(v == null ? 'Team fee cleared' : 'Team fee saved', true); renderPeople();
    };
  });
}

async function setHide(on) {
  const { error } = await sb.rpc('admin_set_hide_small_payments', { p_enabled: on, p_threshold: Number(document.getElementById('hideAmt').value) || 10 });
  if (error) return toast(error.message);
  toast(on ? 'Global filter on' : 'Global filter off', true);
}

async function renderFlags() {
  const keys = [
    ['emergency_payments_stop', 'Emergency: stop new customer payments'],
    ['emergency_withdrawals_stop', 'Emergency: stop withdrawals'],
    ['manual_withdrawals_enabled', 'Manual withdrawals enabled'],
    ['auto_withdraw_enabled', 'Instant Lightning payouts master switch'],
    ['feature_affiliate_enabled', 'Reseller affiliate attach'],
    ['feature_reseller_team_withdraw', 'Reseller can cash out team books'],
    ['feature_reseller_notices', 'Reseller notices'],
    ['hide_small_payments_enabled', 'Global hide-small-payments'],
  ];
  document.getElementById('flags').innerHTML = `<div class="card flush"><table class="table"><tbody>${keys.map(([k, label]) => `
    <tr>
      <td>${escapeHtml(label)}<div class="faint mono">${k}</div></td>
      <td class="num" style="white-space:nowrap">
        <button class="btn primary sm" data-k="${k}" data-v="true">On</button>
        <button class="btn ghost sm" data-k="${k}" data-v="false">Off</button>
      </td>
    </tr>`).join('')}</tbody></table></div>`;
  document.querySelectorAll('#flags [data-k]').forEach((b) => {
    b.onclick = async () => {
      const { error } = await sb.rpc('admin_set_feature_toggle', { p_key: b.dataset.k, p_enabled: b.dataset.v === 'true' });
      if (error) return toast(error.message);
      toast('Toggle saved', true);
    };
  });
}

async function renderAlerts() {
  const resellers = people.filter((p) => p.role === 'moderator');
  const opts = resellers.map((p) => `<option value="${p.id}">${escapeHtml(p.display_name || p.email)}</option>`).join('');
  document.getElementById('alerts').innerHTML = `<div class="card narrow">
    <h3>Daily reseller digest</h3>
    <p class="muted">Sent at 5:00 PM Dhaka time with the settled total and earnings per link, including link cost.</p>
    <div class="field"><label for="alWho">Reseller</label><select id="alWho">${opts}</select></div>
    <div class="field"><label for="alDisc">Discord webhook</label><input id="alDisc"></div>
    <div class="field"><label for="alTok">Telegram bot token</label><input id="alTok"></div>
    <div class="field"><label for="alChat">Telegram chat ID</label><input id="alChat"></div>
    <button class="btn primary" id="alSave">Save channel</button>
  </div>`;
  document.getElementById('alSave').onclick = async () => {
    const { error } = await sb.rpc('admin_set_reseller_alerts', {
      p_reseller_id: document.getElementById('alWho').value,
      p_discord_webhook: document.getElementById('alDisc').value,
      p_telegram_bot_token: document.getElementById('alTok').value,
      p_telegram_chat_id: document.getElementById('alChat').value,
      p_enabled: true,
    });
    if (error) return toast(error.message);
    toast('Alert channel saved', true);
  };
}

async function renderPayouts() {
  const { data, error } = await sb.from('withdrawals').select('*').order('requested_at', { ascending: false }).limit(40);
  if (error) { document.getElementById('payouts').innerHTML = `<p class="err">${escapeHtml(error.message)}</p>`; return; }
  const rows = (data || []).map((w) => `<tr><td class="num">${money(w.amount_requested)}</td><td class="num">${w.fee_percent != null ? Number(w.fee_percent) + '%' : '-'}</td><td class="num">${w.amount_after_fee != null ? money(w.amount_after_fee) : '-'}</td><td>${escapeHtml(methodLabel(w.method, w))}</td><td>${badge(w.status)}</td><td class="mono">${escapeHtml(w.destination || '')}</td><td>${escapeHtml(when(w.requested_at))}</td></tr>`).join('');
  document.getElementById('payouts').innerHTML = `<div class="card flush"><table class="table"><thead><tr><th class="num">Amount</th><th class="num">Fee</th><th class="num">Receives</th><th>Method</th><th>Status</th><th>Destination</th><th>Requested</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="empty">No withdrawals</td></tr>'}</tbody></table></div>
    <p class="faint">Approve, reject and mark-paid actions are in the <a href="admin-classic.html">ops panel</a>.</p>`;
}

async function renderChat() {
  const freelancers = people.filter((p) => p.role !== 'admin');
  const opts = freelancers.map((p) => `<option value="${p.id}">${escapeHtml(p.display_name || p.email)}</option>`).join('');
  document.getElementById('chat').innerHTML = `<div class="card narrow">
    <div class="field"><label for="cWho">Account</label><select id="cWho">${opts}</select></div>
    <div class="thread" id="cThread"></div>
    <div class="compose"><input class="input" id="cMsg" placeholder="Write a message" aria-label="Message"><button class="btn primary" id="cSend">Send</button></div>
  </div>`;
  async function load() {
    const uid = document.getElementById('cWho').value;
    if (!uid) return;
    const { data } = await sb.from('support_messages').select('*').eq('user_id', uid).order('created_at', { ascending: true }).limit(80);
    document.getElementById('cThread').innerHTML = (data || []).map((m) => `<div class="msg"><span class="faint">${escapeHtml(m.sender)}</span>${escapeHtml(m.message)}</div>`).join('') || '<p class="muted">No messages yet</p>';
  }
  document.getElementById('cWho')?.addEventListener('change', load);
  await load();
  document.getElementById('cSend').onclick = async () => {
    const { error } = await sb.from('support_messages').insert({ user_id: document.getElementById('cWho').value, sender: 'admin', message: document.getElementById('cMsg').value.trim() });
    if (error) return toast(error.message);
    load();
  };
}

boot();

const logoutBtn = document.getElementById("logoutBtn");
if (logoutBtn) logoutBtn.onclick = signOut;
