// Dashboard language: English (default) or Bangla, switched from the top bar
// of admin.html and dashboard.html and remembered in this browser.
//
// The pages are written in English. BN maps an exact English phrase to its
// Bangla text: when Bangla is on, any text node (or aria-label, placeholder,
// title) whose trimmed text is exactly one of these phrases is shown in
// Bangla, including text the desk scripts render later (a MutationObserver
// watches the page). Switching back restores the original English. Scripts
// that build text themselves call cpayI18n.t('English phrase').
//
// Display only: nothing here changes what the server accepts.
(function () {
  'use strict';
  const BN = {
    // Navigation and shell
    'Overview': 'সারসংক্ষেপ', 'Daily earnings': 'দৈনিক আয়', 'People': 'ব্যবহারকারী', 'Manage users': 'ব্যবহারকারী পরিচালনা',
    'Applications': 'আবেদন', 'Inbox': 'ইনবক্স', 'Money': 'অর্থ', 'Payments': 'পেমেন্ট', 'Payouts': 'পেআউট',
    'Instant forwards': 'তাৎক্ষণিক ফরোয়ার্ড', 'Links': 'লিংক', 'Wallet': 'ওয়ালেট', 'Operations': 'পরিচালনা',
    'Health': 'সিস্টেমের অবস্থা', 'Receipt review': 'রসিদ যাচাই', 'System': 'সিস্টেম', 'Audit': 'অডিট লগ',
    'Settings': 'সেটিংস', 'Security': 'নিরাপত্তা', 'Log out': 'লগ আউট', 'Users': 'ব্যবহারকারী', 'More': 'আরও',
    'CPAY admin': 'CPAY অ্যাডমিন', 'Administrator': 'অ্যাডমিনিস্ট্রেটর', 'Admin': 'অ্যাডমিন',
    'Workspace': 'কাজের জায়গা', 'Payment links': 'পেমেন্ট লিংক', 'Withdraw': 'উত্তোলন', 'Account': 'অ্যাকাউন্ট',
    'Download wallet': 'ওয়ালেট ডাউনলোড', 'Chat': 'চ্যাট', 'Profile': 'প্রোফাইল', 'Freelancer desk': 'ফ্রিল্যান্সার ডেস্ক',
    'Freelancer': 'ফ্রিল্যান্সার', 'Open menu': 'মেনু খুলুন', 'Close menu': 'মেনু বন্ধ করুন', 'Sections': 'বিভাগ',
    'Main sections': 'প্রধান বিভাগ', 'Skip to admin desk': 'অ্যাডমিন ডেস্কে যান', 'Skip to your desk': 'আপনার ডেস্কে যান',
    // Common words
    'Save': 'সংরক্ষণ করুন', 'Cancel': 'বাতিল', 'On': 'চালু', 'Off': 'বন্ধ', 'Saving…': 'সংরক্ষণ হচ্ছে…', 'Saved': 'সংরক্ষিত',
    'Add': 'যোগ করুন', 'Remove': 'সরিয়ে দিন', 'Delete': 'মুছে ফেলুন', 'Edit': 'সম্পাদনা', 'Status': 'অবস্থা', 'When': 'কখন',
    'Who': 'কে', 'Close': 'বন্ধ করুন', 'Refresh': 'রিফ্রেশ', 'Loading…': 'লোড হচ্ছে…', 'Search': 'খুঁজুন', 'Yes': 'হ্যাঁ', 'No': 'না',
    'Advanced': 'উন্নত', 'Setting': 'সেটিং', 'From': 'আগে', 'To': 'এখন', 'Now': 'এখন', 'default': 'ডিফল্ট', '(none)': '(কিছু নেই)',
    '(empty)': '(খালি)', '(not set)': '(সেট করা নেই)',
    // Settings page
    'Payment mode': 'পেমেন্ট মোড', 'Platform fee': 'প্ল্যাটফর্ম ফি', 'Fee %': 'ফি %', 'Save fee': 'ফি সংরক্ষণ করুন',
    'Save payment mode': 'পেমেন্ট মোড সংরক্ষণ করুন', 'Balance': 'ব্যালেন্স', 'Instant forward': 'তাৎক্ষণিক ফরোয়ার্ড',
    'Direct (no fee)': 'সরাসরি (ফি নেই)', 'Legal pages': 'আইনি পাতা', 'Wallet link': 'ওয়ালেট লিংক',
    'Settings changes': 'সেটিংস পরিবর্তনের ইতিহাস', 'No changes yet': 'এখনো কোনো পরিবর্তন নেই',
    'Features': 'ফিচার চালু/বন্ধ', 'Domains': 'ডোমেইন', 'Secrets & keys': 'গোপন কী ও টোকেন', 'Cloudflare': 'Cloudflare',
    'Domain': 'ডোমেইন', 'Purpose': 'কাজ', 'Add domain': 'ডোমেইন যোগ করুন', 'Turn on': 'চালু করুন', 'Turn off': 'বন্ধ করুন',
    'Main site': 'মূল সাইট', 'Payment links and site': 'পেমেন্ট লিংক ও সাইট', 'Payment links only': 'শুধু পেমেন্ট লিংক',
    'Site only': 'শুধু সাইট', 'No domains yet': 'এখনো কোনো ডোমেইন নেই', 'Supabase secrets': 'Supabase সিক্রেট',
    'Cloudflare Worker secrets': 'Cloudflare Worker সিক্রেট', 'Add or replace a secret': 'সিক্রেট যোগ বা বদলান',
    'Name': 'নাম', 'Value': 'মান', 'Set secret': 'সিক্রেট সেট করুন', 'Replace': 'বদলান', 'Protected': 'সুরক্ষিত',
    'Not set up yet': 'এখনো সেটআপ হয়নি', 'Always Use HTTPS': 'সবসময় HTTPS ব্যবহার', 'Language': 'ভাষা',
    'Used for': 'কাজে লাগে', 'Set': 'সেট আছে', 'Missing': 'নেই', 'Other': 'অন্যান্য',
    'Changes need two-step sign-in and are recorded below. Settings marked ⚠ ask for confirmation.': 'পরিবর্তনের জন্য দুই ধাপের সাইন-ইন লাগে এবং নিচে লেখা থাকে। ⚠ চিহ্নিত সেটিং নিশ্চিত করতে বলে।',
    'Payments go to the CPAY wallet. CPAY keeps the fee and the rest is added to the user’s CPAY balance. Users withdraw. This is how CPAY works today.': 'পেমেন্ট CPAY ওয়ালেটে আসে। CPAY ফি রাখে, বাকিটা ব্যবহারকারীর CPAY ব্যালেন্সে যোগ হয়। ব্যবহারকারী উত্তোলন করেন।',
    'Payments go to the CPAY wallet. CPAY keeps the fee and sends the rest straight to the user’s own Lightning address. No balances are kept.': 'পেমেন্ট CPAY ওয়ালেটে আসে। CPAY ফি রাখে, বাকিটা সঙ্গে সঙ্গে ব্যবহারকারীর নিজের Lightning address-এ পাঠায়। কোনো ব্যালেন্স রাখা হয় না।',
    'Payers pay the user’s own wallet directly. CPAY never receives the money and takes no fee.': 'পেমেন্টকারী সরাসরি ব্যবহারকারীর নিজের ওয়ালেটে পেমেন্ট করেন। CPAY টাকা ধরে না, কোনো ফি নেয় না।',
    'CPAY’s fee on each payment, in Balance and Instant forward modes. An account’s own fee (Manage users) wins over this.': 'প্রতিটি পেমেন্টে CPAY-এর ফি (ব্যালেন্স ও তাৎক্ষণিক ফরোয়ার্ড মোডে)। কোনো অ্যাকাউন্টের নিজস্ব ফি (ব্যবহারকারী পরিচালনা) থাকলে সেটিই প্রযোজ্য।',
    'Legal entity name': 'প্রতিষ্ঠানের আইনি নাম', 'Registered address': 'নিবন্ধিত ঠিকানা', 'Legal pages effective date': 'আইনি পাতা কার্যকর হওয়ার তারিখ',
    'Governing law jurisdiction': 'প্রযোজ্য আইনের এলাকা', 'Courts with jurisdiction': 'এখতিয়ারভুক্ত আদালত', 'Privacy contact email': 'গোপনীয়তা বিষয়ক ইমেইল',
    'Support email': 'সাপোর্ট ইমেইল', 'CPAY Wallet address (https)': 'CPAY Wallet-এর ঠিকানা (https)', 'Settings sections': 'সেটিংসের অংশ',
  };
  const KEY = 'cpay-lang';
  let lang = 'en';
  try { lang = localStorage.getItem(KEY) === 'bn' ? 'bn' : 'en'; } catch { /* private mode */ }

  const original = new WeakMap();      // Text node -> its English text
  const attrs = ['aria-label', 'placeholder', 'title'];
  const SKIP = 'script,style,textarea,code,.mono,[data-no-i18n],[contenteditable]';
  let applying = false;

  function t(en) { return lang === 'bn' && BN[en] ? BN[en] : en; }

  // Bangla text copied as-is from a translated node (the top bar title
  // copies the active menu label) goes back to English on a switch.
  const EN_OF = Object.fromEntries(Object.entries(BN).map(([en, bn]) => [bn, en]));
  const bnOf = (en) => { const k = en.trim(); return BN[k] ? en.replace(k, BN[k]) : en; };

  function textNode(n) {
    const p = n.parentElement;
    if (!p || p.closest(SKIP)) return;
    let en = original.get(n);
    // A script replaced the text since we translated it: that is the new English.
    if (en !== undefined && n.nodeValue !== en && n.nodeValue !== bnOf(en)) { original.delete(n); en = undefined; }
    if (en === undefined) {
      const cur = n.nodeValue, k = cur.trim();
      en = EN_OF[k] ? cur.replace(k, EN_OF[k]) : cur;
    }
    const key = en.trim();
    if (!key || !BN[key]) return;
    original.set(n, en);
    const want = lang === 'bn' ? bnOf(en) : en;
    if (n.nodeValue !== want) n.nodeValue = want;
  }
  function element(el) {
    if (el.closest(SKIP)) return;
    for (const a of attrs) {
      const store = `i18nEn${a.replace(/-(\w)/g, (_, c) => c.toUpperCase()).replace(/^\w/, (c) => c.toUpperCase())}`;
      const cur = el.getAttribute(a);
      if (cur == null && el.dataset[store] == null) continue;
      const en = el.dataset[store] ?? cur;
      if (!BN[en.trim()]) continue;
      el.dataset[store] = en;
      const want = lang === 'bn' ? BN[en.trim()] : en;
      if (cur !== want) el.setAttribute(a, want);
    }
  }
  function apply(root) {
    if (!root) return;
    applying = true;
    try {
      if (root.nodeType === 3) { textNode(root); return; }
      if (root.nodeType !== 1 && root.nodeType !== 9) return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) textNode(n);
      if (root.nodeType === 1) element(root);
      root.querySelectorAll?.('[aria-label],[placeholder],[title]').forEach(element);
    } finally { applying = false; }
  }

  function set(next) {
    lang = next === 'bn' ? 'bn' : 'en';
    try { localStorage.setItem(KEY, lang); } catch { /* private mode */ }
    document.documentElement.lang = lang;
    apply(document.body);
    paintSwitch();
    document.dispatchEvent(new CustomEvent('cpay:lang', { detail: { lang } }));
  }

  let button = null;
  function paintSwitch() {
    if (!button) return;
    button.textContent = lang === 'bn' ? 'English' : 'বাংলা';
    button.setAttribute('aria-label', lang === 'bn' ? 'Switch to English' : 'বাংলায় দেখুন');
    button.setAttribute('lang', lang === 'bn' ? 'en' : 'bn');
  }
  function addSwitch() {
    const top = document.querySelector('.app-top');
    if (!top || top.querySelector('.lang-switch')) return;
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn ghost sm lang-switch';
    button.dataset.noI18n = '';
    button.onclick = () => set(lang === 'bn' ? 'en' : 'bn');
    const chip = top.querySelector('.me-chip');
    top.insertBefore(button, chip || null);
    paintSwitch();
  }

  function start() {
    addSwitch();
    document.documentElement.lang = lang;
    if (lang === 'bn') apply(document.body);
    new MutationObserver((list) => {
      if (applying || lang !== 'bn') return;
      for (const m of list) {
        if (m.type === 'characterData') apply(m.target);
        else m.addedNodes.forEach((n) => apply(n));
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  }

  window.cpayI18n = { t, set, get lang() { return lang; }, apply, phrases: BN };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
