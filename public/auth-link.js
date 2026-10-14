// Email-link landing. Load BEFORE config.js (before supabase-js reads the URL).
//
// Supabase Auth sends a password-reset link to the redirect URL the site
// asked for, but only when that URL is on the project's Redirect URLs list;
// otherwise it falls back to the Site URL (the home page). An expired, used
// or malformed link also comes back with only an error in the fragment. So
// the home page forwards any recovery link or link error to reset.html,
// unchanged, and reset.html reads the outcome from window.cpayAuthLink.
//
// Nothing here logs, stores or sends the fragment: it holds a session token.
(function () {
  function parse(str) {
    const out = {};
    String(str || '').replace(/^[#?]/, '').split('&').forEach((pair) => {
      if (!pair) return;
      const i = pair.indexOf('=');
      const k = decodeURIComponent((i < 0 ? pair : pair.slice(0, i)).replace(/\+/g, ' '));
      const v = i < 0 ? '' : decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
      out[k] = v;
    });
    return out;
  }
  let h = {};
  let q = {};
  const search = location.search;
  const hash = location.hash;
  try { h = parse(hash); q = parse(search); } catch (e) { h = {}; q = {}; }
  const error = h.error_code || h.error || q.error_code || q.error || '';
  // Branded template link (docs/email-templates/recovery.html):
  // reset.html?token_hash=...&type=recovery. The hash is used only when the
  // person taps Continue, so a mail scanner that opens links cannot use it up.
  const tokenHash = q.type === 'recovery' && /^[A-Za-z0-9_-]{8,}$/.test(q.token_hash || '') ? q.token_hash : '';
  // Default template link: tokens in the fragment, marked type=recovery.
  const recovery = (h.type === 'recovery' && !!h.access_token) || !!tokenHash;
  // 'expired' covers expired, already used and otherwise rejected links:
  // Supabase reports them all as otp_expired / access_denied.
  const kind = error ? 'expired' : recovery ? 'recovery' : '';
  window.cpayAuthLink = { kind, error, tokenHash };

  // Only the home page (the Site URL) forwards; other pages just report.
  const onHome = /^\/(index\.html)?$/.test(location.pathname);
  if (kind && onHome) {
    window.cpayAuthLink.forwarding = true;
    location.replace('/reset.html' + search + hash);
  } else if (tokenHash && window.history && history.replaceState) {
    // Keep the one-time hash out of the address bar and history.
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
  }

  // Ask for a reset email (login.html and reset.html). The answer never says
  // whether the address has an account: Supabase Auth replies the same for
  // unknown addresses, and every server-side refusal (including the
  // per-address rate limit, which only applies to real accounts) is shown
  // as the same "sent" message. Only a network failure or a malformed
  // address is reported. The button then waits COOLDOWN seconds.
  const COOLDOWN = 60;
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  async function requestReset(email) {
    if (!EMAIL.test(String(email || ''))) return 'invalid';
    let error = null;
    try {
      ({ error } = await window.supabaseClient.auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}/reset.html` }));
    } catch (e) {
      return 'network';
    }
    // supabase-js reports an unreachable server as a retryable fetch error.
    if (error && (error.name === 'AuthRetryableFetchError' || error.status === 0)) return 'network';
    return 'sent';
  }
  function cooldown(btn, label) {
    let left = COOLDOWN;
    btn.disabled = true;
    const tick = () => {
      if (left <= 0) { btn.disabled = false; btn.textContent = label; return; }
      btn.textContent = `Send again in ${left}s`;
      left -= 1;
      setTimeout(tick, 1000);
    };
    tick();
  }
  window.cpayResetRequest = { requestReset, cooldown, COOLDOWN,
    SENT: 'If an account uses that email, a reset link is on its way. It can take a few minutes; check spam too. The link works once and expires after about an hour.' };
})();
