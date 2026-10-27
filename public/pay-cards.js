// Payment cards: a searchable list where each payment is one card (amount,
// account, status) and a tap opens its full details in place. Used by the
// admin Overview ("All payments") and Payments sections.
//
// Read-only except the actions a caller passes in (e.g. Mark settled). The
// search goes to the server; status and time filters apply to the loaded
// rows. Everything shown is escaped through textContent.
(function () {
  'use strict';
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const t = (s) => (window.cpayI18n && typeof window.cpayI18n.t === 'function' ? window.cpayI18n.t(s) : s);
  const fmtMoney = (v) => (typeof window.money === 'function' ? window.money(v) : `$${Number(v || 0).toFixed(2)}`);
  const fmtWhen = (v) => (v ? (typeof window.when === 'function' ? window.when(v) : new Date(v).toLocaleString()) : '—');
  const short = (s, a = 8, b = 7) => { s = String(s || ''); return s.length > a + b + 3 ? `${s.slice(0, a)}…${s.slice(-b)}` : s; };
  const say = (m, ok) => (typeof window.toast === 'function' ? window.toast(m, ok) : null);
  const TIME = { '': 0, today: 1, '7d': 7, '30d': 30 };
  let seq = 0;

  function badge(status) {
    const s = String(status || 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '');
    return el('span', `badge ${s}`, s || 'unknown');
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); say(t('Copied'), true); }
    catch { say(t('Could not copy')); }
  }

  function field(label, value, opts = {}) {
    const box = el('div', `pc-field${opts.wide ? ' wide' : ''}`);
    box.append(el('dt', null, label));
    const dd = el('dd', opts.mono ? 'mono' : null);
    dd.append(el('span', null, value == null || value === '' ? '—' : value));
    if (opts.copy) {
      const b = el('button', 'btn ghost sm pc-copy', t('Copy'));
      b.type = 'button';
      b.onclick = (e) => { e.stopPropagation(); copy(opts.copy); };
      dd.append(b);
    }
    box.append(dd);
    return box;
  }

  function card(p, opts, openIds) {
    const id = String(p.id);
    const art = el('article', 'pay-card');
    art.dataset.payId = id;
    const bodyId = `pc-body-${++seq}`;
    const head = el('button', 'pc-head');
    head.type = 'button';
    head.setAttribute('aria-controls', bodyId);
    const main = el('span', 'pc-main');
    main.append(el('span', 'pc-amount', fmtMoney(p.amount_settled ?? p.amount_requested)));
    const sub = opts.mode === 'admin' ? (p.creator_email || p.creator_name || '') : (p.link_name || (p.link_slug ? `/${p.link_slug}` : ''));
    main.append(el('span', 'pc-sub', sub));
    const side = el('span', 'pc-side');
    side.append(badge(p.status), el('span', 'pc-chev'));
    head.append(main, side);

    const body = el('div', 'pc-body');
    body.id = bodyId;
    const dl = el('dl', 'pc-grid');
    if (opts.mode === 'admin') dl.append(field(t('Account'), p.creator_name || p.creator_email || ''));
    dl.append(field(t('Link'), p.link_slug ? `/${p.link_slug}` : ''));
    dl.append(field(t('Method'), String(p.method || 'lightning').toUpperCase()));
    dl.append(field(t('Created'), fmtWhen(p.created_at)));
    if (p.settled_at) dl.append(field(t('Settled'), fmtWhen(p.settled_at)));
    else if (p.expires_at) dl.append(field(t('Expires'), fmtWhen(p.expires_at)));
    const place = [p.customer_city, p.customer_country].filter(Boolean).join(', ');
    dl.append(field(t('Location'), place));
    if (p.amount_settled != null && p.amount_requested != null && Number(p.amount_settled) !== Number(p.amount_requested)) {
      dl.append(field(t('Requested'), fmtMoney(p.amount_requested)));
    }
    const ref = p.invoice_ref || id;
    dl.append(field(t('Invoice ID'), short(ref), { mono: true, copy: ref, wide: true }));
    if (p.lightning_invoice) dl.append(field(t('Lightning invoice'), short(p.lightning_invoice, 14, 10), { mono: true, copy: p.lightning_invoice, wide: true }));
    if (p.marked_at) dl.append(field(t('Marked'), `${fmtWhen(p.marked_at)}${p.marked_by_name ? ` · ${p.marked_by_name}` : ''}${p.mark_note ? ` · ${p.mark_note}` : ''}`, { wide: true }));
    body.append(dl);
    const acts = (opts.actions ? opts.actions(p) : []).filter(Boolean);
    if (acts.length) {
      const bar = el('div', 'pc-actions');
      for (const a of acts) {
        const b = el('button', a.cls || 'btn ghost sm', a.label);
        b.type = 'button';
        b.onclick = async (e) => { e.stopPropagation(); if (b.disabled) return; b.disabled = true; try { await a.run(p); } finally { b.disabled = false; } };
        bar.append(b);
      }
      body.append(bar);
    }

    const setOpen = (open) => {
      art.classList.toggle('open', open);
      head.setAttribute('aria-expanded', String(open));
      body.hidden = !open;
      if (open) openIds.add(id); else openIds.delete(id);
    };
    setOpen(openIds.has(id));
    head.onclick = () => setOpen(!art.classList.contains('open'));
    art.append(head, body);
    return art;
  }

  function mount(host, opts) {
    const o = { pageSize: 25, mode: 'admin', title: 'All payments', live: true, ...opts };
    const state = { rows: [], total: null, search: '', status: '', time: '', error: null, loading: false, version: 0 };
    const openIds = new Set();
    host.replaceChildren();
    const wrap = el('section', 'card pay-list');
    const top = el('div', 'pl-top');
    const title = el('h3', 'pl-title');
    title.append(el('span', 'pl-dot'), el('span', null, t(o.title)));
    const live = el('span', 'pl-live', t('Live'));
    live.hidden = !o.live;
    const count = el('span', 'pl-count', '…');
    count.setAttribute('role', 'status');
    top.append(title, live, count);

    const search = el('input', 'input pl-search');
    search.type = 'search';
    search.placeholder = t(o.mode === 'admin' ? 'Search invoice ID, email or link' : 'Search invoice ID or link');
    search.setAttribute('aria-label', t('Search payments'));
    const status = el('select', 'input pl-select');
    status.setAttribute('aria-label', t('Status'));
    for (const [v, l] of [['', 'All status'], ['settled', 'Settled'], ['pending', 'Pending'], ['new', 'New'], ['expired', 'Expired'], ['invalid', 'Invalid']]) {
      const op = el('option', null, t(l)); op.value = v; status.append(op);
    }
    const time = el('select', 'input pl-select');
    time.setAttribute('aria-label', t('Time'));
    for (const [v, l] of [['', 'All time'], ['today', 'Today'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days']]) {
      const op = el('option', null, t(l)); op.value = v; time.append(op);
    }
    const filters = el('div', 'pl-filters');
    filters.append(status, time);
    const list = el('div', 'pl-items');
    const more = el('button', 'btn ghost block pl-more', t('Load more'));
    more.type = 'button';
    wrap.append(top, search, filters, list, more);
    host.append(wrap);

    const inWindow = (p) => {
      const days = TIME[state.time];
      if (!days) return true;
      const at = new Date(p.created_at || p.settled_at || 0);
      if (state.time === 'today') return at.toDateString() === new Date().toDateString();
      return Date.now() - at.getTime() <= days * 86400000;
    };

    function draw() {
      const shown = state.rows.filter((p) => (!state.status || String(p.status) === state.status) && inWindow(p));
      list.replaceChildren();
      if (state.error) {
        const e = el('p', 'err', t('Could not load this section. Refresh to try again.'));
        e.setAttribute('role', 'alert');
        list.append(e);
      } else if (!shown.length && !state.loading) {
        list.append(el('p', 'pl-empty', t(state.rows.length ? 'No payments match these filters.' : 'No payments yet.')));
      }
      for (const p of shown) list.append(card(p, o, openIds));
      const total = state.total == null ? state.rows.length : state.total;
      count.textContent = `${shown.length} / ${total.toLocaleString('en-US')}`;
      more.hidden = state.error || state.rows.length >= total || !state.rows.length;
      more.disabled = state.loading;
    }

    async function load(append) {
      const version = ++state.version;
      state.loading = true; draw();
      let res;
      try { res = await o.fetch({ offset: append ? state.rows.length : 0, limit: append ? o.pageSize : Math.max(o.pageSize, state.rows.length || 0), search: state.search || null }); }
      catch (error) { res = { error }; }
      if (version !== state.version) return;
      state.loading = false;
      if (res.error) { if (!append) { state.error = res.error; state.rows = []; } else say(t('Could not load more payments.')); draw(); return; }
      state.error = null;
      const rows = res.rows || [];
      state.rows = append ? state.rows.concat(rows.filter((r) => !state.rows.some((x) => x.id === r.id))) : rows;
      state.total = res.total != null ? Number(res.total) : (rows[0] && rows[0].total_count != null ? Number(rows[0].total_count) : null);
      draw();
    }

    let timer;
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.search = search.value.trim(); load(false); }, 400); });
    status.onchange = () => { state.status = status.value; draw(); };
    time.onchange = () => { state.time = time.value; draw(); };
    more.onclick = () => load(true);

    // Live: re-read the loaded page every 30 s while it is on screen.
    let liveTimer = null;
    if (o.live) {
      liveTimer = setInterval(() => {
        if (!host.isConnected) { clearInterval(liveTimer); return; }
        if (document.hidden || host.closest('[hidden]') || state.loading) return;
        load(false);
      }, 30000);
    }
    // A caller that already read the first page passes it as `initial`.
    if (o.initial) {
      const r = o.initial;
      state.error = r.error || null;
      state.rows = r.error ? [] : (r.rows || []);
      state.total = r.total != null ? Number(r.total) : (state.rows[0] && state.rows[0].total_count != null ? Number(state.rows[0].total_count) : null);
      draw();
    } else load(false);
    return { reload: () => load(false), stop: () => clearInterval(liveTimer) };
  }

  window.cpayPayCards = { mount };
})();
