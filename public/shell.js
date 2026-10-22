// Desk shell (dashboard.html, admin.html): the phone drawer, the bottom tab
// bar and the top bar title. It never switches sections itself: a tab bar
// button clicks the matching sidebar button, so freelancer-desk.js and
// admin-desk.js stay the only code that shows a section. Display only;
// server RPCs and RLS remain the privilege boundary.
(function () {
  const shell = document.querySelector('.shell');
  const side = document.querySelector('.side');
  if (!shell || !side) return;
  const phone = window.matchMedia('(max-width: 900px)');
  const openers = () => document.querySelectorAll('[data-nav-open]');
  let lastOpener = null;

  function focusables() {
    return [...side.querySelectorAll('a[href], button:not([disabled])')].filter((n) => !n.hidden && n.offsetParent !== null);
  }
  function setOpen(open, from) {
    shell.classList.toggle('nav-open', open);
    openers().forEach((b) => b.setAttribute('aria-expanded', open ? 'true' : 'false'));
    const scrim = shell.querySelector('.scrim');
    if (scrim) scrim.hidden = !open;
    if (open) {
      lastOpener = from || lastOpener;
      const first = side.querySelector('.navi.active') || focusables()[0];
      if (first) setTimeout(() => first.focus(), 30);
    } else if (lastOpener && phone.matches) {
      lastOpener.focus();
    }
  }
  document.addEventListener('click', (e) => {
    const open = e.target.closest('[data-nav-open]');
    if (open) { e.preventDefault(); setOpen(!shell.classList.contains('nav-open'), open); return; }
    if (e.target.closest('[data-nav-close]')) { setOpen(false); return; }
    // Picking a section in the drawer closes it on phones.
    if (phone.matches && e.target.closest('.side .navi[data-tab]')) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (!shell.classList.contains('nav-open')) return;
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key !== 'Tab') return;
    const f = focusables();
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  phone.addEventListener('change', () => { if (!phone.matches) setOpen(false); });

  // Bottom tab bar: forwards to the sidebar button for the same section.
  document.querySelectorAll('.tabbar [data-go]').forEach((b) => {
    b.addEventListener('click', () => {
      const target = side.querySelector(`.navi[data-tab="${b.dataset.go}"]`);
      if (target) target.click();
      window.scrollTo({ top: 0 });
    });
  });

  // Keep the tab bar, the top bar title and the account labels in step with
  // whatever the desk script marks active or writes.
  const title = document.getElementById('pageTitle');
  // Display-only section guidance; existing desk scripts still own routing.
  const sectionHints = {
    "home": "Your balance, recent payments and next actions in one place.",
    "links": "Create and manage the payment links you share with customers.",
    "pay": "Find a payment and open its details to check the current status.",
    "cash": "Check your available balance, choose a destination and confirm with your passkey.",
    "chat": "Keep account questions and replies together in your conversation.",
    "profile": "Manage your account details and saved receive addresses.",
    "security": "Manage your passkeys and review account security.",
    "daily": "Review earnings by Bangladesh business day.",
    "people": "Find an account, review its details and manage permitted settings.",
    "apps": "Review applications and their current approval status.",
    "payments": "Filter platform payments and inspect individual payment details.",
    "payouts": "Review withdrawal requests, destinations and delivery status.",
    "locations": "View reported locations for context only; they do not affect payments.",
    "forwards": "Review automatic forwards, including held amounts and failed attempts.",
    "wallet": "Check wallet balances, primary status and the latest sync.",
    "health": "Check service availability and the latest reported sync times.",
    "receipts": "Review receipt evidence alongside the related payment.",
    "system": "Review system operations and available maintenance controls.",
    "audit": "Review recorded actions and their timestamps.",
    "settings": "Manage payment, account and publication settings.",
    "guide": "Read setup steps and troubleshooting guidance in Bangla."
};
  const adminHints = {
    "home": "Review platform activity and the queues that need attention.",
    "links": "Review payment links across the platform.",
    "chat": "Review account conversations and reply from the inbox."
};
  const hint = document.getElementById('sectionHint');
  const isAdminDesk = !!document.getElementById('adminMain');
  function sync() {
    const active = side.querySelector('.navi.active[data-tab]');
    const tab = active ? active.dataset.tab : '';
    let matched = false;
    document.querySelectorAll('.tabbar [data-go]').forEach((b) => {
      const on = b.dataset.go === tab;
      matched = matched || on;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    document.querySelectorAll('.tabbar [data-nav-open]').forEach((b) => b.classList.toggle('active', !!tab && !matched));
    if (title && active) {
      const label = active.querySelector('.navi-label');
      const text = (label ? label.textContent : active.textContent).replace(/\s*\(\d+\)$/, '').trim();
      if (title.textContent !== text) title.textContent = text;
    }
    if (hint) {
      const english = (isAdminDesk && adminHints[tab]) || sectionHints[tab] || '';
      const text = window.cpayI18n ? window.cpayI18n.t(english) : english;
      if (hint.textContent !== text) hint.textContent = text;
      hint.hidden = !text;
    }
  }
  document.addEventListener('cpay:lang', sync);
  new MutationObserver(sync).observe(side, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true, characterData: true });

  function mirror() {
    document.querySelectorAll('[data-mirror]').forEach((n) => {
      const src = document.getElementById(n.dataset.mirror);
      if (src && n.textContent !== src.textContent) n.textContent = src.textContent;
    });
    document.querySelectorAll('[data-initial]').forEach((n) => {
      const src = document.getElementById(n.dataset.initial);
      const ch = ((src && src.textContent) || '').trim().charAt(0).toUpperCase();
      if (ch && n.textContent !== ch) n.textContent = ch;
    });
  }
  ['hello', 'deskKind', 'meName'].forEach((id) => {
    const n = document.getElementById(id);
    if (n) new MutationObserver(mirror).observe(n, { childList: true, characterData: true, subtree: true });
  });

  // The admin desk does not write a name into the page; show the signed-in
  // admin once loadProfile() has run (app.js sets window.CPAY_PROFILE).
  const meName = document.getElementById('meName');
  if (meName && meName.dataset.fromProfile !== undefined) {
    let tries = 0;
    const t = setInterval(() => {
      const p = window.CPAY_PROFILE;
      if (p || ++tries > 40) {
        clearInterval(t);
        if (p) meName.textContent = p.display_name || p.email || meName.textContent;
      }
    }, 250);
  }
  sync();
  mirror();
})();
