// Display currency, one choice per signed-in user, picked in the desk top bar.
// Display only: amounts are stored and charged in USD; this converts what the
// page shows with the latest wallet rates (USD when no rate is known yet).
// Saved per user in this browser and in the user's own auth metadata, so it
// follows the user to another device.
(function () {
  'use strict';
  const KEY = 'cpay-currency';
  const RATES_KEY = 'cpay-currency-rates';
  const BASE = [
    { id: 'USD', name: 'US Dollar' }, { id: 'BDT', name: 'Bangladeshi Taka' }, { id: 'EUR', name: 'Euro' },
    { id: 'GBP', name: 'British Pound' }, { id: 'INR', name: 'Indian Rupee' },
  ];
  const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } };
  let uid = null;
  let code = read(KEY, 'USD');
  let rates = read(RATES_KEY, []); // [{id,name,btcRate}]
  if (typeof code !== 'string') code = 'USD';

  const rateOf = (id) => rates.find((c) => c.id === id)?.btcRate;
  function usdTo(usd) {
    if (code === 'USD') return { value: usd, code: 'USD' };
    const r = rateOf(code); const u = rateOf('USD');
    if (!r || !u) return { value: usd, code: 'USD' };
    return { value: usd * (r / u), code };
  }
  function format(usd) {
    const { value, code: c } = usdTo(Number(usd ?? 0));
    if (c === 'USD') return '$' + value.toFixed(2);
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: c, maximumFractionDigits: 2 }).format(value); }
    catch (e) { return `${value.toFixed(2)} ${c}`; }
  }
  function list() {
    const seen = new Map(BASE.map((c) => [c.id, c]));
    for (const c of rates) seen.set(c.id, c);
    return [...seen.values()];
  }
  function paint() {
    document.querySelectorAll('select.currency-switch').forEach((s) => {
      s.replaceChildren(...list().map((c) => {
        const o = document.createElement('option'); o.value = c.id; o.textContent = c.id;
        o.title = c.name || c.id; o.disabled = c.id !== 'USD' && !c.btcRate; return o;
      }));
      s.value = code;
    });
  }
  function set(next, { save = true } = {}) {
    code = String(next || 'USD').toUpperCase();
    write(KEY, code);
    paint();
    document.dispatchEvent(new CustomEvent('cpay:currency', { detail: { code } }));
    if (save && uid && window.supabaseClient?.auth?.updateUser) {
      // Desk amounts are drawn once, so redraw the page in the new currency.
      Promise.resolve(window.supabaseClient.auth.updateUser({ data: { display_currency: code } }))
        .catch(() => {}).finally(() => location.reload());
    }
  }
  function setRates(list2) {
    if (!Array.isArray(list2)) return;
    rates = list2.filter((c) => c && c.id).map((c) => ({ id: c.id, name: c.name, btcRate: c.btcRate || null }));
    write(RATES_KEY, rates);
    paint();
    document.dispatchEvent(new CustomEvent('cpay:currency', { detail: { code } }));
  }
  function addSwitch() {
    const top = document.querySelector('.app-top');
    if (!top || top.querySelector('.currency-switch')) return;
    const s = document.createElement('select');
    s.className = 'currency-switch';
    s.setAttribute('aria-label', 'Display currency');
    s.dataset.noI18n = '';
    s.onchange = () => set(s.value);
    const anchor = top.querySelector('.lang-switch') || top.querySelector('.me-chip');
    top.insertBefore(s, anchor || null);
    paint();
  }
  async function loadUser() {
    try {
      const { data } = await window.supabaseClient.auth.getUser();
      uid = data?.user?.id || null;
      const saved = data?.user?.user_metadata?.display_currency;
      if (saved && saved !== code) set(saved, { save: false });
    } catch (e) { /* signed out */ }
  }
  window.cpayCurrency = { get: () => code, set, setRates, format, usdTo, list };
  const start = () => { addSwitch(); if (window.supabaseClient) loadUser(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
