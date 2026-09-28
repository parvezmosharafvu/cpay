const sb = window.supabaseClient;
const exp = { theme: 'keypad', invoice: 'default', wallet: 'all_wallets' };
let me = null;
let ws = null; // my_withdraw_settings(): own fee, team switch and team fee

function show(tab) {
  document.querySelectorAll('main > section').forEach((s) => { s.hidden = s.id !== tab; });
  document.querySelectorAll('.navi[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
}
document.querySelectorAll('.navi[data-tab]').forEach((b) => { b.onclick = () => show(b.dataset.tab); });

async function boot() {
  me = await loadProfile();
  if (!me) return;
  if (me.role === 'admin') { location.href = 'admin.html'; return; }
  if (me.role !== 'moderator') { location.href = 'dashboard.html'; return; }
  document.getElementById('hello').textContent = me.display_name || 'Reseller';
  ws = (await sb.rpc('my_withdraw_settings')).data || null;
  await Promise.all([renderHome(), renderTeam(), renderLinks(), renderCash(), renderNotice(), renderChat(), renderProfile()]);
}

async function renderHome() {
  const [{ data: totals }, { data: bal }, { data: split }, { data: comm }] = await Promise.all([
    sb.rpc('my_team_totals'),
    sb.rpc('get_my_balance'),
    sb.rpc('my_earnings_split'),
    sb.rpc('my_commission_totals'),
  ]);
  const t = Array.isArray(totals) ? totals[0] : totals || {};
  const b = Array.isArray(bal) ? bal[0] : bal || {};
  const s = Array.isArray(split) ? split[0] : split || {};
  const c = Array.isArray(comm) ? comm[0] : comm || {};
  const origin = location.origin;
  const aff = me.affiliate_code || '';
  const kpis = `<div class="grid kpis">
    <div class="card"><div class="kicker">Available</div><div class="kpi">${money(s.net ?? b.available)}</div><div class="faint">Your links plus commission</div></div>
    <div class="card"><div class="kicker">Commission earned</div><div class="kpi">${money(c.commission_earned ?? s.reseller_commission_in)}</div><div class="faint">All time, ${Daily.pct(s.commission_percent || 0)} of team net after the platform fee</div></div>
    <div class="card"><div class="kicker">Team accounts</div><div class="kpi">${Number(t.member_count || 0)}</div><div class="faint">Team available ${money(t.team_available)}</div></div>
  </div>
  <div class="card">
    <h3>Your sign-up link</h3>
    <p class="muted">Freelancers who sign up with this link join your team and pay you commission. Accounts an admin assigns to you do not.</p>
    <code>${escapeHtml(origin + '/register.html?role=freelancer&ref=' + aff)}</code>
    <p class="faint" style="margin:14px 0 0">Link cost is added to what the payer pays. The platform fee is CPAY's cut. Commission is your cut of the freelancer's net. The admin can change all three.</p>
  </div>`;
  document.getElementById('home').innerHTML = '<div class="stack" id="dailySelf"><p class="muted">Loading…</p></div>';
  await Daily.mountSelf(document.getElementById('dailySelf'), { between: kpis, commission: true });
}

async function renderTeam() {
  const [{ data, error }, { data: rowsComm }] = await Promise.all([
    sb.rpc('my_team_members'),
    sb.rpc('my_affiliate_commission_rows'),
  ]);
  if (error) { document.getElementById('team').innerHTML = `<p class="err">${escapeHtml(error.message)}</p>`; return; }
  const rows = (data || []).map((m) => `<tr>
    <td>${escapeHtml(m.display_name || m.email)}</td>
    <td>${escapeHtml(m.email)}</td>
    <td>${m.affiliate ? 'Sign-up link' : 'Assigned'}</td>
    <td class="num">${money(m.available)}</td>
    <td class="num">${m.affiliate ? `<button class="btn ghost sm" data-cash="${m.id}" data-name="${escapeHtml(m.display_name || m.email)}" data-avail="${Number(m.available ?? 0)}">Withdraw</button>
      <button class="btn ghost sm" data-cost="${m.id}">Lock cost</button>` : '<span class="faint">View only</span>'}</td>
  </tr>`).join('');

  const commRows = (rowsComm || []).map((r) => `<tr>
    <td>${escapeHtml(r.freelancer_name || '')}</td>
    <td>/${escapeHtml(r.link_slug || '')}</td>
    <td class="num">${money(r.settled)}</td>
    <td class="num">${money(r.platform_fee)}</td>
    <td class="num">${money(r.commission)}</td>
  </tr>`).join('');
  document.getElementById('team').innerHTML = `<div class="stack" id="teamDaily"><div class="card"><p class="muted">Loading team days…</p></div></div>
  ${selfWithdrawCard()}
  <div class="card">
    <h3>Team link cost</h3>
    <p class="muted">Link cost is added to what the payer pays. It is separate from the platform fee and your commission. Lock or unlock applies only to freelancers who signed up with your link. Unlock does not change the rate they already have.</p>
    <div class="field short"><label for="teamCost">Link cost %</label><input id="teamCost" type="number" min="0" step="0.1" value="${Number(me.team_cost_percent || me.cost_percent || 0)}"></div>
    <div class="row">
      <button class="btn primary" id="lockAll">Lock on sign-up freelancers</button>
      <button class="btn ghost" id="unlockAll">Unlock their rates</button>
    </div>
  </div>
  <div class="card flush">
    <h3>Team accounts</h3>
    <table class="table"><thead><tr><th>Name</th><th>Email</th><th>Joined by</th><th class="num">Available</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5" class="empty">No freelancers on your team yet. Share your sign-up link.</td></tr>'}</tbody></table>
  </div>
  <div class="card flush">
    <h3>Commission</h3>
    <table class="table"><thead><tr><th>Freelancer</th><th>Link</th><th class="num">Settled</th><th class="num">Platform fee</th><th class="num">Your cut</th></tr></thead>
    <tbody>${commRows || '<tr><td colspan="5" class="empty">No commission yet</td></tr>'}</tbody></table>
  </div>`;
  Daily.mountTeam(document.getElementById('teamDaily'));
  bindSelfWithdraw();
  document.querySelectorAll('[data-cash]').forEach((btn) => {
    btn.onclick = () => prepareWithdraw(btn.dataset.cash, btn.dataset.name, btn.dataset.avail);
  });
  document.querySelectorAll('[data-cost]').forEach((btn) => {
    btn.onclick = async () => {
      const pct = Number(document.getElementById('teamCost').value);
      const { error: e } = await sb.rpc('reseller_set_freelancer_cost', { p_freelancer_id: btn.dataset.cost, p_percent: pct, p_lock: true });
      if (e) return toast(e.message);
      toast('Cost locked on that freelancer', true);
    };
  });
  const lockAll = document.getElementById('lockAll');
  if (lockAll) lockAll.onclick = async () => {
    const pct = Number(document.getElementById('teamCost').value);
    const { data, error: e } = await sb.rpc('reseller_lock_team_cost', { p_percent: pct, p_lock: true });
    if (e) return toast(e.message);
    toast('Locked on ' + data + ' freelancer book(s)', true);
  };
  const unlockAll = document.getElementById('unlockAll');
  if (unlockAll) unlockAll.onclick = async () => {
    const pct = Number(document.getElementById('teamCost').value);
    const { error: e } = await sb.rpc('reseller_lock_team_cost', { p_percent: pct, p_lock: false });
    if (e) return toast(e.message);
    toast('Rates unlocked. Their cost percentages were left as they were.', true);
  };
}

// Whether freelancers on this team may withdraw from their own dashboard.
// Off by default. When off, the reseller withdraws for them from the Team
// accounts list (Withdraw), which the server allows either way.
function selfWithdrawCard() {
  const r = ws?.reseller || {};
  const on = !!r.allow_freelancer_self_withdraw;
  const teamFee = r.team_withdrawal_fee_percent;
  const feeText = teamFee != null
    ? `Team withdrawal fee: ${Number(teamFee)}%, set by the admin.`
    : `Team withdrawal fee: the platform default (${Number(ws?.global_fee_percent ?? 0)}%).`;
  const teamOff = ws && ws.team_withdraw_enabled === false;
  return `<div class="card" id="selfWithdrawCard">
    <h3>Freelancer withdrawals</h3>
    <label class="switch"><input type="checkbox" id="selfWithdraw" ${on ? 'checked' : ''}> <span>Let my freelancers withdraw by themselves</span></label>
    <p class="muted" id="selfWithdrawNote" style="margin:12px 0 0">${on
      ? 'On. Freelancers on your team can withdraw from their own dashboard.'
      : 'Off. Freelancers on your team see their balance but cannot withdraw. You withdraw for them from the list below.'}</p>
    <p class="faint" style="margin:8px 0 0">${escapeHtml(feeText)} An account's own fee, if the admin set one, comes first.</p>
    ${teamOff ? '<p class="err" style="margin:8px 0 0">Team withdrawals are turned off by the admin, so while this is off only the admin can withdraw for your freelancers.</p>' : ''}
  </div>`;
}

function bindSelfWithdraw() {
  const box = document.getElementById('selfWithdraw');
  if (!box) return;
  box.onchange = async () => {
    box.disabled = true;
    const { data, error } = await sb.rpc('reseller_set_self_withdraw', { p_allowed: box.checked });
    box.disabled = false;
    if (error) { box.checked = !box.checked; return toast(error.message); }
    ws = { ...(ws || {}), reseller: { ...(ws?.reseller || {}), allow_freelancer_self_withdraw: !!data } };
    document.getElementById('selfWithdrawCard').outerHTML = selfWithdrawCard();
    bindSelfWithdraw();
    toast(data ? 'Your freelancers can withdraw by themselves' : 'You now handle withdrawals for your freelancers', true);
  };
}

let pendingCash = null;

function prepareWithdraw(userId, name, available) {
  pendingCash = { userId, name, available };
  show('cash');
  applyPendingCash();
}

function applyPendingCash() {
  if (!pendingCash) return;
  const user = document.getElementById('wUser');
  const who = document.getElementById('wWho');
  if (!user || !who) return;
  user.value = pendingCash.userId;
  who.innerHTML = `Withdrawing for <strong>${escapeHtml(pendingCash.name)}</strong> · available ${money(pendingCash.available)}`;
  refreshWithdraw();
}

async function renderLinks() {
  const { data: links } = await sb.from('payment_links').select('*').eq('user_id', me.id).is('deleted_at', null).order('created_at', { ascending: false });
  const list = (links || []).map((l) => `<tr><td><a href="/${escapeHtml(l.slug)}" target="_blank">/${escapeHtml(l.slug)}</a></td><td>${escapeHtml(layoutLabel(l.theme))}</td><td>${l.wallet_mode === 'cashapp' ? 'Cash App only' : 'All wallets'}</td></tr>`).join('');
  document.getElementById('links').innerHTML = `<div class="card">
    <h3>New payment link</h3>
    <div class="field"><label for="linkName">Display name</label><input id="linkName" placeholder="The name payers see"></div>
    <div class="field"><label for="linkCost">Link cost %</label><input id="linkCost" type="number" min="0" step="0.1" value="${Number(me.cost_percent || 0)}"></div>
    ${layoutPicker(exp.theme, exp.wallet, exp.invoice)}
    <button class="btn primary" id="makeLink">Create link</button>
  </div>
  <div class="card flush"><table class="table"><thead><tr><th>Link</th><th>Design</th><th>Wallets</th></tr></thead><tbody>${list || '<tr><td colspan="3" class="empty">No links yet</td></tr>'}</tbody></table></div>`;
  bindExperience(exp);
  document.getElementById('makeLink').onclick = async () => {
    const name = document.getElementById('linkName').value.trim();
    if (!name) return toast('Enter a name');
    const { data, error } = await sb.rpc('create_link_variants', { p_display_name: name, p_styles: ['kebab'] });
    if (error) return toast(error.message);
    const row = Array.isArray(data) ? data[0] : data;
    if (row?.slug) {
      const { data: link } = await sb.from('payment_links').select('id').eq('slug', row.slug).maybeSingle();
      if (link?.id) {
        const { error: expErr } = await sb.rpc('set_payment_link_experience', { p_link_id: link.id, p_theme: exp.theme, p_wallet_mode: exp.wallet, p_invoice_theme: exp.invoice });
        if (expErr) return toast(expErr.message);
        const raw = document.getElementById('linkCost').value;
        if (raw !== '') {
          const cost = Number(raw);
          if (!Number.isFinite(cost)) return toast('Enter a valid link cost');
          const { error: costErr } = await sb.rpc('set_link_cost_percent', { p_link_id: link.id, p_percent: cost });
          if (costErr) return toast(costErr.message);
        }
      }
    }
    toast('Link ready', true);
    renderLinks();
  };
}

let refreshWithdraw = () => {};

async function renderCash() {
  document.getElementById('cash').innerHTML = withdrawForm(`<p class="muted" id="wWho">From your own balance. To withdraw for a teammate, use Withdraw on the Team accounts page.</p>
    <input type="hidden" id="wUser" value="${me.id}">`);
  const own = () => document.getElementById('wUser').value === me.id;
  // The reseller's own fee is resolved by the server (own override, else the
  // global default). A teammate's fee is applied by the server on submit.
  refreshWithdraw = bindWithdraw(() => (own() ? Number(ws?.fee_percent ?? 0) : NaN), {
    // Instant withdrawals pay out the signed-in account only; a teammate
    // sends their own from their dashboard.
    instantAllowed: own,
    teamPayout: () => document.getElementById('wUser')?.value !== me.id,
    submitManual: async () => {
      const { data, error } = await sb.rpc('reseller_request_withdrawal_for', {
        p_user_id: document.getElementById('wUser').value,
        p_amount: Number(document.getElementById('wAmt').value),
        p_method: document.getElementById('wMethod').value,
        p_destination: document.getElementById('wDest').value.trim(),
      });
      if (error) { toast(error.message); return false; }
      const row = Array.isArray(data) ? data[0] : data;
      toast(row?.amount_after_fee != null ? `Sent for admin review. Receives ${money(row.amount_after_fee)}.` : 'Sent for admin review', true);
      return true;
    },
    onDone: () => { renderHome(); renderTeam(); },
  });
  applyPendingCash();
}

async function renderNotice() {
  const { data: notices } = await sb.from('reseller_notices').select('*').eq('reseller_id', me.id).order('created_at', { ascending: false }).limit(20);
  const list = (notices || []).map((n) => `<div class="notice"><strong>${escapeHtml(n.title)}</strong><div class="muted">${escapeHtml(n.body)}</div></div>`).join('');
  document.getElementById('notice').innerHTML = `<div class="card narrow">
    <h3>New notice</h3>
    <div class="field"><label for="nTitle">Title</label><input id="nTitle"></div>
    <div class="field"><label for="nBody">Message</label><textarea id="nBody"></textarea></div>
    <button class="btn primary" id="nBtn">Send to my freelancers</button>
  </div>
  <div class="card narrow"><h3>Sent notices</h3>${list || '<p class="muted">No notices yet.</p>'}</div>`;
  document.getElementById('nBtn').onclick = async () => {
    const { error } = await sb.rpc('post_reseller_notice', {
      p_title: document.getElementById('nTitle').value,
      p_body: document.getElementById('nBody').value,
    });
    if (error) return toast(error.message);
    toast('Notice posted', true);
    renderNotice();
  };
}

async function renderChat() {
  const { data: members } = await sb.rpc('my_team_members');
  const options = (members || []).map((m) => `<option value="${m.id}">${escapeHtml(m.display_name || m.email)}</option>`).join('');
  document.getElementById('chat').innerHTML = `<div class="grid split">
    <div class="card">
      <h3>Team</h3>
      <div class="field"><label for="chatWho">Freelancer</label><select id="chatWho">${options}</select></div>
      <div class="thread" id="teamThread"></div>
      <div class="compose"><input class="input" id="teamMsg" placeholder="Write a message" aria-label="Message to freelancer"><button class="btn primary" id="sendTeam">Send</button></div>
    </div>
    <div class="card">
      <h3>Admin</h3>
      <div class="thread" id="adminThread"></div>
      <div class="compose"><input class="input" id="adminMsg" placeholder="Write a message" aria-label="Message to the admin"><button class="btn primary" id="sendAdmin">Send</button></div>
    </div>
  </div>`;
  async function loadTeamThread() {
    const other = document.getElementById('chatWho').value;
    if (!other) { document.getElementById('teamThread').innerHTML = '<p class="muted">No team yet.</p>'; return; }
    const { data: msgs } = await sb.from('team_messages').select('*').eq('reseller_id', me.id).eq('freelancer_id', other).order('created_at', { ascending: true }).limit(80);
    document.getElementById('teamThread').innerHTML = (msgs || []).map((m) => `<div class="msg"><span class="faint">${m.sender_id === me.id ? 'You' : 'Freelancer'}</span>${escapeHtml(m.body)}</div>`).join('') || '<p class="muted">No messages.</p>';
  }
  const { data: adminMsgs } = await sb.from('support_messages').select('*').eq('user_id', me.id).order('created_at', { ascending: true }).limit(80);
  document.getElementById('adminThread').innerHTML = (adminMsgs || []).map((m) => `<div class="msg"><span class="faint">${m.sender === 'admin' ? 'Admin' : 'You'}</span>${escapeHtml(m.message)}</div>`).join('') || '<p class="muted">No admin messages.</p>';
  document.getElementById('chatWho')?.addEventListener('change', loadTeamThread);
  await loadTeamThread();
  document.getElementById('sendTeam').onclick = async () => {
    const { error } = await sb.rpc('send_team_message', { p_other_id: document.getElementById('chatWho').value, p_body: document.getElementById('teamMsg').value.trim() });
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
  const { data: tg } = await sb.from('reseller_alert_channels').select('telegram_chat_id, enabled').eq('reseller_id', me.id).maybeSingle();
  document.getElementById('profile').innerHTML = `<div class="card narrow">
    <h3>Telegram group</h3>
    <p class="muted">Your group gets a message for every settled payment on your team's links, and a daily close at 5:00 PM Dhaka time with each link's payments, share, fee and net. Add the cpay bot to the group, then paste the group's chat ID here.</p>
    <div class="field"><label for="tgChat">Group chat ID</label><input id="tgChat" placeholder="-1001234567890" value="${escapeHtml(tg?.telegram_chat_id || '')}"></div>
    <div class="field"><label><input type="checkbox" id="tgOn" ${tg && !tg.enabled ? '' : 'checked'}> Send messages to this group</label></div>
    <button class="btn primary" id="saveTg">Save group</button>
  </div>
  <div class="card narrow">
    <h3>Public profile</h3>
    <div class="field"><label for="pName">Display name</label><input id="pName" value="${escapeHtml(me.display_name || '')}"></div>
    <div class="field"><label for="pBio">Bio</label><textarea id="pBio">${escapeHtml(me.bio || '')}</textarea></div>
    <div class="field"><label for="pSlug">Store address</label><input id="pSlug" value="${escapeHtml(me.public_slug || '')}"></div>
    <button class="btn primary" id="saveProf">Save profile</button>
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
  document.getElementById('saveTg').onclick = async () => {
    const { error } = await sb.rpc('set_reseller_telegram', {
      p_reseller_id: me.id,
      p_chat_id: document.getElementById('tgChat').value,
      p_enabled: document.getElementById('tgOn').checked,
    });
    if (error) return toast(error.message);
    toast('Telegram group saved', true);
  };
}

boot();

const logoutBtn = document.getElementById("logoutBtn");
if (logoutBtn) logoutBtn.onclick = signOut;
