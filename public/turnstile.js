// Cloudflare Turnstile for CPAY forms.
//
// Supabase Auth CAPTCHA protection (Authentication → Attack Protection)
// refuses password sign-in, sign-up and reset-email requests that carry no
// token ("captcha protection: request disallowed (no captcha_token
// found)"). Every page that calls one of those loads this file and passes
// cpayCaptchaOptions(action) into the Auth call.
//
// OFF unless window.CPAY_TURNSTILE_SITE_KEY is set (config.js). The site key
// is public by design; the matching secret lives only in Supabase (Auth
// captcha settings, and TURNSTILE_SECRET_KEY for create-invoice). While off,
// cpayTurnstileToken() resolves to null immediately and nothing loads.
//
// Payment pages ask with action 'pay'. They stay token-free unless
// window.CPAY_TURNSTILE_PAYMENTS === true, so turning on Auth CAPTCHA does
// not add a challenge to every customer payment (that is a separate owner
// decision, together with TURNSTILE_MODE on create-invoice).
//
// Each token is single-use and short-lived, so a new one is fetched for
// every attempt. Tokens are never logged or stored.
(function () {
  const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  const TIMEOUT_MS = 60000;
  let loading = null;
  const widgets = new Map(); // container element -> widget id

  function load() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SCRIPT;
      s.async = true;
      s.onload = () => (window.turnstile ? resolve(window.turnstile) : (loading = null, reject(new Error('Verification unavailable. Check your connection and try again.'))));
      s.onerror = () => { loading = null; reject(new Error('Verification unavailable. Check your connection and try again.')); };
      document.head.appendChild(s);
    });
    return loading;
  }

  function enabledFor(action) {
    if (!window.CPAY_TURNSTILE_SITE_KEY) return false;
    if (action === 'pay') return window.CPAY_TURNSTILE_PAYMENTS === true;
    return true;
  }

  function containerFor(opts) {
    if (opts && opts.container) return opts.container;
    let box = document.getElementById('cpayTurnstile');
    if (!box) {
      box = document.createElement('div');
      box.id = 'cpayTurnstile';
      box.style.margin = '12px 0';
      (document.querySelector('main') || document.body).appendChild(box);
    }
    return box;
  }

  // Resolves to a fresh token, or null when Turnstile is off for this
  // action. Rejects with a user-facing message on error, expiry or timeout.
  window.cpayTurnstileToken = async function (action, opts) {
    if (!enabledFor(action)) return null;
    const ts = await load();
    const box = containerFor(opts);
    const old = widgets.get(box);
    if (old !== undefined) { try { ts.remove(old); } catch (e) { /* already gone */ } widgets.delete(box); }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
      const timer = setTimeout(() => finish(reject, new Error('Verification timed out. Try again.')), TIMEOUT_MS);
      try {
        const id = ts.render(box, {
          sitekey: window.CPAY_TURNSTILE_SITE_KEY,
          action,
          callback: (token) => finish(resolve, token),
          'error-callback': () => { finish(reject, new Error('Verification failed. Try again.')); return true; },
          'expired-callback': () => finish(reject, new Error('Verification expired. Try again.')),
          'timeout-callback': () => finish(reject, new Error('Verification timed out. Try again.')),
        });
        widgets.set(box, id);
      } catch (e) {
        finish(reject, new Error('Verification unavailable. Reload the page and try again.'));
      }
    });
  };

  // Options to spread into a Supabase Auth call: { captchaToken } or {}.
  window.cpayCaptchaOptions = async function (action, opts) {
    const token = window.cpayTurnstileToken ? await window.cpayTurnstileToken(action, opts) : null;
    return token ? { captchaToken: token } : {};
  };

  // Supabase Auth's answer when the token was missing, used or rejected.
  window.cpayIsCaptchaError = function (error) {
    const code = error && (error.code || error.error_code);
    return code === 'captcha_failed' || /captcha/i.test(String((error && error.message) || ''));
  };
  window.CPAY_CAPTCHA_MESSAGE = 'The security check did not pass. Wait a moment and try again. If it keeps failing, reload the page.';

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
