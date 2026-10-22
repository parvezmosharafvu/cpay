// Admin → Locations (20261020090000). Reads admin_locations(): payer
// country / region / city per payment, account locations users set, and
// last-seen country. Active admin at aal2 only (the database refuses
// otherwise). Coarse data only; no IP addresses exist to show. No globals.
(function () {
  'use strict';
  const client = window.supabaseClient;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let names = null;
  try { names = new Intl.DisplayNames(['en'], { type: 'region' }); } catch (e) { names = null; }
  const cn = (c) => { if (!c || c === '??') return 'Unknown'; try { return (names && names.of(c)) || c; } catch (e) { return c; } };
  const usd = (n) => '$' + Number(n || 0).toFixed(2);
  const state = { country: '', area: '', days: 30 };
  let seq = 0;
  const draft = { ...state };
  let validation = '';

  async function render() {
    const el = document.getElementById('adminLocations');
    if (!el || !client) return;
    const mine = ++seq;
    el.setAttribute('aria-busy', 'true');
    let result, timer;
    try { result = await Promise.race([client.rpc('admin_locations', {
      p_country: state.country || null, p_area: state.area || null, p_days: state.days, p_limit: 200,
    }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Location read timed out. Refresh to try again.')), 12000); })]); }
    catch (error) { result = { error }; }
    finally { clearTimeout(timer); }
    if (mine !== seq) return;
    el.setAttribute('aria-busy', 'false');
    const { data, error } = result;
    const form = `<div class="desk-toolbar" role="search">
        <div class="field short"><label for="locFCountry">Country code</label><input id="locFCountry" maxlength="2" placeholder="BD" value="${esc(draft.country)}"></div>
        <div class="field"><label for="locFArea">Area</label><input id="locFArea" maxlength="80" placeholder="Division, district, city or area" value="${esc(draft.area)}"></div>
        <div class="field short"><label for="locFDays">Payments from the last</label><select id="locFDays">${[7, 30, 90, 365].map((d) => `<option value="${d}" ${Number(draft.days) === d ? 'selected' : ''}>${d} days</option>`).join('')}</select></div>
        <button type="button" class="btn primary" id="locFApply">Apply</button><button type="button" class="btn ghost" id="locFClear">Clear</button><button type="button" class="btn ghost" id="locFRefresh">Refresh locations</button>
      </div><p id="locFStatus" role="status" class="faint">${esc(validation)}</p>`;
    if (error || !data) {
      el.innerHTML = `<h2>Locations</h2>${form}<p class="err" role="alert">${esc(error?.message || 'Location data unavailable')}</p>`;
      bind();
      return;
    }
    const byArea = (data.payments_by_area || []).map((r) => `<tr><td>${esc(cn(r.country))}</td><td>${esc(r.area || '—')}</td><td class="num">${esc(r.payments)}</td><td class="num">${esc(r.settled)}</td><td class="num">${esc(usd(r.settled_usd))}</td></tr>`).join('');
    const usersByArea = (data.users_by_area || []).map((r) => `<tr><td>${esc(cn(r.country))}</td><td>${esc(r.division || '—')}</td><td>${esc(r.district || '—')}</td><td class="num">${esc(r.users)}</td></tr>`).join('');
    const pays = (data.payments || []).map((p) => `<tr><td>${esc(new Date(p.created_at).toLocaleString())}</td><td>${esc(p.user_email || '')}</td><td>/${esc(p.link_slug || '')}<details><summary>Payment reference</summary><span class="mono">${esc(p.id)}</span></details></td><td>${esc(p.status)}</td><td class="num">${esc(usd(p.amount_settled ?? p.amount_requested))}</td><td>${esc([p.city, p.region, cn(p.country)].filter(Boolean).join(', '))}</td></tr>`).join('');
    const users = (data.users || []).map((u) => `<tr><td>${esc(u.display_name || '')}<div class="faint">${esc(u.email || '')}</div><details><summary>Location details</summary><p class="mono">${esc(u.user_id)}</p><p class="faint">${u.updated_at ? esc(new Date(u.updated_at).toLocaleString()) : '—'}</p></details></td><td>${esc([u.area, u.district, u.division, u.country ? cn(u.country) : ''].filter(Boolean).join(', ') || '—')}</td><td>${u.last_seen_country ? esc(cn(u.last_seen_country)) + `<div class="faint">${u.last_seen_at ? esc(new Date(u.last_seen_at).toLocaleString()) : '—'}</div>` : '—'}</td></tr>`).join('');
    const table = (head, body, cols, empty) => `<div class="scroll"><table class="table rtable"><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td colspan="${cols}" class="faint">${empty}</td></tr>`}</tbody></table></div>`;
    el.innerHTML = `<h2>Locations</h2>
      <p class="faint">Approximate only: payer country, region and city from the connection when the payment was created; the location each user set; the country each user last opened their desk from. No IP addresses or GPS positions are stored.</p>
      ${form}<p class="faint">Payments use the selected date range. User locations are current profile data. Detail lists show up to 200 matching records.</p><p class="faint">${(data.payments || []).length} payment records · ${(data.users || []).length} user records</p>
      <div class="grid two">
        <div class="card flush"><div class="card-head"><h3>Payments by area</h3></div>${table('<th>Country</th><th>Region / city</th><th class="num">Payments</th><th class="num">Settled</th><th class="num">Settled USD</th>', byArea, 5, 'No payments in this range')}</div>
        <div class="card flush"><div class="card-head"><h3>Users by area</h3></div>${table('<th>Country</th><th>Division</th><th>District</th><th class="num">Users</th>', usersByArea, 4, 'No user has set a location')}</div>
      </div>
      <div class="card flush"><div class="card-head"><h3>Recent payments</h3></div>${table('<th>When</th><th>User</th><th>Link</th><th>Status</th><th class="num">Amount</th><th>Payer location</th>', pays, 6, 'None')}</div>
      <div class="card flush"><div class="card-head"><h3>Users</h3></div>${table('<th>User</th><th>Location (set by user)</th><th>Last seen</th>', users, 3, 'None')}</div>`;
    bind();
  }
  function bind() {
    const apply = document.getElementById('locFApply');
    if (!apply) return;
    const capture = () => {
      draft.country = document.getElementById('locFCountry').value;
      draft.area = document.getElementById('locFArea').value;
      draft.days = Number(document.getElementById('locFDays').value) || 30;
    };
    ['locFCountry','locFArea','locFDays'].forEach(id => {
      document.getElementById(id).oninput = capture;
      document.getElementById(id).onchange = capture;
      document.getElementById(id).onkeydown = e => { if (e.key === 'Enter') apply.onclick(); };
    });
    apply.onclick = () => {
      capture();
      const country = draft.country.trim().toUpperCase();
      if (country && !/^[A-Z]{2}$/.test(country)) {
        validation = 'Enter a two-letter country code or leave it empty.';
        document.getElementById('locFStatus').textContent = validation;
        document.getElementById('locFCountry').setAttribute('aria-invalid','true');
        return;
      }
      validation = '';
      Object.assign(state, { country, area: draft.area.trim(), days: [7,30,90,365].includes(draft.days) ? draft.days : 30 });
      Object.assign(draft, state); render();
    };
    document.getElementById('locFRefresh').onclick = render;
    document.getElementById('locFClear').onclick = () => { Object.assign(state, { country: '', area: '', days: 30 }); Object.assign(draft, state); validation = ''; render(); };

  }
  document.addEventListener('click', (e) => {
    const t = e.target.closest && e.target.closest('.navi[data-tab="locations"]');
    if (t) render();
  });
  if (location.hash === '#locations') render();
})();
