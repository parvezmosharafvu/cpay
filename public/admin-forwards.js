// Admin → Instant forwards (docs/INSTANT-FORWARD.md). Reads
// admin_list_forwards(); "Hold", "Try again" and "Move to balance" call
// admin_forward_action() (active admin at aal2, audited). Waiting forwards
// can be held (e.g. after switching the payment mode off); held ('owed')
// forwards can be tried again or moved to the balance. USDT batches stuck in
// 'sending' for over an hour are closed with admin_forward_batch_action().
// No globals.
(function () {
  'use strict';
  const client = window.supabaseClient;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const STATUS = { queued: 'Waiting', sending: 'Sending', retry: 'Will retry', owed: 'Held', forwarded: 'Sent', released: 'Moved to balance' };
  const REASON = { failed: 'Failed too many times', no_address: 'No Lightning address', below_minimum: 'Too small', over_limit: 'Over the limit', no_amount: 'Amount unknown', outside_address_limits: 'Address does not accept this amount', held_by_admin: 'Held by an admin', stuck_admin_review: 'Stuck send, check before releasing', invalid_address: 'Address rejected' };
  const MODE = { balance: 'Balance', instant_forward: 'Instant forward', direct: 'Direct (no fee)' };
  const sats = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US') + ' sats');
  let filter = '';
  let seq = 0;

  async function act(id, action) {
    const msg = action === 'hold'
      ? 'Hold this forward? It is not sent until you try it again or move it to the balance.'
      : action === 'retry'
        ? 'Try this forward again now? It is sent to the user’s current payout address.'
        : 'Move this amount to the user’s CPAY balance instead? It will not be forwarded.';
    if (!window.confirm(msg)) return;
    const { error } = await client.rpc('admin_forward_action', { p_id: id, p_action: action });
    if (error) window.alert(error.message);
    render();
  }

  async function batchAct(id, action) {
    let ref = null;
    if (action === 'delivered') {
      ref = window.prompt('The USDT arrived? Paste the transaction hash or the provider order id.');
      if (!ref || !ref.trim()) return;
    } else if (!window.confirm('Hold this batch for review? Its forwards become Held. Move them to the balance only once the provider shows the order failed or was refunded, or the user can be paid twice.')) return;
    const { error } = await client.rpc('admin_forward_batch_action', { p_id: id, p_action: action, p_ref: ref });
    if (error) window.alert(error.message);
    render();
  }

  // Built with DOM nodes and textContent: nothing from the database is parsed as HTML.
  function node(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => { if (k === 'text') n.textContent = v; else n.setAttribute(k, v); });
    kids.forEach((k) => n.append(k));
    return n;
  }

  function stuckBatches(list) {
    if (!list.length) return null;
    const body = node('tbody');
    for (const b of list) {
      const arrived = node('button', { class: 'btn ghost sm', type: 'button', text: 'It arrived' });
      arrived.onclick = () => batchAct(b.id, 'delivered');
      const hold = node('button', { class: 'btn ghost sm', type: 'button', text: 'Hold for review' });
      hold.onclick = () => batchAct(b.id, 'hold');
      body.append(node('tr', null,
        node('td', { text: new Date(b.created_at).toLocaleString() }),
        node('td', { text: b.user_email || '' }),
        node('td', { text: b.network }),
        node('td', { class: 'mono', text: b.address }),
        node('td', { class: 'num', text: `$${Number(b.amount_usd).toFixed(2)}` }),
        node('td', { class: 'faint', text: b.last_error || '' }),
        node('td', { class: 'num', style: 'white-space:nowrap' }, arrived, ' ', hold)));
    }
    const head = node('tr');
    ['Started', 'User', 'Network', 'Address', 'Amount', 'Last error', ''].forEach((h) => head.append(node('th', { text: h })));
    return node('div', null,
      node('h3', { text: 'USDT sends with no result for over an hour' }),
      node('p', { class: 'muted', text: 'Check the provider and the chain first. The wallet may still settle these by itself.' }),
      node('div', { class: 'card flush' }, node('table', { class: 'table' }, node('thead', null, head), body)));
  }

  async function render() {
    const el = document.getElementById('instantForwards');
    if (!el || !client) return;
    const mine = ++seq;
    const { data, error } = await client.rpc('admin_list_forwards', { p_status: filter || null, p_limit: 200 });
    if (mine !== seq) return;  // a newer render is under way
    if (error) { el.innerHTML = `<h2>Instant forwards</h2><p class="err" role="alert">${esc(error.message)}</p>`; return; }
    const c = data.counts || {};
    const t = data.totals || {};
    const rows = (data.rows || []).map((f) => `<tr>
      <td>${esc(new Date(f.created_at).toLocaleString())}</td><td>${esc(f.user_email || f.user_id)}</td>
      <td class="mono">${esc(f.address || '—')}</td><td class="num">${esc(sats(f.gross_sat))}</td><td class="num">${esc(sats(f.fee_sat))}</td>
      <td class="num">${esc(sats(f.sent_sat ?? f.forward_sat))}</td>
      <td>${esc(STATUS[f.status] || f.status)}${f.reason ? `<div class="faint">${esc(REASON[f.reason] || f.reason)}</div>` : ''}${f.last_error ? `<div class="faint">${esc(f.last_error)}</div>` : ''}</td>
      <td class="num">${esc(f.attempts)}</td>
      <td class="num" style="white-space:nowrap">${f.status === 'owed' ? `<button class="btn ghost sm" data-fw-retry="${esc(f.id)}">Try again</button> <button class="btn ghost sm" data-fw-release="${esc(f.id)}">Move to balance</button>` : ''}${f.status === 'queued' || f.status === 'retry' ? `<button class="btn ghost sm" data-fw-hold="${esc(f.id)}">Hold</button>` : ''}</td></tr>`).join('');
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
    const stuck = stuckBatches(data.stuck_batches || []);
    if (stuck) el.insertBefore(stuck, el.querySelector('.field.short'));
    el.querySelectorAll('[data-fw-hold]').forEach((b) => { b.onclick = () => act(b.dataset.fwHold, 'hold'); });
    el.querySelectorAll('[data-fw-retry]').forEach((b) => { b.onclick = () => act(b.dataset.fwRetry, 'retry'); });
    el.querySelectorAll('[data-fw-release]').forEach((b) => { b.onclick = () => act(b.dataset.fwRelease, 'release'); });
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest && e.target.closest('.navi[data-tab="forwards"]');
    if (t) setTimeout(render, 0);
  });
  if (location.hash === '#forwards') setTimeout(render, 0);
})();
