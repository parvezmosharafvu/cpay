// "Continue with Google" on log in and register (Supabase Auth OAuth).
//
// The button appears only when the Google provider is switched on in
// Supabase (Authentication → Sign In / Providers → Google). The page asks
// Supabase Auth's public /settings endpoint, so nothing here has to change
// when the owner turns it on or off. Google returns to login.html, which
// finishes the sign-in (two-step code, account status) like a password
// sign-in. A new Google account starts as a pending Freelancer application,
// the same as the sign-up form; Google has already verified the email.
(function () {
  let cached = null;
  async function providers() {
    if (cached) return cached;
    cached = (async () => {
      try {
        const r = await fetch(`${window.SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: window.SUPABASE_ANON_KEY } });
        if (!r.ok) return {};
        const s = await r.json();
        return (s && s.external) || {};
      } catch (e) { return {}; }
    })();
    return cached;
  }

  async function googleEnabled() {
    return (await providers()).google === true;
  }

  async function startGoogle() {
    const { error } = await window.supabaseClient.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${location.origin}/login.html?via=google`, queryParams: { prompt: 'select_account' } },
    });
    if (error) throw new Error('Google sign-in is not available right now. Try again, or use your email and password.');
  }

  // Shows the button (and its "or" divider) only when Google is enabled.
  async function wire(button, onError) {
    if (!button) return;
    const wrap = button.closest('[data-oauth]') || button;
    wrap.hidden = true;
    if (!(await googleEnabled())) return;
    wrap.hidden = false;
    button.onclick = async () => {
      if (button.disabled) return;
      button.disabled = true;
      try { await startGoogle(); } catch (e) { button.disabled = false; if (onError) onError(e.message); }
    };
  }

  window.cpayOAuth = { googleEnabled, startGoogle, wire };
})();
