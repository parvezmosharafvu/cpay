/* Daily accounting views shared by the freelancer and admin desks.
   A business day is the database's (migration 0096): 5:00 PM to 5:00 PM
   Asia/Dhaka, keyed by the date it starts on. Every figure here comes from
   the RPCs; nothing is re-added in the browser except column totals. */
const Daily = (() => {
  const sb = () => window.supabaseClient;
  const TZ = 'Asia/Dhaka';
  const one = (d) => (Array.isArray(d) ? d[0] : d) || null;
  const num = (n) => Number(n || 0);

  function pct(n) {
    if (n == null) return '-';
    return `${Number(n).toFixed(2).replace(/\.?0+$/, '')}%`;
  }
  function rates(list) {
    return list && list.length ? `<span class="rates">${list.map((r) => `<span>${pct(r)}</span>`).join('')}</span>` : '<span class="faint">-</span>';
  }
  // "Thu 24 Sep" in Dhaka time, spelled the same in every browser locale.
  function dhakaDay(ts) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ })
      .formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
    return `${parts.weekday} ${parts.day} ${parts.month}`;
  }
  function dhakaTime(ts) {
    return new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ });
  }
  // "Thu 24 Sep → Fri 25 Sep": the day's two 5 PM edges.
  function dayRange(row) {
    return `${dhakaDay(row.day_start)} → ${dhakaDay(row.day_end)}`;
  }
  function untilText(endIso) {
    const mins = Math.max(0, Math.round((new Date(endIso) - Date.now()) / 60000));
    const h = Math.floor(mins / 60), m = mins % 60;
    return h ? `${h} h ${m} min` : `${m} min`;
  }
  function compactMoney(n) {
    const v = num(n);
    if (v >= 1e6) return `$${(v / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
    if (v >= 1e3) return `$${(v / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
    return `$${v.toFixed(v < 10 && v % 1 ? 2 : 0)}`;
  }
  function roleName(role) {
    return role === 'creator' ? 'Freelancer' : role === 'admin' ? 'Admin' : role || '-';
  }
  function person(name, email) {
    return `<div class="who"><strong>${escapeHtml(name || email || '-')}</strong><span class="faint">${escapeHtml(email || '')}</span></div>`;
  }
  function errorCard(title, error) {
    return `<div class="card"><h3>${escapeHtml(title)}</h3><p class="err">${escapeHtml(error.message || String(error))}</p></div>`;
  }
  function usageBar(used, limit) {
    if (limit == null) return `${num(used)} links <span class="faint">(no limit)</span>`;
    const w = limit ? Math.min(100, Math.round((num(used) / limit) * 100)) : 100;
    return `<div>${num(used)} of ${limit} used</div><div class="usage${num(used) >= limit ? ' full' : ''}" aria-hidden="true"><span style="width:${w}%"></span></div>`;
  }
  function costCell(r) {
    if (r.cost_percent_used_min == null) {
      return r.cost_percent_now == null ? '<span class="faint">-</span>' : `${pct(r.cost_percent_now)}<div class="faint">no payments</div>`;
    }
    const used = num(r.cost_percent_used_min) === num(r.cost_percent_used_max)
      ? pct(r.cost_percent_used_min) : `${pct(r.cost_percent_used_min)} to ${pct(r.cost_percent_used_max)}`;
    const now = r.cost_percent_now != null && num(r.cost_percent_now) !== num(r.cost_percent_used_max)
      ? `<div class="faint">now ${pct(r.cost_percent_now)}</div>` : '';
    return used + now;
  }
  function sum(rows, key) { return rows.reduce((a, r) => a + num(r[key]), 0); }

  /* ---------- profile card ---------- */
  async function profileCard() {
    const { data, error } = await sb().rpc('my_dashboard_profile');
    if (error) return errorCard('Profile', error);
    const p = one(data) || {};
    return `<div class="card profile-card">
      <div class="pc-head"><span class="avatar" aria-hidden="true">${escapeHtml((p.display_name || p.email || '?').trim().charAt(0))}</span>
        <div><h3>${escapeHtml(p.display_name || '')}</h3><div class="muted">${escapeHtml(p.email || '')}</div></div></div>
      <dl class="facts">
        <div><dt>Role</dt><dd>${roleName(p.role)}</dd></div>
        <div><dt>Payment links</dt><dd>${usageBar(p.links_used, p.link_limit)}</dd></div>
        <div><dt>Default cost rate</dt><dd>${pct(p.cost_percent || 0)}</dd></div>
      </dl>
    </div>`;
  }

  /* ---------- today's business day ---------- */
  function bizDayCard(today, extra) {
    if (!today) return '';
    return `<div class="card bizday">
      <div class="kicker">Today's business day</div>
      <div class="bizday-range"><span>${dhakaTime(today.day_start)} ${dhakaDay(today.day_start)}</span> <span>→ ${dhakaTime(today.day_end)} ${dhakaDay(today.day_end)}</span></div>
      <p class="bizday-close"><strong>Today closes at 5:00 PM Bangladesh time</strong> <span class="faint">in ${untilText(today.day_end)}</span></p>
      <dl class="bizday-figs">
        <div><dt>Settled</dt><dd>${money(today.settled)}</dd></div>
        <div><dt>Payments</dt><dd>${num(today.payment_count)}</dd></div>
        <div><dt>${extra && extra.earningsLabel || 'Your earnings'}</dt><dd>${money(today.earnings)}</dd></div>
      </dl>
      <p class="faint">Each day's figures lock at 5:00 PM Dhaka time (UTC+6).</p>
    </div>`;
  }

  /* ---------- daily summary table ---------- */
  function summaryTable(rows, opts = {}) {
    const today = rows[0] && rows[0].business_day;
    const body = rows.map((r) => `<tr data-day="${r.business_day}" class="pick${r.business_day === opts.selected ? ' sel' : ''}" tabindex="0">
      <td><div class="day">${escapeHtml(dayRange(r))}${r.business_day === today ? ' <span class="tag">Today</span>' : ''}</div><div class="faint">5:00 PM to 5:00 PM</div></td>
      <td class="num">${num(r.link_count)}<div class="faint">${num(r.paid_link_count)} paid</div></td>
      <td>${rates(r.cost_rates)}</td>
      <td class="num">${num(r.payment_count)}</td>
      <td class="num">${money(r.settled)}</td>
      <td class="num">${money(r.platform_fee)}</td>
      <td class="num strong">${money(r.earnings)}</td>
    </tr>`).join('');
    const foot = rows.length ? `<tr class="total"><td>${rows.length} days</td><td></td><td></td>
      <td class="num">${sum(rows, 'payment_count')}</td><td class="num">${money(sum(rows, 'settled'))}</td><td class="num">${money(sum(rows, 'platform_fee'))}</td>
      <td class="num strong">${money(sum(rows, 'earnings'))}</td></tr>` : '';
    return `<table class="table daily"><thead><tr><th>Business day</th><th class="num">Links</th><th>Cost rates</th><th class="num">Payments</th><th class="num">Settled</th><th class="num">Platform fee</th><th class="num">Earnings</th></tr></thead>
      <tbody>${body || '<tr><td colspan="7" class="empty">No days yet</td></tr>'}</tbody><tfoot>${foot}</tfoot></table>`;
  }

  /* ---------- per-link breakdown ---------- */
  function linkTable(rows) {
    const shown = rows.filter((r) => r.link_id || num(r.payment_count));
    const body = shown.map((r) => `<tr>
      <td>${r.link_id ? `<strong>${escapeHtml(r.link_name || r.slug)}</strong><div class="faint mono">/${escapeHtml(r.slug || '')}</div>` : '<span class="faint">No link (store or direct)</span>'}</td>
      <td>${r.link_id ? (r.deleted_at ? badge('deleted') : badge(r.is_active ? 'live' : 'off')) : ''}</td>
      <td>${costCell(r)}</td>
      <td class="num">${num(r.payment_count)}</td>
      <td class="num">${money(r.settled)}</td>
      <td class="num">${money(r.platform_fee)}</td>
      <td class="num strong">${money(r.earnings)}</td>
    </tr>`).join('');
    const foot = shown.length > 1 ? `<tr class="total"><td>${shown.length} links</td><td></td><td></td><td class="num">${sum(shown, 'payment_count')}</td>
      <td class="num">${money(sum(shown, 'settled'))}</td><td class="num">${money(sum(shown, 'platform_fee'))}</td><td class="num strong">${money(sum(shown, 'earnings'))}</td></tr>` : '';
    return `<table class="table"><thead><tr><th>Link</th><th>Status</th><th>Cost rate</th><th class="num">Payments</th><th class="num">Settled</th><th class="num">Platform fee</th><th class="num">Earnings</th></tr></thead>
      <tbody>${body || '<tr><td colspan="7" class="empty">No links that day</td></tr>'}</tbody><tfoot>${foot}</tfoot></table>`;
  }
  function linkCard(title, sub, rows) {
    return `<div class="card flush drill"><div class="card-head"><div><h3>${title}</h3><div class="faint">${sub}</div></div></div><div class="scroll">${linkTable(rows)}</div></div>`;
  }

  // Clicking or pressing Enter on a row with data-day (or data-user) calls pick.
  function bindRows(root, attr, pick) {
    root.querySelectorAll(`tr[data-${attr}]`).forEach((tr) => {
      const go = () => pick(tr.dataset[attr], tr);
      tr.onclick = go;
      tr.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
    });
  }
  function markSelected(root, attr, value) {
    root.querySelectorAll(`tr[data-${attr}]`).forEach((tr) => tr.classList.toggle('sel', tr.dataset[attr] === value));
  }

  /* ---------- the caller's own book (freelancer) ---------- */
  async function mountSelf(el, opts = {}) {
    const days = 14;
    const [card, sumRes, linkRes] = await Promise.all([
      profileCard(),
      sb().rpc('my_daily_summary', { p_days: days }),
      sb().rpc('daily_link_breakdown', { p_days: days }),
    ]);
    if (sumRes.error) { el.innerHTML = card + (opts.between || '') + errorCard('Daily summary', sumRes.error); return; }
    const rows = sumRes.data || [];
    const links = linkRes.error ? [] : linkRes.data || [];
    el.innerHTML = `<div class="grid split">${card}${bizDayCard(rows[0])}</div>${opts.between || ''}
      <div class="card flush"><div class="card-head"><div><h3>Last ${days} business days</h3><div class="faint">Select a day to see each link.</div></div></div>
        <div class="scroll" id="dailySelfTable">${summaryTable(rows, { selected: rows[0] && rows[0].business_day })}</div></div>
      <div id="dailySelfLinks"></div>`;
    const drill = el.querySelector('#dailySelfLinks');
    const show = (day) => {
      const r = rows.find((x) => x.business_day === day);
      if (!r) return;
      markSelected(el, 'day', day);
      drill.innerHTML = linkRes.error ? errorCard('Links', linkRes.error)
        : linkCard(`Links on ${escapeHtml(dayRange(r))}`, 'Cost rate is the rate charged on that day\'s payments.', links.filter((l) => l.business_day === day));
    };
    bindRows(el, 'day', (day) => { show(day); drill.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
    if (rows[0]) show(rows[0].business_day);
  }

  /* ---------- admin: graph ---------- */
  function chart(rows, width) {
    const W = Math.max(320, Math.round(width || 760)), padL = 52, padR = 12, top = 16, h1 = 150, gap = 34, h2 = 90, bottom = 26;
    const H = top + h1 + gap + h2 + bottom;
    const n = rows.length || 1;
    const bw = (W - padL - padR) / n;
    const maxS = Math.max(1, ...rows.map((r) => num(r.settled)));
    const maxF = Math.max(0.01, ...rows.map((r) => Math.max(num(r.platform_fee), num(r.withdrawal_fee_revenue))));
    const y1 = (v) => top + h1 - (num(v) / maxS) * h1;
    const top2 = top + h1 + gap;
    const y2 = (v) => top2 + h2 - (num(v) / maxF) * h2;
    const cx = (i) => padL + bw * i + bw / 2;
    const grid = (y, label) => `<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" class="gl"/><text x="${padL - 6}" y="${y + 4}" class="ax" text-anchor="end">${label}</text>`;
    const g1 = [0, 0.5, 1].map((f) => grid(top + h1 - f * h1, compactMoney(maxS * f))).join('');
    const g2 = [0, 1].map((f) => grid(top2 + h2 - f * h2, compactMoney(maxF * f))).join('');
    const bars = rows.map((r, i) => {
      const y = y1(r.settled);
      return `<rect x="${padL + bw * i + bw * 0.15}" y="${y}" width="${Math.max(1, bw * 0.7)}" height="${top + h1 - y}" rx="${Math.min(3, bw * 0.2)}" class="bar"/>`;
    }).join('');
    const line = (key, cls) => `<polyline class="${cls}" points="${rows.map((r, i) => `${cx(i)},${y2(r[key])}`).join(' ')}"/>`
      + (n <= 31 ? rows.map((r, i) => `<circle class="${cls}-dot" cx="${cx(i)}" cy="${y2(r[key])}" r="2.5"/>`).join('') : '');
    // A '24 Sep' label needs about 50px, so thin the labels out on narrow screens.
    const every = Math.max(Math.ceil(n / 8), Math.ceil(50 / bw));
    const labels = rows.map((r, i) => ((n - 1 - i) % every === 0
      ? `<text x="${cx(i) + 20 > W ? W - 2 : cx(i)}" y="${H - 8}" class="ax" text-anchor="${cx(i) + 20 > W ? 'end' : 'middle'}">${escapeHtml(dhakaDay(r.day_start).replace(/^\w+ /, ''))}</text>` : '')).join('');
    const hits = rows.map((r, i) => `<rect x="${padL + bw * i}" y="${top}" width="${bw}" height="${h1 + gap + h2}" class="hit"><title>${escapeHtml(dayRange(r))} (closes 5 PM)
Settled ${money(r.settled)} · ${num(r.payment_count)} payments
Platform fee ${money(r.platform_fee)}
Withdrawal fee revenue ${money(r.withdrawal_fee_revenue)}</title></rect>`).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Settled per business day, with platform fee and withdrawal fee revenue">
      <text x="${padL}" y="${top - 4}" class="ax strong">Settled</text>${g1}${bars}
      <text x="${padL}" y="${top2 - 6}" class="ax strong">Fees</text>${g2}${line('platform_fee', 'fee')}${line('withdrawal_fee_revenue', 'wfee')}
      ${labels}${hits}</svg>`;
  }

  /* ---------- admin: graph + per-freelancer table + link drill-down ---------- */
  async function mountAdmin(el, people) {
    const state = { range: 30, user: '', day: null };
    const freelancers = (people || []).filter((p) => p.role !== 'admin');
    const opt = (p) => `<option value="${p.id}">${escapeHtml(p.display_name || p.email)} · ${escapeHtml(p.email)}</option>`;
    el.innerHTML = `<div class="card">
        <div class="card-head wrap">
          <div><h3>Daily earnings</h3><div class="faint">Each bar is one business day, 5:00 PM to 5:00 PM Bangladesh time, labelled by the date it starts. The last bar is today and still open.</div></div>
          <div class="row" role="group" aria-label="Range">${[7, 30, 90].map((d) => `<button type="button" class="pill${d === state.range ? ' active' : ''}" data-range="${d}">${d} days</button>`).join('')}</div>
        </div>
        <div class="filters">
          <div class="field"><label for="dFreelancer">Freelancer</label><select id="dFreelancer"><option value="">Everyone</option>${freelancers.map(opt).join('')}</select></div>
        </div>
        <div id="dTotals" class="totals"></div>
        <div id="dChart" class="chart-wrap"></div>
        <div class="legend"><span><i class="k bar"></i>Settled</span><span><i class="k fee"></i>Platform fee on payments</span><span><i class="k wfee"></i>Withdrawal fee revenue</span></div>
      </div>
      <div class="card flush"><div class="card-head wrap">
          <div><h3>Freelancers by business day</h3><div class="faint">Select a row to see that person's links.</div></div>
          <div class="field inline"><label for="dDay">Day</label><select id="dDay"></select></div>
        </div><div class="scroll" id="dTable"></div></div>
      <div id="dLinks"></div>`;
    const $$ = (s) => el.querySelector(s);
    let summary = [];
    let redraw = null;
    const linkCache = {};
    window.addEventListener('resize', () => { if (redraw) redraw(); });

    async function load() {
      const args = { p_days: state.range, p_user_id: state.user || null };
      $$('#dChart').innerHTML = '<p class="muted">Loading…</p>';
      const [ts, sm] = await Promise.all([
        sb().rpc('admin_daily_timeseries', args),
        sb().rpc('admin_daily_summary', { ...args, p_days: Math.min(state.range, 60) }),
      ]);
      if (ts.error) { $$('#dChart').innerHTML = `<p class="err">${escapeHtml(ts.error.message)}</p>`; }
      else {
        const s = ts.data || [];
        const draw = () => { $$('#dChart').innerHTML = chart(s, $$('#dChart').clientWidth); };
        draw();
        redraw = draw;
        $$('#dTotals').innerHTML = [
          ['Settled', money(sum(s, 'settled'))], ['Payments', sum(s, 'payment_count')],
          ['Platform fee', money(sum(s, 'platform_fee'))], ['Withdrawal fees', money(sum(s, 'withdrawal_fee_revenue'))],
          ['Freelancer earnings', money(sum(s, 'earnings'))],
        ].map(([k, v]) => `<div><div class="kicker">${k}</div><div class="kpi sm">${v}</div></div>`).join('');
      }
      if (sm.error) { $$('#dTable').innerHTML = `<p class="err" style="padding:16px">${escapeHtml(sm.error.message)}</p>`; return; }
      summary = sm.data || [];
      const dayRows = [...new Map(summary.map((r) => [r.business_day, r])).values()].sort((a, b) => (a.business_day < b.business_day ? 1 : -1));
      if (!dayRows.some((r) => r.business_day === state.day)) state.day = dayRows[0] && dayRows[0].business_day;
      $$('#dDay').innerHTML = dayRows.map((r, i) => `<option value="${r.business_day}"${r.business_day === state.day ? ' selected' : ''}>${escapeHtml(dayRange(r))}${i === 0 ? ' (today)' : ''}</option>`).join('')
        || '<option>No activity</option>';
      drawTable();
    }
    function drawTable() {
      const list = summary.filter((r) => r.business_day === state.day);
      const body = list.map((r) => `<tr data-user="${r.user_id}" class="pick" tabindex="0">
        <td>${person(r.display_name, r.email)}<div class="faint">${roleName(r.role)}${r.account_status !== 'active' ? ` · ${escapeHtml(r.account_status)}` : ''}</div></td>
        <td class="num">${num(r.link_count)}<div class="faint">limit ${r.max_payment_links ?? '-'}</div></td>
        <td>${rates(r.cost_rates)}</td>
        <td class="num">${num(r.payment_count)}</td>
        <td class="num">${money(r.settled)}</td>
        <td class="num">${money(r.platform_fee)}</td>
        <td class="num strong">${money(r.earnings)}</td>
      </tr>`).join('');
      const foot = list.length ? `<tr class="total"><td>${list.length} people</td><td class="num">${sum(list, 'link_count')}</td><td></td><td class="num">${sum(list, 'payment_count')}</td>
        <td class="num">${money(sum(list, 'settled'))}</td><td class="num">${money(sum(list, 'platform_fee'))}</td><td class="num strong">${money(sum(list, 'earnings'))}</td></tr>` : '';
      $$('#dTable').innerHTML = `<table class="table"><thead><tr><th>Freelancer</th><th class="num">Links</th><th>Cost rates</th><th class="num">Payments</th><th class="num">Settled</th><th class="num">Platform fee</th><th class="num">Earnings</th></tr></thead>
        <tbody>${body || '<tr><td colspan="7" class="empty">Nobody had links or payments that day</td></tr>'}</tbody><tfoot>${foot}</tfoot></table>`;
      bindRows($$('#dTable'), 'user', openLinks);
      $$('#dLinks').innerHTML = '';
    }
    async function openLinks(uid) {
      markSelected($$('#dTable'), 'user', uid);
      const r = summary.find((x) => x.user_id === uid && x.business_day === state.day) || {};
      const drill = $$('#dLinks');
      drill.innerHTML = '<div class="card"><p class="muted">Loading links…</p></div>';
      const key = `${uid}:${Math.min(state.range, 60)}`;
      if (!linkCache[key]) {
        const res = await sb().rpc('daily_link_breakdown', { p_days: Math.min(state.range, 60), p_user_id: uid });
        if (res.error) { drill.innerHTML = errorCard('Links', res.error); return; }
        linkCache[key] = res.data || [];
      }
      drill.innerHTML = linkCard(`${escapeHtml(r.display_name || r.email || '')} · links on ${escapeHtml(dayRange(r))}`,
        escapeHtml(r.email || ''),
        linkCache[key].filter((l) => l.business_day === state.day));
      drill.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    el.querySelectorAll('[data-range]').forEach((b) => {
      b.onclick = () => {
        state.range = Number(b.dataset.range);
        el.querySelectorAll('[data-range]').forEach((x) => x.classList.toggle('active', x === b));
        load();
      };
    });
    $$('#dFreelancer').onchange = (e) => { state.user = e.target.value; load(); };
    $$('#dDay').onchange = (e) => { state.day = e.target.value; drawTable(); };
    await load();
  }

  return { mountSelf, mountAdmin, chart, pct, dayRange };
})();
