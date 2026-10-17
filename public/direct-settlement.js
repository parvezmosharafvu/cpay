// Direct payments on the Freelancer desk (20261018010000): payers pay the
// Freelancer's own Lightning wallet, so the money never passes through CPAY.
// Nothing here shows while the owner's switch is off and the account has no
// direct history. Uses app.js helpers (escapeHtml, when, money, toast,
// deskEmpty, deskError, callFunction).
(function () {
  const sb = () => window.supabaseClient;
  let cached = null;

  async function state(force) {
    if (cached && !force) return cached;
    const { data, error } = await sb().rpc('get_my_direct_settlement');
    // Before the migration, or on an error, the desk behaves as before.
    cached = error ? { enabled: false, blocked: false, current: null, pending: null, unavailable: true } : data;
    return cached;
  }

  const visible = (s) => Boolean(s && (s.enabled || s.current || s.pending));
  const readyNow = (s) => Boolean(s && s.enabled && !s.blocked && s.current);

  function statusLines(s) {
    const out = [];
    if (s.current) out.push(`<p><span class="badge live">in use</span> <code>${escapeHtml(s.current.address)}</code></p>`);
    if (s.pending) {
      out.push(`<p><span class="badge pending">waiting</span> <code>${escapeHtml(s.pending.address)}</code> is used from ${escapeHtml(when(s.pending.ready_at))}${s.current ? '; until then payments still go to the address in use' : ''}.</p>`);
    }
    if (!s.current && !s.pending) out.push('<p class="faint">No Lightning address yet.</p>');
    if (s.blocked) out.push('<p class="alert alert-warn">Direct payments are turned off for this account. Contact support.</p>');
    if (!s.enabled) out.push('<p class="alert alert-info">Direct payments are paused by CPAY. Your direct links are not taking payments.</p>');
    return out.join('');
  }

  // Profile tab: where direct payments go.
  async function card(el, onChange) {
    if (!el) return;
    const s = await state(true);
    if (!visible(s)) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.innerHTML = `<div class="card" id="directCardInner">
      <div class="card-title"><div><h3>Get paid straight to your own wallet</h3>
        <p class="faint">With direct payments, payers pay your own Lightning wallet. The money goes straight there: CPAY never holds it, cannot withdraw, refund or move it, and it is not part of your CPAY balance.</p></div></div>
      <div id="directStatus">${statusLines(s)}</div>
      <div class="field"><label for="directAddr">Lightning address</label>
        <input id="directAddr" placeholder="name@your-wallet-provider.com" autocomplete="off" autocapitalize="none" spellcheck="false" inputmode="email" aria-describedby="directHint"></div>
      <p class="hint" id="directHint">Use the Lightning address of a wallet you control. CPAY checks that the wallet provider can confirm payments before you can save it. Payers see this address on the payment page. For your safety, a new address is used 24 hours after you save it.</p>
      <p class="hint" id="directResult" role="status" hidden></p>
      <div class="row">
        <button class="btn ghost" id="directCheck" type="button"${s.enabled && !s.blocked ? '' : ' disabled'}>Check address</button>
        <button class="btn primary" id="directSave" type="button" disabled>Save address</button>
        ${s.current || s.pending ? '<button class="btn quiet" id="directRemove" type="button">Remove address</button>' : ''}
      </div>
    </div>`;
    const addr = el.querySelector('#directAddr');
    const result = el.querySelector('#directResult');
    const save = el.querySelector('#directSave');
    let checked = '';
    const say = (text) => { result.textContent = text; result.hidden = !text; };
    addr.addEventListener('input', () => { if (addr.value.trim().toLowerCase() !== checked) { save.disabled = true; say(''); } });
    el.querySelector('#directCheck').onclick = async () => {
      const btn = el.querySelector('#directCheck');
      btn.disabled = true;
      say('Checking with your wallet provider…');
      const r = await callFunction('settlement-destination', { action: 'check', address: addr.value });
      btn.disabled = false;
      if (!r.ok) { checked = ''; save.disabled = true; return say(r.message || 'Could not check that address.'); }
      checked = r.data.address;
      addr.value = r.data.address;
      save.disabled = false;
      say(`${r.data.address} works and confirms payments. It takes ${Number(r.data.minSats).toLocaleString()} to ${Number(r.data.maxSats).toLocaleString()} sats per payment.`);
    };
    save.onclick = async () => {
      save.disabled = true;
      const call = () => callFunction('settlement-destination', { action: 'save', address: checked });
      const r = window.cpayWithStepUp ? await window.cpayWithStepUp(call) : await call();
      if (!r.ok) { save.disabled = false; return toast(r.message || 'Could not save that address'); }
      toast(r.data.unchanged ? 'That address is already in use' : `Saved. It is used from ${when(r.data.readyAt)}.`, true);
      if (onChange) onChange();
    };
    const remove = el.querySelector('#directRemove');
    if (remove) {
      remove.onclick = async () => {
        if (!window.confirm('Remove your Lightning address? Your direct links stop taking payments until you add one again. They are not switched to your CPAY balance.')) return;
        remove.disabled = true;
        const call = () => callFunction('settlement-destination', { action: 'remove' });
        const r = window.cpayWithStepUp ? await window.cpayWithStepUp(call) : await call();
        if (!r.ok) { remove.disabled = false; return toast(r.message || 'Could not remove it'); }
        toast('Removed. Direct links are not taking payments.', true);
        if (onChange) onChange();
      };
    }
  }

  // Links tab: one cell per link, plus the switch button.
  function linkCell(link, s) {
    const direct = link.settlement_mode === 'direct';
    if (!visible(s) && !direct) return '';
    const label = direct
      ? (readyNow(s) ? 'Your wallet' : 'Your wallet (not taking payments)')
      : 'CPAY balance';
    return `<td data-label="Payments go to">${escapeHtml(label)}</td>`;
  }
  function linkButton(link, s) {
    const direct = link.settlement_mode === 'direct';
    if (direct) return `<button type="button" class="btn ghost sm" data-settle-link="${escapeHtml(link.id)}" data-mode="custodial">Pay to CPAY balance</button>`;
    if (!s.enabled || s.blocked || !(s.current || s.pending)) return '';
    return `<button type="button" class="btn ghost sm" data-settle-link="${escapeHtml(link.id)}" data-mode="direct">Pay to my wallet</button>`;
  }
  function bindLinkButtons(root, onChange) {
    root.querySelectorAll('[data-settle-link]').forEach((btn) => {
      btn.onclick = async () => {
        const toDirect = btn.dataset.mode === 'direct';
        const msg = toDirect
          ? 'New payments on this link will go straight to your own wallet. They will not be part of your CPAY balance and CPAY cannot withdraw or refund them. Continue?'
          : 'New payments on this link will go to CPAY and your CPAY balance (held by CPAY). Continue?';
        if (!window.confirm(msg)) return;
        btn.disabled = true;
        const { error } = await sb().rpc('set_link_settlement_mode', { p_link_id: btn.dataset.settleLink, p_mode: btn.dataset.mode });
        if (error) { btn.disabled = false; return toast(error.message); }
        toast(toDirect ? 'This link now pays your wallet' : 'This link now pays your CPAY balance', true);
        if (onChange) onChange();
      };
    });
  }
  // New-link form: the choice, only when an address is in use.
  function newLinkChoice(s) {
    if (!readyNow(s)) return '';
    return `<fieldset class="choice" id="newLinkMode">
      <legend>Where payments go</legend>
      <label class="choice-opt"><input type="radio" name="newLinkMode" value="direct" checked><span><strong>Straight to my wallet</strong><span class="faint">${escapeHtml(s.current.address)}. Not held by CPAY</span></span></label>
      <label class="choice-opt"><input type="radio" name="newLinkMode" value="custodial"><span><strong>My CPAY balance</strong><span class="faint">Held by CPAY, withdrawn as USDT</span></span></label>
    </fieldset>`;
  }
  function chosenMode() {
    const r = document.querySelector('input[name="newLinkMode"]:checked');
    return r ? r.value : 'custodial';
  }

  // Payments tab: direct payments, never mixed into the CPAY history.
  async function paymentsCard(el) {
    if (!el) return;
    const s = await state();
    const { data, error } = await sb().from('direct_payments')
      .select('id, created_at, status, amount_usd, amount_msat, destination_address, paid_observed_at, payment_link_id')
      .order('created_at', { ascending: false }).limit(50);
    if (error) { el.hidden = !visible(s); if (visible(s)) el.innerHTML = deskError(error.message); return; }
    if (!visible(s) && !(data || []).length) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    const label = { paid: 'paid', pending: 'waiting', expired: 'expired' };
    const rows = (data || []).map((p) => `<tr>
      <td class="num" data-label="Amount"><span class="cell-main">${money(p.amount_usd)}</span></td>
      <td class="num" data-label="Sats">${Number(BigInt(p.amount_msat) / 1000n).toLocaleString()}</td>
      <td data-label="Status"><span class="badge ${escapeHtml(p.status)}">${escapeHtml(label[p.status] || p.status)}</span></td>
      <td class="mono" data-label="Paid to">${escapeHtml(p.destination_address)}</td>
      <td data-label="When">${escapeHtml(when(p.paid_observed_at || p.created_at))}</td>
    </tr>`).join('');
    el.innerHTML = `<div class="card flush">
      <div class="card-head"><div><h3>Direct payments</h3><div class="faint">Paid straight to your own wallet. Not part of your CPAY balance, and not withdrawable here: the money is already in your wallet.</div></div><span class="meta-count">${(data || []).length} shown</span></div>
      <div class="scroll"><table class="table rtable"><thead><tr><th class="num">Amount</th><th class="num">Sats</th><th>Status</th><th>Paid to</th><th>When</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="5">${deskEmpty('No direct payments yet', 'Switch a link to "Pay to my wallet" to take them.')}</td></tr>`}</tbody></table></div>
    </div>`;
  }

  window.cpayDirect = { state, card, linkCell, linkButton, bindLinkButtons, newLinkChoice, chosenMode, paymentsCard, visible, readyNow };
})();
