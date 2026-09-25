const sb = window.supabaseClient;
const exp = { theme: 'keypad', invoice: 'default', wallet: 'all_wallets' };
let me = null, resellerId = null;

function show(tab) {
  document.querySelectorAll('main > section').forEach((s) => { s.hidden = s.id !== tab; });
  document.querySelectorAll('.navi[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
}
document.querySelectorAll('.navi[data-tab]').forEach((b) => { b.onclick = () => show(b.dataset.tab); });

async function boot() {
  me = await loadProfile();
  if (!me) return;
  if (me.role === 'admin') { location.href = 'admin.html'; return; }
  if (me.role === 'moderator') { location.href = 'reseller.html'; return; }
  document.getElementById('hello').textContent = me.display_name || 'Freelancer';
  const { data: rid } = await sb.rpc('my_reseller_id');
  resellerId = rid;
  await Promise.all([renderHome(), renderLinks(), renderPays(), renderCash(), renderTeam(), renderChat(), renderProfile()]);
}

async function renderHome() {
  const [{ data: bal }, { data: split }] = await Promise.all([
    sb.rpc('get_my_balance'),
    sb.rpc('my_earnings_split'),
  ]);
  const b = Array.isArray(bal) ? bal[0] : bal || {};
  const s = Array.isArray(split) ? split[0] : split || {};
  const kpis = `<div class="grid kpis">
    <div class="card"><div class="kicker">Available</div><div class="kpi">${money(s.net ?? b.available)}</div><div class="faint">Ready to withdraw</div></div>
    <div class="card"><div class="kicker">Settled on your links</div><div class="kpi">${money(s.settled)}</div><div class="faint">All time, paid by customers</div></div>
    <div class="card"><div class="kicker">Platform fee</div><div class="kpi">${money(s.platform_fee)}</div><div class="faint">All time, CPAY's fee on settled payments</div></div>
    <div class="card"><div class="kicker">Reseller commission</div><div class="kpi">${money(s.reseller_commission_out)}</div><div class="faint">${Daily.pct(s.commission_percent || 0)} of your net after the platform fee</div></div>
    <div class="card"><div class="kicker">Link cost</div><div class="kpi">${Daily.pct(s.cost_percent || 0)}</div><div class="faint">${s.cost_locked ? 'Set by your reseller' : 'Added to what the payer pays'}</div></div>
  </div>`;
  const home = document.getElementById('home');
  home.innerHTML = '<div class="stack" id="dailySelf"><p class="muted">Loading…</p></div>';
  await Daily.mountSelf(document.getElementById('dailySelf'), { between: kpis });
}

async function renderLinks() {
  const { data: links } = await sb.from('payment_links').select('*').eq('user_id', me.id).is('deleted_at', null).order('created_at', { ascending: false });
  const list = (links || []).map((l) => `<tr>
    <td><a href="/${escapeHtml(l.slug)}" target="_blank">/${escapeHtml(l.slug)}</a></td>
    <td>${escapeHtml(l.display_name || '')}</td>
    <td>${escapeHtml(layoutLabel(l.theme))}</td>
    <td>${l.wallet_mode === 'cashapp' ? 'Cash App only' : 'All wallets'}</td>
    <td>${badge(l.is_active ? 'live' : 'off')}</td>
  </tr>`).join('');
  document.getElementById('links').innerHTML = `
    <div class="card">
      <h3>New payment link</h3>
      <div class="field"><label for="linkName">Display name</label><input id="linkName" placeholder="The name payers see"></div>
      <div class="field"><label for="linkCost">Link cost %</label><input id="linkCost" type="number" min="0" step="0.1" value="${Number(me.cost_percent || 0)}" ${me.cost_locked ? "disabled" : ""}></div>
      <p class="hint">${me.cost_locked ? "Your reseller set this rate for your account." : "Added on top of what the payer pays. This is separate from the platform fee."}</p>
      ${layoutPicker(exp.theme, exp.wallet, exp.invoice)}
      <button class="btn primary" id="makeLink">Create link</button>
    </div>
    <div class="card flush">
      <table class="table"><thead><tr><th>Link</th><th>Name</th><th>Design</th><th>Wallets</th><th>Status</th></tr></thead>
      <tbody>${list || '<tr><td colspan="5" class="empty">No links yet</td></tr>'}</tbody></table>
    </div>`;
  bindExperience(exp);
  document.getElementById('makeLink').onclick = makeLink;
}

async function makeLink() {
  const name = document.getElementById('linkName').value.trim();
  if (!name) return toast('Enter a name');
  const { data, error } = await sb.rpc('create_link_variants', { p_display_name: name, p_styles: ['kebab'] });
  if (error) return toast(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  if (row?.slug) {
    const { data: link } = await sb.from('payment_links').select('id').eq('slug', row.slug).maybeSingle();
    if (link?.id) {
      await sb.rpc('set_payment_link_experience', {
        p_link_id: link.id, p_theme: exp.theme, p_wallet_mode: exp.wallet, p_invoice_theme: exp.invoice,
      });
    }
    const cost = Number(document.getElementById('linkCost').value);
    if (Number.isFinite(cost)) await sb.rpc('set_my_cost_percent', { p_percent: cost }).catch(() => {});
  }
  toast('Link ready', true);
  await renderLinks();
}

async function renderPays() {
  const { data, error } = await sb.rpc('get_my_payments', { p_limit: 50, p_offset: 0 });
  if (error) { document.getElementById('pay').innerHTML = `<p class="err">${escapeHtml(error.message)}</p>`; return; }
  const rows = (data || []).map((p) => `<tr><td class="num">${money(p.amount_settled || p.amount_requested)}</td><td>${badge(p.status)}</td><td>/${escapeHtml(p.link_slug || '')}</td><td>${escapeHtml(when(p.settled_at || p.created_at))}</td></tr>`).join('');
  document.getElementById('pay').innerHTML = `<div class="card flush"><table class="table"><thead><tr><th class="num">Amount</th><th>Status</th><th>Link</th><th>When</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="empty">No payments yet</td></tr>'}</tbody></table></div>`;
}

async function renderCash() {
  const [{ data: bal }, { data: ws }] = await Promise.all([sb.rpc('get_my_balance'), sb.rpc('my_withdraw_settings')]);
  const b = Array.isArray(bal) ? bal[0] : bal || {};
  // Fee: own override, else the reseller's team fee, else the global
  // default, resolved by the server. When the reseller handles withdrawals
  // the form stays visible with the balance, but nothing can be sent.
  const fee = Number(ws?.fee_percent ?? 0);
  const blocked = ws && ws.self_withdraw_allowed === false
    ? 'Your reseller handles withdrawals for your account. Ask them to withdraw for you.'
    : null;
  document.getElementById('cash').innerHTML = withdrawForm(`<p class="muted">Available balance <strong id="wAvail">${money(b.available)}</strong></p>`
    + (blocked ? `<div class="notice" id="wBlocked"><strong>Withdrawals are handled by your reseller</strong><div class="muted">${escapeHtml(blocked)}</div></div>` : ''));
  bindWithdraw(() => fee, {
    blocked,
    submitManual: async () => {
      const { data, error } = await sb.rpc('request_withdrawal', {
        p_amount: Number(document.getElementById('wAmt').value),
        p_method: document.getElementById('wMethod').value,
        p_destination: document.getElementById('wDest').value.trim(),
      });
      if (error) { toast(error.message); return false; }
      const row = Array.isArray(data) ? data[0] : data;
      toast(row?.amount_after_fee != null ? `Withdrawal requested. You receive ${money(row.amount_after_fee)} after an admin approves it.` : 'Withdrawal requested', true);
      return true;
    },
    onDone: async () => {
      renderHome();
      const { data: now } = await sb.rpc('get_my_balance');
      const nb = Array.isArray(now) ? now[0] : now || {};
      document.getElementById('wAvail').textContent = money(nb.available);
    },
  });
}

async function renderTeam() {
  const { data: notices } = await sb.from('reseller_notices').select('*').order('created_at', { ascending: false }).limit(20);
  const noteHtml = (notices || []).map((n) => `<div class="notice"><strong>${escapeHtml(n.title)}</strong><div class="muted">${escapeHtml(n.body)}</div></div>`).join('') || '<p class="muted">No notices yet.</p>';
  document.getElementById('team').innerHTML = `<div class="card">
    <h3>Reseller</h3>
    <p class="muted">${resellerId ? 'Your account is on a reseller team.' : 'You are not on a reseller team. Sign up through a reseller link to join one.'}</p>
  </div>
  <div class="card"><h3>Notices</h3>${noteHtml}</div>`;
}

async function renderChat() {
  let thread = '';
  if (resellerId) {
    const { data: msgs } = await sb.from('team_messages').select('*').eq('freelancer_id', me.id).order('created_at', { ascending: true }).limit(80);
    thread = (msgs || []).map((m) => `<div class="msg"><span class="faint">${m.sender_id === me.id ? 'You' : 'Reseller'}</span>${escapeHtml(m.body)}</div>`).join('');
  }
  const { data: adminMsgs } = await sb.from('support_messages').select('*').eq('user_id', me.id).order('created_at', { ascending: true }).limit(80);
  const adminThread = (adminMsgs || []).map((m) => `<div class="msg"><span class="faint">${m.sender === 'admin' ? 'Admin' : 'You'}</span>${escapeHtml(m.message)}</div>`).join('');
  document.getElementById('chat').innerHTML = `<div class="grid split">
    <div class="card"><h3>Reseller</h3><div class="thread">${thread || '<p class="muted">No messages with your reseller.</p>'}</div>
      ${resellerId ? '<div class="compose"><input class="input" id="teamMsg" placeholder="Write a message" aria-label="Message to your reseller"><button class="btn primary" id="sendTeam">Send</button></div>' : ''}</div>
    <div class="card"><h3>Admin</h3><div class="thread">${adminThread || '<p class="muted">No messages with the admin.</p>'}</div>
      <div class="compose"><input class="input" id="adminMsg" placeholder="Write a message" aria-label="Message to the admin"><button class="btn primary" id="sendAdmin">Send</button></div></div>
  </div>`;
  const st = document.getElementById('sendTeam');
  if (st) st.onclick = async () => {
    const { error } = await sb.rpc('send_team_message', { p_other_id: resellerId, p_body: document.getElementById('teamMsg').value.trim() });
    if (error) return toast(error.message);
    renderChat();
  };
  document.getElementById('sendAdmin').onclick = async () => {
    const { error } = await sb.from('support_messages').insert({ user_id: me.id, sender: 'creator', message: document.getElementById('adminMsg').value.trim() });
    if (error) return toast(error.message);
    renderChat();
  };
}

async function renderProfile() {
  document.getElementById('profile').innerHTML = `<div class="card narrow">
    <h3>Public profile</h3>
    <div class="field"><label for="pName">Display name</label><input id="pName" value="${escapeHtml(me.display_name || '')}"></div>
    <div class="field"><label for="pBio">Bio</label><textarea id="pBio">${escapeHtml(me.bio || '')}</textarea></div>
    <div class="field"><label for="pSlug">Store address</label><input id="pSlug" value="${escapeHtml(me.public_slug || '')}"></div>
    <div class="row"><button class="btn primary" id="saveProf">Save profile</button><a class="btn ghost" href="store.html">Open public store</a></div>
  </div>`;
  document.getElementById('saveProf').onclick = async () => {
    const { error } = await sb.rpc('update_my_public_profile', {
      p_display_name: document.getElementById('pName').value,
      p_bio: document.getElementById('pBio').value,
      p_public_slug: document.getElementById('pSlug').value,
    });
    if (error) return toast(error.message);
    toast('Saved', true);
  };
}

boot();

const logoutBtn = document.getElementById("logoutBtn");
if (logoutBtn) logoutBtn.onclick = signOut;
