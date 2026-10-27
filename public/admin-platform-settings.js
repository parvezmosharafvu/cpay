// Admin → Settings (docs/INSTANT-FORWARD.md, docs/NON-CUSTODIAL-PLAN.md).
// Top: Payment mode, platform fee %, legal pages, wallet link. Everything
// else renders into the collapsed Advanced section (#platformSettingsAdvanced).
// Reads admin_platform_settings(), writes admin_set_platform_setting()
// (active admin at aal2, audited) and shows the settings audit trail.
// Everything is inside this function: no globals (see the duplicate-global
// check in tests/frontend).
(function () {
  'use strict';
  const client = window.supabaseClient;
  const host = () => document.getElementById('platformSettings');
  const tr = (s) => (window.cpayI18n && typeof window.cpayI18n.t === 'function' ? window.cpayI18n.t(s) : s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MAIN = [
    // The on/off switches (legal_published, wallet_link_enabled) are in
    // Features (admin-owner-settings.js).
    // BTCPay Server checkout (docs/BTCPAY.md): off until the owner turns it on.
    ['BTCPay Server', ['btcpay_enabled', 'btcpay_lightning_only']],
    // Blink sweep (docs/BLINK-SWEEP.md): Blink USD balance → primary CPAY wallet;
    // receive switch: BTCPay is pointed at the Blink account with most limit left.
    ['Blink sweep', ['blink_sweep_enabled', 'blink_sweep_keep_usd', 'blink_sweep_min_usd', 'blink_sweep_max_usd',
      'blink_receive_switch_enabled', 'blink_receive_switch_below_usd']],
    ['Legal pages', ['legal_entity_name', 'legal_address', 'legal_effective_date', 'legal_jurisdiction', 'legal_courts', 'legal_privacy_email', 'legal_support_email']],
  ];
  const ADVANCED = [
    ['Instant forward', ['instant_forward_no_address', 'instant_forward_min_sat', 'instant_forward_max_usd', 'instant_forward_max_fee_pct', 'instant_forward_max_attempts']],
    ['Old switches (Payment mode covers these)', ['custodial_receive_enabled', 'custodial_new_links_enabled', 'custodial_withdraw_enabled', 'fee_billing_enabled']],
    ['Direct payments', ['direct_pilot_user_ids', 'direct_provider_hosts']],
    ['Subscription fees', ['fee_pilot_no_fee', 'fee_subscription_price_usd', 'fee_free_tier_usd', 'fee_grace_days']],
    ['Admin wallet limits', ['admin_send_daily_cap_usd', 'admin_send_allowed_destinations']],
  ];
  const MODES = [
    ['balance', 'Auto withdraw off (balance)', 'Payments go to the CPAY wallet. CPAY keeps the fee and the rest is added to the user’s balance. Users withdraw by hand.'],
    ['instant_forward', 'Auto withdraw on (instant forward)', 'Payments go to the CPAY wallet. CPAY keeps the fee and sends the rest straight to the user’s own Lightning or USDT address.'],
    ['direct', 'Direct (no fee)', 'Payers pay the user’s own wallet directly. CPAY never receives the money and takes no fee.'],
  ];
  const CHOICES = {
    payment_mode: MODES.map(([v, t]) => [v, t]),
    instant_forward_no_address: [['balance', 'Keep in CPAY balance until they add one'], ['refuse', 'Refuse new payments']],
  };
  const LIST_KINDS = ['hosts', 'strings', 'uuids'];
  const NUM_KINDS = ['money', 'days', 'sats', 'percent', 'attempts'];

  const drafts = new Map();
  let saving = false;
  async function commit(write, statusEl) {
    if (saving) return false;
    saving = true;
    const controls = [...document.querySelectorAll('#platformSettings button, #platformSettingsAdvanced button')];
    const disabled = controls.map(b => b.disabled);
    controls.forEach(b => { b.disabled = true; });
    statusEl.textContent = 'Saving…'; statusEl.className = 'faint';
    try {
      const { error } = await write();
      if (error) throw error;
      statusEl.textContent = 'Saved'; statusEl.className = 'ok'; return true;
    } catch (error) {
      statusEl.textContent = error.message || 'Save could not be confirmed. Refresh before trying again.'; statusEl.className = 'err'; return false;
    } finally { saving = false; controls.forEach((b,i) => { b.disabled = disabled[i]; }); }
  }
  function show(row) {
    const v = row.value;
    if (row.kind === 'boolean') return v === true ? 'On' : 'Off';
    if (CHOICES[row.key]) return (CHOICES[row.key].find(([c]) => c === v) || [v, String(v)])[1];
    if (LIST_KINDS.includes(row.kind)) return Array.isArray(v) && v.length ? v.join(', ') : '(none)';
    if (v === null) return '(not set)';
    if (typeof v === 'string') return v === '' ? '(empty)' : v;
    return String(v);
  }
  function editor(row) {
    const id = 'ps_' + row.key;
    if (row.kind === 'boolean') {
      const on = row.value === true;
      return `<button class="btn ${on ? 'primary' : 'ghost'} sm" data-ps-key="${row.key}" data-ps-bool="true" ${on ? 'disabled' : ''}>On</button>
        <button class="btn ${on ? 'ghost' : 'primary'} sm" data-ps-key="${row.key}" data-ps-bool="false" ${on ? '' : 'disabled'}>Off</button>`;
    }
    if (CHOICES[row.key]) {
      return CHOICES[row.key].map(([c, t]) => `<button class="btn ${row.value === c ? 'primary' : 'ghost'} sm" data-ps-key="${row.key}" data-ps-choice="${c}" ${row.value === c ? 'disabled' : ''}>${esc(t)}</button>`).join(' ');
    }
    let cur = row.value;
    if (LIST_KINDS.includes(row.kind)) cur = (cur || []).join('\n');
    else if (cur === null) cur = '';
    if (drafts.has(row.key)) cur = drafts.get(row.key);
    const field = LIST_KINDS.includes(row.kind)
      ? `<textarea class="input" id="${id}" rows="2" aria-label="${esc(row.label)}" placeholder="One per line">${esc(cur)}</textarea>`
      : `<input class="input" id="${id}" aria-label="${esc(row.label)}" value="${esc(cur)}" ${row.kind === 'date_or_empty' ? 'placeholder="YYYY-MM-DD"' : ''}>`;
    return `${field}<button class="btn ghost sm" data-ps-key="${row.key}" data-ps-save="${id}">Save</button>`;
  }
  function parse(row, raw) {
    const t = String(raw ?? '').trim();
    if (LIST_KINDS.includes(row.kind)) return t ? t.split(/[\s,]+/).filter(Boolean).map((x) => (row.kind === 'strings' ? x : x.toLowerCase())) : [];
    if (NUM_KINDS.includes(row.kind)) { if (!/^\d+(\.\d{1,2})?$/.test(t)) throw new Error('Enter a number'); return Number(t); }
    if (row.kind === 'money_or_null') { if (t === '') return null; if (!/^\d+(\.\d{1,2})?$/.test(t)) throw new Error('Enter a number, or leave empty for no cap'); return Number(t); }
    return t;
  }
  function confirmText(row, value) {
    return `${row.label}\n\nChange to: ${Array.isArray(value) ? (value.join(', ') || '(none)') : value === null ? '(not set)' : String(value)}\n\n`
      + 'This changes how CPAY handles payments, money or public pages for everyone. The change is recorded in the audit log. Continue?';
  }

  async function save(row, value, statusEl, shown) {
    if (row.dangerous && !window.confirm(confirmText(row, shown ?? (CHOICES[row.key] ? show({ ...row, value }) : value)))) return;
    const before = drafts.get(row.key);
    if (await commit(() => client.rpc('admin_set_platform_setting', { p_key: row.key, p_value: value }), statusEl)) {
      if (drafts.get(row.key) === before) drafts.delete(row.key);
      render();
    }
  }

  // Blink sweep (admin_blink_sweeps): where the next move goes, each Blink
  // account as the last run saw it, the last moves, which account BTCPay pays into, the
  // last BTCPay switches and payments CPAY recorded after a switch.
  // Read-only; keys, invoices and Blink wallet ids never reach the page.
  const SWEEP_STATUS = { sending: 'Sending', pending: 'Pending', sent: 'Sent', failed: 'Failed', unknown: 'Check in Blink' };
  const ACCOUNT_RESULT = {
    off: 'Sweep is off', no_write: 'Key cannot send: needs Write', daily_limit: 'Blink daily limit reached',
    below_minimum: 'Below the smallest move', no_destination: 'No CPAY address', sent: 'Moved', failed: 'Move failed',
    pending: 'Move pending', sending: 'Sending',
  };
  const RECEIVE_RESULT = {
    ok: 'Enough limit left', low_limit: 'Limit low: the switch is off', no_target: 'Limit low: no other account has enough limit left',
    busy: 'Switched less than 30 minutes ago', switched: 'Switched', switch_failed: 'Switch failed', check_btcpay: 'Check BTCPay Lightning settings',
    unknown_account: 'BTCPay pays into a Blink account CPAY has no key for', not_read: 'Not read this run',
  };
  const SWITCH_STATUS = { switching: 'Switching', done: 'Switched', failed: 'Failed', unknown: 'Check BTCPay Lightning settings' };
  const cents = (v) => (v === null || v === undefined ? '—' : `$${(Number(v) / 100).toFixed(2)}`);
  const keyName = (a) => (a === '1' ? 'BLINK_API_KEY' : `BLINK_API_KEY_${a}`);
  async function renderBlinkLog() {
    const el = document.getElementById('blinkSweepLog');
    if (!el) return;
    const { data, error } = await adminPanelRead(() => client.rpc('admin_blink_sweeps', { p_limit: 20 }));
    if (error) { adminPanelError(el, error.message, renderBlinkLog); return; }
    const dest = data?.destination;
    const accounts = (data?.accounts || []).map((a) => {
      const res = String(a.result || '');
      const shown = ACCOUNT_RESULT[res] || (res.startsWith('error: ') ? res.slice(7) : res);
      const bad = a.can_send === false || res === 'daily_limit' || res === 'failed' || res.startsWith('error');
      return `<tr><td class="mono">${esc(keyName(a.account))}</td><td>${esc(cents(a.balance_cents))}</td><td>${a.can_send === true ? esc(tr('Yes')) : a.can_send === false ? `<span class="err">${esc(tr('No'))}</span>` : '—'}</td><td>${esc(a.withdraw_remaining_cents === null || a.withdraw_remaining_cents === undefined ? tr('No limit reported') : cents(a.withdraw_remaining_cents))}</td><td>${esc(cents(a.sent_24h_cents))}</td><td>${bad ? `<span class="err">${esc(tr(shown))}</span>` : esc(tr(shown))}<div class="faint">${esc(new Date(a.checked_at).toLocaleString())}</div></td></tr>`;
    }).join('');
    const rows = (data?.rows || []).map((r) => `<tr><td>${esc(new Date(r.created_at).toLocaleString())}</td><td class="mono">#${esc(r.account || '1')}</td><td>$${esc((Number(r.amount_cents) / 100).toFixed(2))}</td><td>${esc(Number(r.amount_sat).toLocaleString('en-US'))} sats</td><td><span class="badge ${r.status === 'sent' ? 'settled' : r.status === 'failed' || r.status === 'unknown' ? 'expired' : 'pending'}">${esc(tr(SWEEP_STATUS[r.status] || r.status))}</span></td><td class="mono">${esc(r.destination)}</td><td>${esc(r.error || '')}</td></tr>`).join('');
    const rcv = data?.receiving;
    const rres = String(rcv?.result || '');
    const rshown = RECEIVE_RESULT[rres] || (rres.startsWith('error: ') ? rres.slice(7) : rres);
    const receiving = rcv
      ? `<p>${esc(tr('BTCPay pays into'))}: <strong class="mono">${rcv.account ? esc(keyName(rcv.account)) : '—'}</strong> · ${['ok', 'switched'].includes(rres) ? esc(tr(rshown)) : `<span class="err">${esc(tr(rshown))}</span>`} <span class="faint">${esc(new Date(rcv.checked_at).toLocaleString())}</span></p>${rcv.key_kind === 'api' ? `<p class="err">${esc(tr('BTCPay holds a Blink key that can spend. Add a Read + Receive key as BLINK_RECEIVE_KEY (or _2 …) for that account.'))}</p>` : ''}`
      : `<p class="faint">${esc(tr('Not read yet. The BTCPay API key (BTCPAY_API_KEY) needs Modify store settings on the cpay store to see and switch which Blink account BTCPay pays into.'))}</p>`;
    const switches = (data?.switches || []).map((x) => `<tr><td>${esc(new Date(x.created_at).toLocaleString())}</td><td class="mono">${x.from_account ? `#${esc(x.from_account)}` : '—'} → #${esc(x.to_account)}</td><td><span class="badge ${x.status === 'done' ? 'settled' : x.status === 'switching' ? 'pending' : 'expired'}">${esc(tr(SWITCH_STATUS[x.status] || x.status))}</span></td><td>${esc(x.error || '')}</td></tr>`).join('');
    const rescues = (data?.rescues || []).map((x) => `<tr><td>${esc(new Date(x.created_at).toLocaleString())}</td><td class="mono">#${esc(x.account)}</td><td>$${esc(Number(x.amount_usd).toFixed(2))}</td><td class="mono">${esc(String(x.payment_id).slice(0, 8))}</td></tr>`).join('');
    el.innerHTML = `<div class="card"><p>${dest ? `Moves go to <strong class="mono">${esc(dest)}</strong>, the primary CPAY wallet’s Lightning address.` : '<span class="err">The primary CPAY wallet has no Lightning address, so nothing is moved.</span>'}</p>
        <p class="faint">Add one Blink API key (Read and Write) per Blink account in Secrets &amp; keys: BLINK_API_KEY, then BLINK_API_KEY_2 up to BLINK_API_KEY_10. Each account is moved separately, up to its own Blink daily withdrawal limit. Runs every 10 minutes.</p>
</div>
      <h4>Blink accounts</h4>
      <div class="card flush"><table class="table rtable"><thead><tr><th>Key</th><th>USD balance</th><th>Can send</th><th>Blink limit left (24 h)</th><th>Moved (24 h)</th><th>Last check</th></tr></thead><tbody>${accounts || '<tr><td colspan="6" class="empty">No Blink key seen yet. Add BLINK_API_KEY and wait up to 10 minutes.</td></tr>'}</tbody></table></div>
      <h4>Moves</h4>
      <div class="card flush"><table class="table rtable"><thead><tr><th>When</th><th>Account</th><th>USD</th><th>Sats</th><th>Status</th><th>To</th><th>Note</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="empty">No moves yet</td></tr>'}</tbody></table></div>
      <h4>${esc(tr('BTCPay receiving account'))}</h4>
      <div class="card">${receiving}
        <p class="faint">${esc(tr('With the switch on, when the Blink account BTCPay pays into has less withdrawal limit left than the amount set above, CPAY points BTCPay at the Blink account with the most limit left (at most once every 30 minutes). Invoices still open on the old account are checked by CPAY for two days, so none are missed.'))}</p></div>
      <div class="card flush"><table class="table rtable"><thead><tr><th>When</th><th>${esc(tr('Blink accounts'))}</th><th>Status</th><th>Note</th></tr></thead><tbody>${switches || `<tr><td colspan="4" class="empty">${esc(tr('No BTCPay switches yet'))}</td></tr>`}</tbody></table></div>
      <h4>${esc(tr('Payments recorded after a switch'))}</h4>
      <div class="card flush"><table class="table rtable"><thead><tr><th>When</th><th>${esc(tr('Blink accounts'))}</th><th>USD</th><th>Payment</th></tr></thead><tbody>${rescues || `<tr><td colspan="4" class="empty">${esc(tr('None yet'))}</td></tr>`}</tbody></table></div>`;
  }

  async function renderAudit() {
    const el = document.getElementById('platformSettingsAudit');
    if (!el) return;
    const { data, error } = await adminPanelRead(() => client.rpc('admin_audit_log', { p_limit: 30, p_offset: 0, p_action: 'settings.platform' }));
    if (error) { adminPanelError(el, error.message, render); return; }
    const rows = (data || []).map((a) => `<tr><td>${esc(new Date(a.occurred_at).toLocaleString())}</td><td>${esc(a.actor_email)}</td><td class="mono">${esc(a.subject_id)}</td><td class="mono">${esc(JSON.stringify(a.old_value?.value ?? null))}</td><td class="mono">${esc(JSON.stringify(a.new_value?.value ?? null))}</td></tr>`).join('');
    el.innerHTML = `<h3>Settings changes</h3><div class="card flush"><table class="table rtable"><thead><tr><th>When</th><th>Who</th><th>Setting</th><th>From</th><th>To</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="empty">No changes yet</td></tr>'}</tbody></table></div>`;
  }

  function rowHtml(r) {
    return `<tr><td>${r.dangerous ? '⚠ ' : ''}${esc(r.label)}<div class="faint">Now: ${esc(show(r))}${r.updated_at ? ` · changed ${esc(new Date(r.updated_at).toLocaleString())} by ${esc(r.updated_by_email || '?')}` : ' · default'}</div><div class="faint" data-ps-status="${r.key}" role="status"></div></td>
      <td class="setting-controls"><div class="setting-editor">${editor(r)}</div></td></tr>`;
  }
  // `after`: extra markup placed right after a group, by its title.
  function groupsHtml(groups, byKey, after = {}) {
    return groups.map(([title, keys]) => `<h3>${esc(title)}</h3><div class="card flush"><table class="table"><tbody>${keys.filter((k) => byKey[k]).map((k) => rowHtml(byKey[k])).join('')}</tbody></table></div>${after[title] || ''}`).join('');
  }
  // Auto withdraw (20261021010000): the plain switch for payment_mode.
  // On = instant forward to the user's saved address; Off = the amount is
  // added to the user's balance and they withdraw by hand. Each profile can
  // override it in Manage users. Writes admin_set_auto_withdraw_global().
  function modeHtml(row) {
    if (!row) return '';
    const on = row.value === 'instant_forward';
    const direct = row.value === 'direct';
    return `<h3>Auto withdraw</h3>
      <div class="card" id="autoWithdrawCard">
        <p>Auto withdraw is <strong id="awState">${direct ? 'Direct payments' : (on ? 'On' : 'Off')}</strong> for everyone who has no setting of their own.</p>
        <p class="muted">On: after the platform fee, each payment is sent by itself to the user’s saved Lightning or USDT address.</p>
        <p class="muted">Off: the amount is added to the user’s balance. The user withdraws by hand from Withdraw.</p>
        <div class="row" role="group" aria-label="Auto withdraw">
          <button type="button" class="btn ${on ? 'primary' : 'ghost'}" id="awOn" ${on ? 'disabled' : ''}>Turn on</button>
          <button type="button" class="btn ${!on && !direct ? 'primary' : 'ghost'}" id="awOff" ${!on && !direct ? 'disabled' : ''}>Turn off</button>
        </div>
        <p class="faint">To set one user differently, open Manage users and use Auto withdraw on that row.</p>
        <div class="faint" id="awStatus" role="status"></div></div>`;
  }
  function wireMode(el) {
    const go = async (on) => {
      const st = el.querySelector('#awStatus');
      const msg = on
        ? 'Turn auto withdraw on for everyone without their own setting? New payments will be sent to their saved address.'
        : 'Turn auto withdraw off for everyone without their own setting? New payments will be added to their balance, and waiting sends go back to their balance.';
      if (!window.confirm(msg)) return;
      if (await commit(() => client.rpc('admin_set_auto_withdraw_global', { p_on: on }), st)) render();
    };
    const on = el.querySelector('#awOn'); const off = el.querySelector('#awOff');
    if (on) on.onclick = () => go(true);
    if (off) off.onclick = () => go(false);
  }
  async function feeHtml() {
    const { data, error } = await adminPanelRead(() => client.from('app_settings').select('value').eq('key', 'default_platform_fee_percent').maybeSingle());
    if (error || !data) return '<div class="card"><p class="err" role="alert">Platform fee unavailable. Refresh settings to try again.</p></div>';
    const v = data?.value;
    const pct = Number((v && typeof v === 'object' ? v.percent : v) ?? 0);
    return `<h3>Platform fee</h3>
      <div class="card"><p class="muted">CPAY’s fee on each payment, in Balance and Instant forward modes. An account’s own fee (Manage users) wins over this.</p>
        <div class="field short"><label for="psFee">Fee %</label><input id="psFee" type="number" min="0" max="90" step="0.1" value="${esc(drafts.has('platform-fee') ? drafts.get('platform-fee') : pct)}"></div>
        <button class="btn primary sm" id="psFeeSave">Save fee</button>
        <div class="faint" id="psFeeStatus" role="status"></div></div>`;
  }

  function wire(el, byKey) {
    for (const key of Object.keys(byKey)) {
      const input = document.getElementById('ps_' + key);
      if (input) input.oninput = () => drafts.set(key, input.value);
    }
    el.querySelectorAll('[data-ps-key]').forEach((b) => {
      b.onclick = () => {
        const row = byKey[b.dataset.psKey];
        const statusEl = el.querySelector(`[data-ps-status="${row.key}"]`);
        try {
          const value = b.dataset.psChoice ? b.dataset.psChoice
            : b.dataset.psBool ? b.dataset.psBool === 'true' : parse(row, document.getElementById(b.dataset.psSave).value);
          save(row, value, statusEl);
        } catch (e) { statusEl.textContent = e.message; statusEl.className = 'err'; }
      };
    });
  }

  let seq = 0;
  async function render() {
    const el = host();
    if (!el || !client || saving) return;
    const mine = ++seq;
    const { data, error } = await adminPanelRead(() => client.rpc('admin_platform_settings'));
    const fee = error ? '' : await feeHtml();
    if (mine !== seq) return;  // a newer render is under way
    if (error) { adminPanelError(el, error.message, render); return; }
    const byKey = Object.fromEntries((data || []).map((r) => [r.key, r]));
    el.innerHTML = `<div class="card-head"><h2>Settings</h2><button id="psRefresh" type="button" class="btn ghost">Refresh settings</button></div><p class="faint">Edits stay in this page until saved. Each Save changes only its own setting.</p>
      <p class="muted">Changes need two-step sign-in and are recorded below. Settings marked ⚠ ask for confirmation.</p>
      ${modeHtml(byKey.payment_mode)}
      ${fee}
      ${groupsHtml(MAIN, byKey, { 'Blink sweep': byKey.blink_sweep_enabled ? '<div id="blinkSweepLog"></div>' : '' })}
      <div id="platformSettingsAudit"></div>`;
    wire(el, byKey);
    wireMode(el);
    document.getElementById('psRefresh').onclick = render;
    const feeInput = document.getElementById('psFee');
    if (feeInput) feeInput.oninput = () => drafts.set('platform-fee', feeInput.value);
    const feeSave = document.getElementById('psFeeSave');
    if (feeSave) feeSave.onclick = async () => {
      const st = document.getElementById('psFeeStatus');
      const raw = String(document.getElementById('psFee').value ?? '').trim();
      const n = Number(raw);
      if (!/^\d+(\.\d{1,3})?$/.test(raw) || n > 90) { st.textContent = 'Enter a number from 0 to 90'; st.className = 'err'; return; }
      if (!window.confirm(`Set the platform fee to ${n}% for every account without its own fee? This is recorded in the audit log.`)) return;
      if (await commit(() => client.rpc('admin_set_default_platform_fee', { p_percent: n }), st) && drafts.get('platform-fee') === raw) drafts.delete('platform-fee');
    };
    const adv = document.getElementById('platformSettingsAdvanced');
    if (adv) { adv.innerHTML = groupsHtml(ADVANCED, byKey); wire(adv, byKey); }
    renderBlinkLog();
    renderAudit();
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest && e.target.closest('.navi[data-tab="settings"]');
    if (t) setTimeout(render, 0);
  });
  if (location.hash === '#settings') setTimeout(render, 0);
  window.addEventListener('cpay:admin-ready', render);
})();
