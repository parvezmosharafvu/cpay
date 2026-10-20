// Admin → System guide (সিস্টেম গাইড). Loads public/admin-guide-bn.html, built
// from docs/SYSTEM-GUIDE-BN.md by scripts/build-admin-guide.mjs, only after
// is_admin() says yes. The guide holds no secrets. The optional status card
// reuses owner-config GET (names only, aal2) and shows configured yes/no;
// values are never requested or shown. No globals.
(function () {
  'use strict';
  const client = window.supabaseClient;
  const EXPECTED = [
    'PAYMENT_SERVICE_URL', 'CRON_SECRET', 'BREEZ_API_KEY',
    'BREEZ_NETWORK', 'BREEZ_DB_URL', 'TURNSTILE_SECRET_KEY', 'TURNSTILE_MODE', 'ALERT_TELEGRAM_BOT_TOKEN',
    'ALERT_TELEGRAM_CHAT_ID', 'ALERT_WEBHOOK_URL', 'GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO',
    'CPAY_SUPABASE_ACCESS_TOKEN', 'CPAY_CLOUDFLARE_API_TOKEN', 'CPAY_CLOUDFLARE_ACCOUNT_ID', 'CPAY_CLOUDFLARE_ZONE_ID',
  ];
  let loaded = false;
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

  async function status(box) {
    box.replaceChildren(el('p', 'faint', 'Secret-এর অবস্থা দেখা হচ্ছে…'));
    let data = null;
    try { const r = await client.functions.invoke('owner-config', { method: 'GET' }); if (!r.error) data = r.data; } catch (e) { data = null; }
    if (!data || !data.supabase || !data.supabase.ready) {
      box.replaceChildren(el('p', 'faint', 'Secret-এর অবস্থা এখন দেখা যাচ্ছে না (passkey দিয়ে আবার sign in করুন, বা CPAY_SUPABASE_ACCESS_TOKEN নেই)।'));
      return;
    }
    const have = new Set([...(data.supabase.secrets || []), ...((data.cloudflare && data.cloudflare.secrets) || [])]);
    const list = el('div', 'guide-badges');
    for (const name of EXPECTED) {
      const on = have.has(name);
      const b = el('span', 'badge ' + (on ? 'ok' : 'warn'));
      b.append(el('code', null, name), document.createTextNode(on ? ' ✓ আছে' : ' ✗ নেই'));
      list.append(b);
    }
    box.replaceChildren(el('h3', null, 'এখনকার অবস্থা (শুধু আছে / নেই)'), el('p', 'faint', 'মান কখনো দেখানো হয় না। ঐচ্ছিক secret "নেই" দেখালেও সমস্যা নয়।'), list);
  }

  async function render() {
    const host = document.getElementById('guide');
    if (!host || !client || loaded) return;
    const { data: ok, error } = await client.rpc('is_admin');
    if (error || ok !== true) { host.replaceChildren(el('p', 'err', 'শুধু admin এই গাইড দেখতে পারেন।')); return; }
    host.replaceChildren(el('p', 'faint', 'লোড হচ্ছে…'));
    const res = await fetch('/admin-guide-bn.html', { credentials: 'same-origin', cache: 'no-cache' });
    if (!res.ok) { host.replaceChildren(el('p', 'err', 'গাইড লোড হয়নি। পেজ রিলোড করুন।')); return; }
    const html = await res.text();
    const tpl = document.createElement('template');
    tpl.innerHTML = html;  // our own generated file, same origin; no scripts in it
    tpl.content.querySelectorAll('script').forEach((s) => s.remove());
    const box = el('div', 'card guide-status');
    const card = el('div', 'card guide');
    card.append(tpl.content);
    host.replaceChildren(box, card);
    loaded = true;
    card.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[href^="#guide-"]');
      if (!a) return;
      e.preventDefault();
      const t = document.getElementById(a.getAttribute('href').slice(1));
      if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    status(box);
  }
  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('.navi[data-tab="guide"]')) setTimeout(render, 0);
  });
  window.addEventListener('hashchange', () => { if (location.hash === '#guide') render(); });
  if (location.hash === '#guide') setTimeout(render, 0);
})();
