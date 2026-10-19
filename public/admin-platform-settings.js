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
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MAIN = [
    ['Legal pages', ['legal_entity_name', 'legal_address', 'legal_effective_date', 'legal_jurisdiction', 'legal_courts', 'legal_privacy_email', 'legal_support_email', 'legal_published']],
    ['Wallet link', ['wallet_url', 'wallet_link_enabled']],
  ];
  const ADVANCED = [
    ['Instant forward', ['instant_forward_no_address', 'instant_forward_min_sat', 'instant_forward_max_usd', 'instant_forward_max_fee_pct', 'instant_forward_max_attempts']],
    ['Old switches (Payment mode covers these)', ['custodial_receive_enabled', 'custodial_new_links_enabled', 'custodial_withdraw_enabled', 'fee_billing_enabled']],
    ['Direct payments', ['direct_pilot_user_ids', 'direct_provider_hosts']],
    ['Subscription fees', ['fee_pilot_no_fee', 'fee_subscription_price_usd', 'fee_free_tier_usd', 'fee_grace_days']],
    ['Admin wallet limits', ['admin_send_daily_cap_usd', 'admin_send_allowed_destinations']],
  ];
  const MODES = [
    ['balance', 'Balance', 'Payments go to the CPAY wallet. CPAY keeps the fee and the rest is added to the user’s CPAY balance. Users withdraw. This is how CPAY works today.'],
    ['instant_forward', 'Instant forward', 'Payments go to the CPAY wallet. CPAY keeps the fee and sends the rest straight to the user’s own Lightning address. No balances are kept.'],
    ['direct', 'Direct (no fee)', 'Payers pay the user’s own wallet directly. CPAY never receives the money and takes no fee.'],
  ];
  const CHOICES = {
    payment_mode: MODES.map(([v, t]) => [v, t]),
    instant_forward_no_address: [['balance', 'Keep in CPAY balance until they add one'], ['refuse', 'Refuse new payments']],
  };
  const LIST_KINDS = ['hosts', 'strings', 'uuids'];
  const NUM_KINDS = ['money', 'days', 'sats', 'percent', 'attempts'];

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
    statusEl.textContent = 'Saving…';
    const { error } = await client.rpc('admin_set_platform_setting', { p_key: row.key, p_value: value });
    if (error) { statusEl.textContent = error.message; statusEl.className = 'err'; return; }
    statusEl.textContent = 'Saved'; statusEl.className = 'ok';
    render();
  }

  async function renderAudit() {
    const el = document.getElementById('platformSettingsAudit');
    if (!el) return;
    const { data, error } = await client.rpc('admin_audit_log', { p_limit: 30, p_offset: 0, p_action: 'settings.platform' });
    if (error) { el.innerHTML = `<p class="err" role="alert">${esc(error.message)}</p>`; return; }
    const rows = (data || []).map((a) => `<tr><td>${esc(new Date(a.occurred_at).toLocaleString())}</td><td>${esc(a.actor_email)}</td><td class="mono">${esc(a.subject_id)}</td><td class="mono">${esc(JSON.stringify(a.old_value?.value ?? null))}</td><td class="mono">${esc(JSON.stringify(a.new_value?.value ?? null))}</td></tr>`).join('');
    el.innerHTML = `<h3>Settings changes</h3><div class="card flush"><table class="table"><thead><tr><th>When</th><th>Who</th><th>Setting</th><th>From</th><th>To</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="empty">No changes yet</td></tr>'}</tbody></table></div>`;
  }

  function rowHtml(r) {
    return `<tr><td>${r.dangerous ? '⚠ ' : ''}${esc(r.label)}<div class="faint">Now: ${esc(show(r))}${r.updated_at ? ` · changed ${esc(new Date(r.updated_at).toLocaleString())} by ${esc(r.updated_by_email || '?')}` : ' · default'}</div><div class="faint" data-ps-status="${r.key}" role="status"></div></td>
      <td class="num" style="white-space:nowrap">${editor(r)}</td></tr>`;
  }
  function groupsHtml(groups, byKey) {
    return groups.map(([title, keys]) => `<h3>${esc(title)}</h3><div class="card flush"><table class="table"><tbody>${keys.filter((k) => byKey[k]).map((k) => rowHtml(byKey[k])).join('')}</tbody></table></div>`).join('');
  }
  function modeHtml(row) {
    if (!row) return '';
    return `<h3>Payment mode</h3>
      <div class="card" role="radiogroup" aria-label="Payment mode">
        ${MODES.map(([v, t, d]) => `<label class="row" style="align-items:flex-start;gap:10px;margin:0 0 10px">
          <input type="radio" name="psMode" value="${v}" ${row.value === v ? 'checked' : ''}>
          <span><strong>${esc(t)}</strong>${row.value === v ? ' <span class="faint">(now)</span>' : ''}<br><span class="muted">${esc(d)}</span></span></label>`).join('')}
        <button class="btn primary sm" id="psModeSave">Save payment mode</button>
        <div class="faint" data-ps-status="payment_mode" role="status"></div>
      </div>`;
  }
  async function feeHtml() {
    const { data } = await client.from('app_settings').select('value').eq('key', 'default_platform_fee_percent').maybeSingle();
    const v = data?.value;
    const pct = Number((v && typeof v === 'object' ? v.percent : v) ?? 0);
    return `<h3>Platform fee</h3>
      <div class="card"><p class="muted">CPAY’s fee on each payment, in Balance and Instant forward modes. An account’s own fee (Manage users) wins over this.</p>
        <div class="field short"><label for="psFee">Fee %</label><input id="psFee" type="number" min="0" max="90" step="0.1" value="${pct}"></div>
        <button class="btn primary sm" id="psFeeSave">Save fee</button>
        <div class="faint" id="psFeeStatus" role="status"></div></div>`;
  }

  function wire(el, byKey) {
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

  async function render() {
    const el = host();
    if (!el || !client) return;
    const { data, error } = await client.rpc('admin_platform_settings');
    if (error) { el.innerHTML = `<p class="err" role="alert">${esc(error.message)}</p>`; return; }
    const byKey = Object.fromEntries((data || []).map((r) => [r.key, r]));
    el.innerHTML = `<h2>Settings</h2>
      <p class="muted">Changes need two-step sign-in and are recorded below. Settings marked ⚠ ask for confirmation.</p>
      ${modeHtml(byKey.payment_mode)}
      ${await feeHtml()}
      ${groupsHtml(MAIN, byKey)}
      <div id="platformSettingsAudit"></div>`;
    wire(el, byKey);
    const modeBtn = document.getElementById('psModeSave');
    if (modeBtn) modeBtn.onclick = () => {
      const picked = el.querySelector('input[name="psMode"]:checked');
      const row = byKey.payment_mode;
      if (!picked || picked.value === row.value) return;
      const label = MODES.find(([v]) => v === picked.value)[1];
      save({ ...row, label: 'Payment mode' }, picked.value, el.querySelector('[data-ps-status="payment_mode"]'), label);
    };
    document.getElementById('psFeeSave').onclick = async () => {
      const st = document.getElementById('psFeeStatus');
      const n = Number(document.getElementById('psFee').value);
      if (!Number.isFinite(n) || n < 0 || n > 90) { st.textContent = 'Enter a number from 0 to 90'; st.className = 'err'; return; }
      st.textContent = 'Saving…';
      const { error: e } = await client.rpc('admin_set_default_platform_fee', { p_percent: n });
      st.textContent = e ? e.message : 'Saved'; st.className = e ? 'err' : 'ok';
    };
    const adv = document.getElementById('platformSettingsAdvanced');
    if (adv) { adv.innerHTML = groupsHtml(ADVANCED, byKey); wire(adv, byKey); }
    renderAudit();
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest && e.target.closest('.navi[data-tab="settings"]');
    if (t) setTimeout(render, 0);
  });
  if (location.hash === '#settings') setTimeout(render, 0);
  window.addEventListener('cpay:admin-ready', render);
})();
