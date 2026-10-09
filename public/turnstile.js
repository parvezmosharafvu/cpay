// Optional Cloudflare Turnstile for the public pay and register forms.
// OFF unless window.CPAY_TURNSTILE_SITE_KEY is set (config.js). While off,
// cpayTurnstileToken() resolves to null immediately and nothing loads.
// Turning it on also needs: the Turnstile origins in the CSP (public/_headers:
// script-src and frame-src https://challenges.cloudflare.com), the secret in
// Supabase (TURNSTILE_SECRET_KEY, TURNSTILE_MODE=monitor then enforce) and
// Supabase Auth captcha for sign-up. See docs in the PR.
(function () {
  let loading = null;
  let widgetId = null;
  function load() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('Verification unavailable. Try again.')));
      s.onerror = () => { loading = null; reject(new Error('Verification unavailable. Try again.')); };
      document.head.appendChild(s);
    });
    return loading;
  }
  window.cpayTurnstileToken = async function (action) {
    const sitekey = window.CPAY_TURNSTILE_SITE_KEY;
    if (!sitekey) return null;
    const ts = await load();
    let box = document.getElementById('cpayTurnstile');
    if (!box) {
      box = document.createElement('div');
      box.id = 'cpayTurnstile';
      box.style.margin = '12px 0';
      (document.querySelector('main') || document.body).appendChild(box);
    }
    if (widgetId !== null) { try { ts.remove(widgetId); } catch (e) { /* already gone */ } widgetId = null; }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Verification timed out. Try again.')), 60000);
      widgetId = ts.render(box, {
        sitekey, action,
        callback: (token) => { clearTimeout(timer); resolve(token); },
        'error-callback': () => { clearTimeout(timer); reject(new Error('Verification failed. Try again.')); },
      });
    });
  };
  // One id per payment attempt, reused for retries of that attempt so the
  // server returns the same invoice instead of creating a second one.
  window.cpayRequestId = function (scope) {
    const key = 'cpayReq:' + scope;
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
      if (saved && typeof saved.id === 'string' && Date.now() - saved.at < 10 * 60 * 1000) return saved.id;
    } catch (e) { /* storage unavailable */ }
    let id;
    if (window.crypto && crypto.randomUUID) id = crypto.randomUUID();
    else {
      const b = crypto.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
      const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
      id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    }
    try { sessionStorage.setItem(key, JSON.stringify({ id, at: Date.now() })); } catch (e) { /* storage unavailable */ }
    return id;
  };
  window.cpayForgetRequestId = function (scope) {
    try { sessionStorage.removeItem('cpayReq:' + scope); } catch (e) { /* storage unavailable */ }
  };
})();
