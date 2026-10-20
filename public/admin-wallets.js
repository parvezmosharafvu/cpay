// Admin → Wallet → Wallets (owner only). Several platform wallets: list
// with balance and health, add one by pasting its 12-word seed, make one
// primary (it makes new invoices and pays forwards and withdrawals),
// rename, standby/disable, and remove (passkey + typed name; the server
// refuses while it holds money or has sends in progress).
//
// Every call goes to the wallet-registry Edge Function, which checks the
// owner (CPAY_OWNER_USER_ID) and a passkey session. Other admins get
// owner_only and this card is never shown.
//
// The seed: a masked field, checked here (BIP39 words + checksum) before
// it is sent once over HTTPS, then the field is cleared whatever happens.
// It is never stored in the page, never logged, never shown again: the
// list shows only a fingerprint and, after the first sync, the node key.
(function () {
  'use strict';
  const client = () => window.supabaseClient;
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const fmtSats = (n) => (n == null ? '-' : `${Number(n).toLocaleString('en-US')} sats`);
  const say = (m, ok) => (typeof window.toast === 'function' ? window.toast(m, ok) : null);
  let state = { owner: null, data: null };

  const MESSAGES = {
    duplicate_wallet: 'This wallet is already added.',
    seed_word_count: 'Enter exactly 12 words.',
    seed_unknown_word: 'One of the words is not a seed word. Check the spelling.',
    seed_checksum: 'These 12 words are not a valid seed. Check the order and spelling.',
    rate_limited: 'Too many attempts. Try again in an hour.',
    passkey_required: 'Confirm with your passkey again.',
    aal2_required: 'Sign in again with your passkey.',
    balance_not_zero: 'This wallet still holds money. Move it out first.',
    balance_unknown: 'The balance is not known yet. Wait for the next sync (about a minute) and try again.',
    open_invoices: 'This wallet has open invoices. Wait until they are paid or expire.',
    forwards_pending: 'Forwards from this wallet are still in progress.',
    withdrawals_pending: 'Withdrawals from this wallet are still in progress.',
    primary_not_removable: 'Make another wallet primary first.',
    primary_must_stay_active: 'The primary wallet must stay active.',
    legacy_wallet_not_removable: 'Wallet 1 uses the original server seed and cannot be removed here.',
    confirmation_mismatch: 'The name you typed does not match.',
    wallet_not_active: 'Activate the wallet first.',
    bad_label: 'Give the wallet a name (up to 60 characters).',
  };
  const msgOf = (code) => MESSAGES[code] || 'That did not work. Try again.';

  async function call(body) {
    const { data, error } = await client().functions.invoke('wallet-registry', { body });
    if (!error) return { ok: true, data };
    let p = null;
    try { p = await error.context.json(); } catch (e) { p = null; }
    return { ok: false, code: (p && p.code) || 'failed' };
  }

  // BIP39: 12 words from the list, 4-bit SHA-256 checksum.
  async function checkSeed(raw) {
    const words = String(raw || '').normalize('NFKD').toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (words.length !== 12) return 'seed_word_count';
    const list = window.CPAY_BIP39_WORDS || [];
    if (list.length !== 2048) return 'failed';
    let bits = '';
    for (const w of words) {
      const i = list.indexOf(w);
      if (i < 0) return 'seed_unknown_word';
      bits += i.toString(2).padStart(11, '0');
    }
    const ent = new Uint8Array(16);
    for (let b = 0; b < 16; b++) ent[b] = parseInt(bits.slice(b * 8, b * 8 + 8), 2);
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', ent));
    const ok = (h[0] >> 4) === parseInt(bits.slice(128), 2);
    ent.fill(0);
    return ok ? null : 'seed_checksum';
  }

  async function passkey(message) {
    if (!window.cpayMfa || !window.cpayMfa.promptPasskey) return false;
    return window.cpayMfa.promptPasskey(message);
  }

  function walletRow(w) {
    const tr = el('tr');
    const name = el('td');
    name.append(el('strong', null, w.label));
    if (w.is_primary) { name.append(document.createTextNode(' ')); name.append(el('span', 'badge active', 'Primary')); }
    if (w.is_legacy) name.append(el('div', 'faint', 'Original wallet (server seed)'));
    tr.append(name);
    const st = el('td'); st.append(el('span', `badge ${w.status}`, w.status)); tr.append(st);
    tr.append(el('td', 'num', fmtSats(w.balance_sat)));
    const health = el('td');
    if (w.last_error) health.append(el('span', 'err', 'Sync failed'));
    else if (w.synced_at) health.append(el('span', null, `Synced ${new Date(w.synced_at).toLocaleTimeString()}`));
    else health.append(el('span', 'faint', w.status === 'active' ? 'Waiting for first sync' : 'Not synced'));
    if (w.open_invoices || w.pending_sends) health.append(el('div', 'faint', `${w.open_invoices || 0} open invoices · ${w.pending_sends || 0} sends in progress`));
    tr.append(health);
    const id = el('td', 'mono');
    id.append(el('div', null, w.fingerprint ? `fp ${w.fingerprint}` : '-'));
    if (w.node_pubkey) id.append(el('div', 'faint', `node ${w.node_pubkey.slice(0, 10)}…${w.node_pubkey.slice(-6)}`));
    tr.append(id);
    const act = el('td');
    const btn = (label, fn, cls = 'btn ghost sm') => { const b = el('button', cls, label); b.type = 'button'; b.onclick = fn; act.append(b); return b; };
    if (!w.is_primary && w.status === 'active') btn('Make primary', () => act1({ action: 'set_primary', id: w.id }, `Make "${w.label}" the primary wallet? New invoices, forwards and withdrawals will use it.`));
    btn('Rename', async () => {
      const label = window.prompt('New name', w.label);
      if (label && label.trim() && label.trim() !== w.label) act1({ action: 'rename', id: w.id, label: label.trim() });
    });
    if (!w.is_primary) {
      if (w.status !== 'active') btn('Activate', () => act1({ action: 'set_status', id: w.id, status: 'active' }));
      if (w.status === 'active') btn('Standby', () => act1({ action: 'set_status', id: w.id, status: 'standby' }, 'Standby: the wallet is not synced and not used. Payments to its old invoices settle only after you activate it again.'));
      if (w.status !== 'disabled') btn('Disable', () => act1({ action: 'set_status', id: w.id, status: 'disabled' }, `Disable "${w.label}"? It will not be opened until you activate it.`));
      if (!w.is_legacy) btn('Remove', () => remove(w), 'btn ghost sm danger');
    }
    tr.append(act);
    return tr;
  }

  async function act1(body, question) {
    if (question && !window.confirm(question)) return;
    const r = await call(body);
    if (!r.ok) { say(msgOf(r.code)); return; }
    say('Saved', true);
    load();
  }

  async function remove(w) {
    const typed = window.prompt(`To remove "${w.label}", type its name exactly. Its seed is deleted from the server; keep your own backup if you may need it.`);
    if (typed == null) return;
    if (typed !== w.label) { say(msgOf('confirmation_mismatch')); return; }
    if (!(await passkey('Confirm with your passkey to remove a wallet.'))) return;
    const r = await call({ action: 'remove', id: w.id, confirm: typed });
    if (!r.ok) { say(msgOf(r.code)); return; }
    say('Wallet removed', true);
    load();
  }

  function addForm() {
    const card = el('div', 'card');
    card.dataset.role = 'wallet-add';
    card.append(el('h3', null, 'Add a wallet'));
    card.append(el('p', 'hint', 'Paste the 12-word seed of the wallet. It is checked here, sent once over a secure connection and kept encrypted on the server. It is never shown again.'));
    const f1 = el('div', 'field');
    const lab = el('label', null, 'Name'); lab.htmlFor = 'mwLabel';
    const name = el('input', 'input'); name.id = 'mwLabel'; name.maxLength = 60; name.placeholder = 'Wallet 2'; name.autocomplete = 'off';
    f1.append(lab, name);
    const f2 = el('div', 'field');
    const lab2 = el('label', null, '12-word seed'); lab2.htmlFor = 'mwSeed';
    const seed = el('input', 'input mono'); seed.id = 'mwSeed'; seed.type = 'password';
    seed.autocomplete = 'off'; seed.spellcheck = false; seed.setAttribute('autocapitalize', 'off'); seed.setAttribute('autocorrect', 'off');
    seed.setAttribute('data-lpignore', 'true'); seed.setAttribute('data-1p-ignore', 'true');
    f2.append(lab2, seed);
    const hint = el('p', 'hint'); hint.setAttribute('role', 'status');
    const go = el('button', 'btn primary', 'Add wallet'); go.type = 'button';
    seed.oninput = async () => {
      const v = seed.value;
      const words = v.trim().split(/\s+/).filter(Boolean).length;
      if (words < 12) { hint.textContent = `${words} of 12 words`; hint.className = 'hint'; return; }
      const code = await checkSeed(v);
      hint.textContent = code ? msgOf(code) : 'Valid 12-word seed';
      hint.className = code ? 'hint err' : 'hint ok';
    };
    go.onclick = async () => {
      go.disabled = true;
      let value = seed.value;
      seed.value = ''; // cleared at once, whatever happens next
      hint.textContent = '';
      try {
        const code = await checkSeed(value);
        if (code) { say(msgOf(code)); return; }
        if (!name.value.trim()) { say(msgOf('bad_label')); return; }
        if (!(await passkey('Confirm with your passkey to add a wallet.'))) return;
        const r = await call({ action: 'add', label: name.value.trim(), mnemonic: value });
        value = '';
        if (!r.ok) { say(msgOf(r.code)); return; }
        name.value = '';
        say(`Wallet added (fingerprint ${r.data.wallet.fingerprint})`, true);
        load();
      } finally {
        value = '';
        go.disabled = false;
      }
    };
    card.append(f1, f2, hint, go);
    return card;
  }

  function render(host) {
    host.replaceChildren();
    const d = state.data;
    const card = el('div', 'card');
    const head = el('div', 'card-title');
    const h = el('div');
    h.append(el('h3', null, 'Wallets'));
    h.append(el('p', 'faint', 'The primary wallet makes new invoices and pays forwards and withdrawals. Other active wallets are checked every minute, so payments to their earlier invoices still arrive.'));
    head.append(h);
    head.append(el('div', 'kpi', `Total ${fmtSats(d.total_balance_sat)}`));
    card.append(head);
    const table = el('table', 'table');
    const thead = el('thead'); const hr = el('tr');
    for (const t of ['Wallet', 'Status', 'Balance', 'Health', 'Fingerprint', '']) hr.append(el('th', null, t));
    thead.append(hr);
    const tb = el('tbody');
    for (const w of d.wallets || []) tb.append(walletRow(w));
    table.append(thead, tb);
    const wrap = el('div', 'table-wrap'); wrap.append(table);
    card.append(wrap);
    host.append(card, addForm());
  }

  async function load() {
    const host = document.getElementById('walletRegistry');
    if (!host) return;
    const r = await call({ action: 'list' });
    if (!r.ok) {
      if (r.code === 'owner_only') { state.owner = false; host.remove(); return; }
      host.replaceChildren(el('div', 'card', r.code === 'aal2_required' ? 'Sign in again with your passkey to manage wallets.' : 'Wallets did not load.'));
      return;
    }
    state.owner = true;
    state.data = r.data;
    render(host);
  }

  // admin-wallet.js rebuilds #wallet; keep our card first in it.
  function mount() {
    if (state.owner === false) return;
    const sec = document.getElementById('wallet');
    if (!sec || sec.hidden) return;
    let host = document.getElementById('walletRegistry');
    if (host && host.parentNode === sec && sec.firstChild === host) return;
    if (!host) { host = el('div'); host.id = 'walletRegistry'; host.dataset.role = 'wallet-registry'; }
    sec.prepend(host);
    if (state.data) render(host); else load();
  }

  function start() {
    const sec = document.getElementById('wallet');
    if (!sec) return;
    new MutationObserver(mount).observe(sec, { childList: true, attributes: true, attributeFilter: ['hidden'] });
    mount();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.cpayAdminWallets = { reload: load, checkSeed };
})();
