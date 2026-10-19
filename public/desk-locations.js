// Locations and payment details on the Freelancer desk (20261020070000).
// Coarse only: country / division / district / area the user types, the
// country Cloudflare reports for the request, and the payer's country,
// region and city recorded server-side. Uses app.js helpers (escapeHtml,
// money, when, badge, toast, deskError).
(function () {
  const sb = () => window.supabaseClient;
  const CODES = ('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' ');
  const BD_DIVISIONS = ['Barishal', 'Chattogram', 'Dhaka', 'Khulna', 'Mymensingh', 'Rajshahi', 'Rangpur', 'Sylhet'];
  let names = null;
  try { names = new Intl.DisplayNames(['en'], { type: 'region' }); } catch (e) { names = null; }
  const countryName = (c) => { if (!c) return ''; try { return (names && names.of(c)) || c; } catch (e) { return c; } };
  const place = (...parts) => parts.filter(Boolean).map(String).join(', ');

  // Profile: where the account is based. Optional; only the user and the admin see it.
  async function profileCard(el) {
    if (!el) return;
    const { data, error } = await sb().rpc('my_location');
    if (error) { el.innerHTML = deskError(error.message); return; }
    const l = data || {};
    const opts = '<option value="">Not set</option>' + CODES
      .map((c) => [c, countryName(c)]).sort((a, b) => a[1].localeCompare(b[1]))
      .map(([c, n]) => `<option value="${c}" ${l.country === c ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('');
    el.innerHTML = `<div class="card" id="locationCard">
      <h3>Your location</h3>
      <p class="hint">Optional. Helps CPAY support you in your area. Only you and CPAY admins see it. Not shown to payers.</p>
      <div class="field"><label for="locCountry">Country</label><select id="locCountry">${opts}</select></div>
      <div class="field"><label for="locDivision">Division / state</label><input id="locDivision" list="locDivisions" maxlength="80" value="${escapeHtml(l.division || '')}" autocomplete="address-level1"></div>
      <datalist id="locDivisions">${BD_DIVISIONS.map((d) => `<option value="${d}">`).join('')}</datalist>
      <div class="field"><label for="locDistrict">District / city</label><input id="locDistrict" maxlength="80" value="${escapeHtml(l.district || '')}" autocomplete="address-level2"></div>
      <div class="field"><label for="locArea">Area</label><input id="locArea" maxlength="80" value="${escapeHtml(l.area || '')}" autocomplete="off"></div>
      <p class="faint" id="locSeen">${l.last_seen_country ? `Last signed in from: ${escapeHtml(countryName(l.last_seen_country))} (country only, from your connection)` : ''}</p>
      <button class="btn ghost" id="saveLoc" type="button">Save location</button>
    </div>`;
    el.querySelector('#saveLoc').onclick = async () => {
      const { error: e } = await sb().rpc('set_my_location', {
        p_country: el.querySelector('#locCountry').value || null,
        p_division: el.querySelector('#locDivision').value,
        p_district: el.querySelector('#locDistrict').value,
        p_area: el.querySelector('#locArea').value,
      });
      if (e) return toast(e.message);
      toast('Location saved', true);
    };
  }

  // Links tab: an optional area for a link, for the owner's own records.
  function bindLinkArea(root, onChange) {
    root.querySelectorAll('[data-link-area]').forEach((btn) => {
      btn.onclick = async () => {
        const raw = window.prompt('Area for this link (for example "Dhanmondi, Dhaka"). Leave empty to clear.', btn.dataset.cur || '');
        if (raw === null) return;
        const v = raw.replace(/\s+/g, ' ').trim().slice(0, 80);
        const { error } = await sb().from('payment_links').update({ location_label: v || null }).eq('id', btn.dataset.linkArea);
        if (error) return toast(error.message);
        toast(v ? 'Area saved' : 'Area cleared', true);
        if (onChange) onChange();
      };
    });
  }

  // Payment details: one dialog, the owner's own payment only (the RPC is
  // SECURITY INVOKER, so row-level security decides).
  let dlg = null;
  function dialog() {
    if (dlg) return dlg;
    dlg = document.createElement('dialog');
    dlg.id = 'payDetails';
    dlg.className = 'pay-details';
    dlg.setAttribute('aria-labelledby', 'payDetailsTitle');
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    document.body.appendChild(dlg);
    return dlg;
  }
  const row = (k, v, cls) => (v === null || v === undefined || v === '') ? '' : `<div class="pd-row${cls ? ' ' + cls : ''}"><dt>${escapeHtml(k)}</dt><dd>${v}</dd></div>`;
  const FORWARD = { queued: 'Waiting to send', sending: 'Sending', forwarded: 'Sent to you', retry: 'Retrying', owed: 'Held, owed to you', skipped: 'Not forwarded' };
  async function openPayment(id) {
    const d = dialog();
    d.innerHTML = `<div class="pd-head"><h3 id="payDetailsTitle">Payment details</h3><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div><p class="muted">Loading…</p>`;
    d.querySelector('[data-close]').onclick = () => d.close();
    if (!d.open) { try { d.showModal(); } catch (e) { d.setAttribute('open', ''); } }
    const { data: p, error } = await sb().rpc('get_my_payment_details', { p_payment_id: id });
    if (error || !p) {
      d.querySelector('p').outerHTML = deskError(error ? error.message : 'This payment is not available.');
      return;
    }
    const f = p.forward;
    const fees = [
      row(`Platform fee${Number(p.platform_fee_percent) ? ` (${Number(p.platform_fee_percent)}%)` : ''}`, p.platform_fee_amount != null ? '-' + money(p.platform_fee_amount) : null),
      row('Network fee', p.network_fee_usd != null ? '-' + money(p.network_fee_usd) : null),
    ].join('');
    d.innerHTML = `<div class="pd-head"><h3 id="payDetailsTitle">Payment details</h3><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
      <div class="pd-amount"><div class="kicker">You receive</div><div class="kpi" id="pdReceive">${p.you_receive != null ? money(p.you_receive) : '—'}</div>${badge(p.status)}</div>
      <dl class="pd-list">
        ${row('Amount paid', money(p.amount_settled ?? p.amount_requested))}
        ${p.buyer_amount != null && Number(p.buyer_amount) !== Number(p.amount_requested) ? row('Before link cost', money(p.buyer_amount)) : ''}
        ${fees}
        ${row('Status', escapeHtml(p.status))}
        ${row('Created', escapeHtml(when(p.created_at)))}
        ${row('Settled', p.settled_at ? escapeHtml(when(p.settled_at)) : null)}
        ${row('Link', p.link_slug ? `/${escapeHtml(p.link_slug)}${p.link_name ? ' · ' + escapeHtml(p.link_name) : ''}` : null)}
        ${row('Link area', p.link_location ? escapeHtml(p.link_location) : null)}
        ${row('Payer location', escapeHtml(place(p.payer_city, p.payer_region, countryName(p.payer_country))) || 'Unknown')}
        ${f ? row('Forward', escapeHtml((FORWARD[f.status] || f.status) + (f.kind === 'usdt' ? ` · USDT${f.network ? ' on ' + f.network : ''}` : ' · Lightning') + (f.reason ? ` (${f.reason})` : ''))) : ''}
        ${f && f.forwarded_at ? row('Sent', escapeHtml(when(f.forwarded_at))) : ''}
        ${row('Reference', p.invoice_ref ? `<code>${escapeHtml(p.invoice_ref)}</code>` : null)}
      </dl>
      <p class="faint">Payer location is approximate (country, region, city from the connection). CPAY does not record exact positions.</p>`;
    d.querySelector('[data-close]').onclick = () => d.close();
  }
  function bindPaymentRows(root) {
    root.querySelectorAll('[data-pay-id]').forEach((n) => {
      n.onclick = () => openPayment(n.dataset.payId);
      n.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPayment(n.dataset.payId); } };
    });
  }

  function touch() { sb().rpc('touch_my_last_seen').then(() => {}, () => {}); }

  window.cpayLoc = { countryName, place, profileCard, bindLinkArea, openPayment, bindPaymentRows, touch };
})();
