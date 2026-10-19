// Admin → Instant forwards (docs/INSTANT-FORWARD.md). Reads
// admin_list_forwards(); "Try again" and "Move to balance" call
// admin_forward_action() (active admin at aal2, audited). Only held
// ('owed') forwards can be changed. No globals.
(function () {
  'use strict';
  const client = window.supabaseClient;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const STATUS = { queued: 'Waiting', sending: 'Sending', retry: 'Will retry', owed: 'Held', forwarded: 'Sent', released: 'Moved to balance' };
  const REASON = { failed: 'Failed too many times', no_address: 'No Lightning address', below_minimum: 'Too small', over_limit: 'Over the limit', no_amount: 'Amount unknown', outside_address_limits: 'Address does not accept this amount' };
  const MODE = { balance: 'Balance', instant_forward: 'Instant forward', direct: 'Direct (no fee)' };
  const sats = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US') + ' sats');
  let filter = '';

  async function act(id, action) {
    const msg = action === 'retry'
      ? 'Try this forward again now? It is sent to the user’s current Lightning address.'
      : 'Move this amount to the user’s CPAY balance instead? It will not be forwarded.';
    if (!window.confirm(msg)) return;
    const { error } = await client.rpc('admin_forward_action', { p_id: id, p_action: action });
    if (error) window.alert(error.message);
    render();
  }

  async function render() {
    const el = document.getElementById('instantForwards');
    if (!el || !client) return;
    const { data, error } = await client.rpc('admin_list_forwards', { p_status: filter || null, p_limit: 200 });
    if (error) { el.innerHTML = `<h2>Instant forwards</h2><p class="err" role="alert">${esc(error.message)}</p>`; return; }
    const c = data.counts || {};
    const t = data.totals || {};
    const rows = (data.rows || []).map((f) => `<tr>
      <td>${esc(new Date(f.created_at).toLocaleString())}</td><td>${esc(f.user_email || f.user_id)}</td>
      <td class="mono">${esc(f.address || '—')}</td><td class="num">${esc(sats(f.gross_sat))}</td><td class="num">${esc(sats(f.fee_sat))}</td>
      <td class="num">${esc(sats(f.sent_sat ?? f.forward_sat))}</td>
      <td>${esc(STATUS[f.status] || f.status)}${f.reason ? `<div class="faint">${esc(REASON[f.reason] || f.reason)}</div>` : ''}${f.last_error ? `<div class="faint">${esc(f.last_error)}</div>` : ''}</td>
      <td class="num">${esc(f.attempts)}</td>
      <td class="num" style="white-space:nowrap">${f.status === 'owed' ? `<button class="btn ghost sm" data-fw-retry="${esc(f.id)}">Try again</button> <button class="btn ghost sm" data-fw-release="${esc(f.id)}">Move to balance</button>` : ''}</td></tr>`).join('');
    el.innerHTML = `<h2>Instant forwards</h2>
      <p class="muted">Payment mode: <strong>${esc(MODE[data.mode] || data.mode)}</strong>. Each payment’s fee stays with CPAY; the rest is sent to the user’s Lightning address.</p>
      <div class="row" style="gap:16px;flex-wrap:wrap">
        <span>Sent: <strong>${esc(c.forwarded || 0)}</strong></span><span>Waiting: <strong>${esc((c.queued || 0) + (c.sending || 0) + (c.retry || 0))}</strong></span>
        <span>Held: <strong>${esc(c.owed || 0)}</strong></span><span>Moved to balance: <strong>${esc(c.released || 0)}</strong></span>
        <span>Totals check: <strong class="${t.ok ? 'ok' : 'err'}">${t.ok ? 'OK' : 'Mismatch'}</strong></span>
      </div>
      <p class="faint">Received ${esc(sats(t.received_sat))} = fees ${esc(sats(t.fee_sat))} + sent ${esc(sats(t.sent_sat))} + network fees ${esc(sats(t.network_fee_sat))} + left over ${esc(sats(t.remainder_sat))} + held ${esc(sats(t.owed_sat))} + waiting ${esc(sats(t.in_flight_sat))} + moved ${esc(sats(t.released_sat))}</p>
      <div class="field short"><label for="fwFilter">Show</label><select id="fwFilter">
        ${[['', 'All'], ['owed', 'Held'], ['retry', 'Will retry'], ['queued', 'Waiting'], ['sending', 'Sending'], ['forwarded', 'Sent'], ['released', 'Moved to balance']].map(([v, l]) => `<option value="${v}" ${v === filter ? 'selected' : ''}>${l}</option>`).join('')}
      </select></div>
      <div class="card flush"><table class="table"><thead><tr><th>When</th><th>User</th><th>Address</th><th>Paid</th><th>Fee</th><th>Sent</th><th>Status</th><th>Tries</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="9" class="empty">No forwards yet</td></tr>'}</tbody></table></div>`;
    document.getElementById('fwFilter').onchange = (e) => { filter = e.target.value; render(); };
    el.querySelectorAll('[data-fw-retry]').forEach((b) => { b.onclick = () => act(b.dataset.fwRetry, 'retry'); });
    el.querySelectorAll('[data-fw-release]').forEach((b) => { b.onclick = () => act(b.dataset.fwRelease, 'release'); });
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest && e.target.closest('.navi[data-tab="forwards"]');
    if (t) setTimeout(render, 0);
  });
  if (location.hash === '#forwards') setTimeout(render, 0);
})();
