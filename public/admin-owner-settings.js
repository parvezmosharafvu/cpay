// Admin → Settings, the simple owner sections (Bangla + English):
//   #ownerFeatures  on/off switches (admin_set_platform_setting: aal2, audited)
//   #ownerDomains   site domains (admin_save_domain / admin_remove_domain: aal2, audited)
//   #ownerSecrets   Supabase and Cloudflare Worker secrets, write-only
//   #ownerCloudflare  "Always Use HTTPS"
// Secrets and Cloudflare go through the owner-config Edge Function: values are
// sent once and never shown again; a change asks for a fresh sign-in.
// Text is built with DOM nodes and textContent. No globals.
(function () {
  'use strict';
  const client = window.supabaseClient;
  const bn = () => window.cpayI18n?.lang === 'bn';
  const L = (en, b) => (bn() ? b : en);

  function node(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'text') n.textContent = v;
      else if (k === 'on') Object.entries(v).forEach(([ev, fn]) => n.addEventListener(ev, fn));
      else n.setAttribute(k, v === true ? '' : v);
    }
    kids.flat().forEach((k) => k != null && n.append(k));
    return n;
  }
  const card = (id, title, intro, ...body) => node('div', { class: 'card owner-card', id },
    node('h3', { text: title }), intro ? node('p', { class: 'muted', text: intro }) : null, ...body);
  const status = () => node('p', { class: 'faint', role: 'status' });
  function say(el, text, ok) { el.textContent = text; el.className = ok === true ? 'ok' : ok === false ? 'err' : 'faint'; }

  // ---- Features -------------------------------------------------------------
  const FEATURES = [
    ['legal_published', 'Publish the legal pages (needs every legal field filled in)', 'আইনি পাতাগুলো প্রকাশ (সব আইনি তথ্য পূরণ করা লাগবে)'],
  ];
  async function renderFeatures() {
    const host = document.getElementById('ownerFeatures');
    if (!host) return;
    const { data, error } = await client.rpc('admin_platform_settings');
    const rows = Object.fromEntries((data || []).map((r) => [r.key, r]));
    const list = node('div', { class: 'owner-list' });
    for (const [key, en, b] of FEATURES) {
      const r = rows[key];
      if (!r) continue;
      const st = status();
      const on = r.value === true;
      const sw = node('input', { type: 'checkbox', role: 'switch', checked: on, 'aria-label': L(en, b) });
      sw.addEventListener('change', async () => {
        const want = sw.checked;
        if (r.dangerous && !window.confirm(L(`${en}: turn ${want ? 'on' : 'off'}? This is recorded in the audit log.`,
          `${b}: ${want ? 'চালু' : 'বন্ধ'} করবেন? এটি অডিট লগে লেখা থাকবে।`))) { sw.checked = !want; return; }
        say(st, L('Saving…', 'সংরক্ষণ হচ্ছে…'));
        const { error: e } = await client.rpc('admin_set_platform_setting', { p_key: key, p_value: want });
        if (e) { sw.checked = !want; say(st, e.message, false); return; }
        say(st, want ? L('On', 'চালু') : L('Off', 'বন্ধ'), true);
      });
      list.append(node('label', { class: 'owner-row' }, sw,
        node('span', null, node('strong', { text: L(en, b) }), st)));
    }
    host.replaceChildren(card('ownerFeaturesCard', L('Features (on/off)', 'ফিচার চালু/বন্ধ'),
      L('Each switch takes effect right away for everyone. Two-step sign-in is needed.', 'প্রতিটি সুইচ সঙ্গে সঙ্গে সবার জন্য কাজ করে। দুই ধাপের সাইন-ইন লাগবে।'),
      error ? node('p', { class: 'err', text: error.message }) : list));
  }

  // ---- Domains --------------------------------------------------------------
  const PURPOSE = { both: ['Payment links and site', 'পেমেন্ট লিংক ও সাইট'], payment: ['Payment links only', 'শুধু পেমেন্ট লিংক'], site: ['Site only', 'শুধু সাইট'] };
  async function renderDomains() {
    const host = document.getElementById('ownerDomains');
    if (!host) return;
    const { data, error } = await client.from('site_domains').select('hostname, purpose, is_active, is_primary_site').order('sort_order');
    const st = status();
    const run = async (fn, okText) => { say(st, L('Saving…', 'সংরক্ষণ হচ্ছে…')); const { error: e } = await fn(); if (e) say(st, e.message, false); else { await renderDomains(); } return !e && okText; };
    const body = node('tbody');
    for (const d of data || []) {
      const actions = d.is_primary_site ? node('span', { class: 'faint', text: L('Main site', 'মূল সাইট') }) : node('span', null,
        node('button', { class: 'btn ghost sm', type: 'button', text: d.is_active ? L('Turn off', 'বন্ধ করুন') : L('Turn on', 'চালু করুন'),
          on: { click: () => run(() => client.rpc('admin_save_domain', { p_hostname: d.hostname, p_purpose: d.purpose, p_active: !d.is_active })) } }), ' ',
        node('button', { class: 'btn ghost sm', type: 'button', text: L('Remove', 'সরিয়ে দিন'),
          on: { click: () => window.confirm(L(`Remove ${d.hostname}? Payment links and sign-in on it stop working.`, `${d.hostname} সরাবেন? এর পেমেন্ট লিংক ও সাইন-ইন আর কাজ করবে না।`))
            && run(() => client.rpc('admin_remove_domain', { p_hostname: d.hostname })) } }));
      body.append(node('tr', null, node('td', { class: 'mono', text: d.hostname }),
        node('td', { text: L(...(PURPOSE[d.purpose] || [d.purpose, d.purpose])) }),
        node('td', { text: d.is_active ? L('On', 'চালু') : L('Off', 'বন্ধ') }), node('td', { class: 'num' }, actions)));
    }
    if (!(data || []).length) body.append(node('tr', null, node('td', { colspan: '4', class: 'empty', text: L('No domains yet', 'এখনো কোনো ডোমেইন নেই') })));
    const host_ = node('input', { id: 'odHost', placeholder: 'pay.example.com', autocomplete: 'off', spellcheck: 'false', 'aria-label': L('Domain', 'ডোমেইন') });
    const purpose = node('select', { id: 'odPurpose', 'aria-label': L('Purpose', 'কাজ') },
      ...Object.entries(PURPOSE).map(([v, [en, b]]) => node('option', { value: v, text: L(en, b) })));
    const add = node('button', { class: 'btn primary sm', type: 'button', text: L('Add domain', 'ডোমেইন যোগ করুন'),
      on: { click: () => run(() => client.rpc('admin_save_domain', { p_hostname: host_.value, p_purpose: purpose.value, p_active: true })) } });
    host.replaceChildren(card('ownerDomainsCard', L('Domains', 'ডোমেইন'),
      L('Sites that may use CPAY: payment links and sign-in work only on domains that are on here. Point the domain to the site in Cloudflare first.',
        'যেসব সাইট CPAY ব্যবহার করতে পারবে: এখানে চালু থাকা ডোমেইনেই শুধু পেমেন্ট লিংক ও সাইন-ইন কাজ করে। আগে Cloudflare-এ ডোমেইনটি সাইটের দিকে সেট করুন।'),
      error ? node('p', { class: 'err', text: error.message }) : node('div', { class: 'card flush' }, node('table', { class: 'table' },
        node('thead', null, node('tr', null, ...[L('Domain', 'ডোমেইন'), L('Purpose', 'কাজ'), L('Status', 'অবস্থা'), ''].map((h) => node('th', { text: h })))), body)),
      node('div', { class: 'row owner-add' }, host_, purpose, add), st));
  }

  // ---- Secrets and Cloudflare (owner-config) -------------------------------
  // What each known secret is for, so the owner knows what a change affects.
  const KNOWN = {
    CRON_SECRET: ['Scheduled jobs ↔ wallet. Change it only together with the same value in the database jobs.', 'নির্ধারিত কাজ ↔ ওয়ালেট। ডাটাবেসের কাজেও একই মান না বদলালে কাজ বন্ধ হয়ে যাবে।'],
    PAYMENT_SERVICE_URL: ['Address of the wallet service.', 'ওয়ালেট সার্ভিসের ঠিকানা।'],
    PAYMENT_SERVICE_AUTH_MODE: ['How the wallet service checks callers.', 'ওয়ালেট সার্ভিস কলারকে কীভাবে যাচাই করে।'],
    TURNSTILE_SECRET_KEY: ['Bot check on sign-up and sign-in (Cloudflare Turnstile).', 'সাইন-আপ ও সাইন-ইনে বট যাচাই (Cloudflare Turnstile)।'],
    TURNSTILE_MODE: ['Bot check mode.', 'বট যাচাইয়ের মোড।'],
    ALERT_TELEGRAM_BOT_TOKEN: ['Telegram bot for admin alerts.', 'অ্যাডমিন সতর্কবার্তার Telegram বট।'],
    ALERT_TELEGRAM_CHAT_ID: ['Telegram chat that gets the alerts.', 'যে Telegram চ্যাটে সতর্কবার্তা যায়।'],
    ALERT_WEBHOOK_URL: ['Extra alert webhook.', 'অতিরিক্ত সতর্কবার্তা webhook।'],
    ALLOWED_ORIGINS: ['Extra sites allowed to call the functions (comma separated).', 'যে অতিরিক্ত সাইট ফাংশন কল করতে পারবে (কমা দিয়ে আলাদা)।'],
    DIRECT_PROVIDER_HOSTS: ['Allowed Lightning address providers for direct payments.', 'সরাসরি পেমেন্টে অনুমোদিত Lightning address প্রোভাইডার।'],
    DIRECT_SETTLEMENT_NETWORK: ['Network for direct payments.', 'সরাসরি পেমেন্টের নেটওয়ার্ক।'],
    DIRECT_RECONCILE_SECRET: ['Lets the scheduled check settle direct payments.', 'নির্ধারিত যাচাই সরাসরি পেমেন্ট মিলিয়ে নিতে এটি লাগে।'],
    ADMIN_MFA_EXPECTED: ['Health check: warn if admin two-step sign-in is not required.', 'হেলথ চেক: অ্যাডমিনের দুই ধাপের সাইন-ইন বাধ্যতামূলক না হলে সতর্ক করে।'],
    GITHUB_TOKEN: ['Ledger backup to GitHub.', 'GitHub-এ লেজার ব্যাকআপ।'],
  };
  async function fn(method, body) {
    const { data, error } = await client.functions.invoke('owner-config', { method, body });
    if (!error) return { ok: true, data };
    let payload = null;
    try { payload = await error.context.json(); } catch { payload = null; }
    return { ok: false, data: payload, code: payload?.code, message: payload?.error || error.message };
  }
  const change = (body) => (window.cpayWithStepUp ? window.cpayWithStepUp(() => fn('POST', body)) : fn('POST', body));

  function setupNote(missing) {
    return node('div', { class: 'owner-setup' },
      node('p', null, node('strong', { text: L('Not set up yet', 'এখনো সেটআপ হয়নি') }), ' ',
        L('Add these once in the Supabase dashboard → Edge Functions → Secrets:', 'একবার Supabase ড্যাশবোর্ড → Edge Functions → Secrets-এ এগুলো যোগ করুন:')),
      node('ul', null, ...missing.map((m) => node('li', null, node('code', { text: m })))));
  }

  function secretsBlock(target, title, info, protectedNames, reload) {
    const st = status();
    if (!info?.ready) return node('div', null, node('h4', { text: title }), setupNote(info?.missing || []));
    if (info.error) return node('div', null, node('h4', { text: title }), node('p', { class: 'err', text: info.error }));
    const body = node('tbody');
    for (const name of info.secrets || []) {
      const locked = protectedNames.has(name) || name.startsWith('SUPABASE_');
      const note = KNOWN[name] ? L(...KNOWN[name]) : '';
      body.append(node('tr', null,
        node('td', null, node('code', { text: name }), note ? node('div', { class: 'faint', text: note }) : null),
        node('td', { class: 'num' }, locked ? node('span', { class: 'faint', text: L('Protected', 'সুরক্ষিত') }) : node('span', null,
          node('button', { class: 'btn ghost sm', type: 'button', text: L('Replace', 'বদলান'), on: { click: () => { form.name.value = name; form.value.focus(); } } }), ' ',
          node('button', { class: 'btn ghost sm', type: 'button', text: L('Delete', 'মুছে ফেলুন'), on: { click: async () => {
            if (window.prompt(L(`Type ${name} to delete it. Functions that use it stop working.`, `মুছতে ${name} লিখুন। যে ফাংশন এটি ব্যবহার করে সেগুলো কাজ করবে না।`)) !== name) return;
            say(st, L('Saving…', 'সংরক্ষণ হচ্ছে…'));
            const r = await change({ target, action: 'delete', name });
            if (r.ok) reload(); else say(st, r.message, false);
          } } })))));
    }
    if (!(info.secrets || []).length) body.append(node('tr', null, node('td', { colspan: '2', class: 'empty', text: L('(none)', '(কিছু নেই)') })));
    const form = {
      name: node('input', { placeholder: 'MY_SECRET_NAME', autocomplete: 'off', spellcheck: 'false', 'aria-label': L('Name', 'নাম') }),
      value: node('input', { type: 'password', autocomplete: 'new-password', placeholder: L('Value (shown never again)', 'মান (আর কখনো দেখানো হবে না)'), 'aria-label': L('Value', 'মান') }),
    };
    const save = node('button', { class: 'btn primary sm', type: 'button', text: L('Set secret', 'সিক্রেট সেট করুন'), on: { click: async () => {
      const name = form.name.value.trim().toUpperCase();
      if (!window.confirm(L(`Set ${name}? If it already exists it is replaced, and the functions restart with the new value.`, `${name} সেট করবেন? আগে থাকলে বদলে যাবে, ফাংশনগুলো নতুন মান নিয়ে আবার চালু হবে।`))) return;
      say(st, L('Saving…', 'সংরক্ষণ হচ্ছে…'));
      const r = await change({ target, action: 'set', name, value: form.value.value });
      form.value.value = '';
      if (r.ok) reload(); else say(st, r.message, false);
    } } });
    return node('div', null, node('h4', { text: title }),
      node('div', { class: 'card flush' }, node('table', { class: 'table' }, body)),
      node('p', { class: 'faint', text: L('Add or replace a secret', 'সিক্রেট যোগ বা বদলান') }),
      node('div', { class: 'row owner-add' }, form.name, form.value, save), st);
  }

  async function renderSecrets() {
    const host = document.getElementById('ownerSecrets');
    const cf = document.getElementById('ownerCloudflare');
    if (!host) return;
    host.replaceChildren(card('ownerSecretsCard', L('Secrets & keys', 'গোপন কী ও টোকেন'), L('Loading…', 'লোড হচ্ছে…')));
    const r = await fn('GET');
    const reload = () => renderSecrets();
    if (!r.ok) {
      const msg = r.code === 'aal2_required'
        ? L('Sign in again with your passkey to see this section.', 'এই অংশ দেখতে পাসকি দিয়ে আবার সাইন-ইন করুন।') : r.message;
      host.replaceChildren(card('ownerSecretsCard', L('Secrets & keys', 'গোপন কী ও টোকেন'), null, node('p', { class: 'err', text: msg })));
      if (cf) cf.replaceChildren();
      return;
    }
    const prot = new Set(r.data.protected || []);
    host.replaceChildren(card('ownerSecretsCard', L('Secrets & keys', 'গোপন কী ও টোকেন'),
      L('Write-only: a value is sent once and never shown again, not even to you. Wallet recovery words and the access tokens are protected and change only in the Supabase dashboard. Every change is recorded and every admin gets a notice.',
        'শুধু লেখা যায়: মান একবার পাঠানো হয়, আর কখনো দেখানো হয় না (আপনাকেও না)। ওয়ালেটের রিকভারি শব্দ ও অ্যাক্সেস টোকেন সুরক্ষিত, শুধু Supabase ড্যাশবোর্ডে বদলানো যায়। প্রতিটি পরিবর্তন লেখা থাকে এবং সব অ্যাডমিন নোটিশ পান।'),
      secretsBlock('supabase', L('Supabase secrets', 'Supabase সিক্রেট'), r.data.supabase, prot, reload),
      secretsBlock('cloudflare', L('Cloudflare Worker secrets', 'Cloudflare Worker সিক্রেট'), r.data.cloudflare, prot, reload)));
    if (!cf) return;
    const h = r.data.always_https || {};
    const st = status();
    let body;
    if (!h.ready) body = setupNote(h.missing || []);
    else if (h.error) body = node('p', { class: 'err', text: h.error });
    else {
      const sw = node('input', { type: 'checkbox', role: 'switch', checked: h.on, 'aria-label': L('Always Use HTTPS', 'সবসময় HTTPS ব্যবহার') });
      sw.addEventListener('change', async () => {
        say(st, L('Saving…', 'সংরক্ষণ হচ্ছে…'));
        const res = await change({ target: 'cloudflare', action: 'always_https', on: sw.checked });
        if (res.ok) say(st, sw.checked ? L('On', 'চালু') : L('Off', 'বন্ধ'), true);
        else { sw.checked = !sw.checked; say(st, res.message, false); }
      });
      body = node('label', { class: 'owner-row' }, sw, node('span', null,
        node('strong', { text: L('Always Use HTTPS', 'সবসময় HTTPS ব্যবহার') }),
        node('span', { class: 'faint', text: L(' Sends every http:// visit to https:// (recommended: on).', ' সব http:// ভিজিট https://-এ পাঠায় (চালু রাখা ভালো)।') }), st));
    }
    cf.replaceChildren(card('ownerCloudflareCard', 'Cloudflare', null, body));
  }

  function nav() {
    const host = document.getElementById('ownerSettingsNav');
    if (!host) return;
    const items = [['ownerFeatures', 'Features', 'ফিচার'], ['platformSettings', 'Payment & fees', 'পেমেন্ট ও ফি'], ['ownerDomains', 'Domains', 'ডোমেইন'],
      ['ownerSecrets', 'Secrets & keys', 'গোপন কী'], ['ownerCloudflare', 'Cloudflare', 'Cloudflare']];
    host.replaceChildren(...items.map(([id, en, b]) => node('button', { class: 'pill', type: 'button', text: L(en, b),
      on: { click: () => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) } })));
  }

  let busy = false;
  async function render() {
    if (busy || !client || !document.getElementById('ownerFeatures')) return;
    busy = true;
    try { nav(); await Promise.all([renderFeatures(), renderDomains(), renderSecrets()]); } finally { busy = false; }
  }
  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('.navi[data-tab="settings"]')) setTimeout(render, 0);
  });
  document.addEventListener('cpay:lang', () => { if (!document.getElementById('settings')?.hidden) render(); });
  if (location.hash === '#settings') setTimeout(render, 0);
  window.addEventListener('cpay:admin-ready', render);
})();
