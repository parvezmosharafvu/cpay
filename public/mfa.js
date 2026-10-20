// Strong sign-in with a passkey (WebAuthn, Supabase Auth). Authenticator
// apps (TOTP) were retired on 2026-10-21: the second step everywhere is a
// passkey. Used by app.js and login.html (an account that still has an old
// authenticator must confirm with its passkey before any desk loads),
// reauth.js (payout step-up) and the admin Security section.
//
// The server applies the same rule (public.strong_session(), step-up.ts):
// a session counts as strong when its sign-in included a passkey (amr
// "passkey"), or aal2 while Supabase Auth still issues it. Nothing here logs
// or stores a credential; the signed challenge goes only to Supabase Auth.
(function () {
  const sb = () => window.supabaseClient;
  const GENERIC = 'Passkey sign-in did not work. Try again.';

  async function level() {
    const { data, error } = await sb().auth.mfa.getAuthenticatorAssuranceLevel();
    if (error) throw error;
    return data; // { currentLevel, nextLevel, currentAuthenticationMethods }
  }

  // The access token's amr list, read from the current session.
  async function methods() {
    const { data } = await sb().auth.getSession();
    const t = data?.session?.access_token || '';
    try {
      const p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return { aal: p.aal || '', amr: Array.isArray(p.amr) ? p.amr.map((e) => e && e.method) : [] };
    } catch (e) { return { aal: '', amr: [] }; }
  }

  async function strong() {
    const m = await methods();
    return m.aal === 'aal2' || m.amr.includes('passkey');
  }

  // True when this account must confirm with a passkey before anything that
  // needs the strong factor: it has an old verified authenticator (so the
  // server asks for a strong session) and this session is not strong yet.
  async function needsChallenge() {
    const l = await level();
    if (l.nextLevel !== 'aal2') return false;
    return !(await strong());
  }

  // Old authenticators still on the account (shown read-only in Security).
  async function factors() {
    const { data, error } = await sb().auth.mfa.listFactors();
    if (error) throw error;
    return { verified: data.totp || [], all: data.all || [] };
  }

  // Ask for the passkey of the signed-in account. Resolves true once the
  // session is strong, false on cancel. A passkey for another account signs
  // this one out (the session would belong to someone else). An account with
  // no passkey yet (a new admin) can add its first one here, from the
  // password sign-in it just made, and then signs in with it: otherwise a new
  // admin could never reach Security to add one. Supabase Auth refuses that
  // while an old authenticator is on the account and the session is aal1.
  function promptPasskey(message) {
    return new Promise((resolve) => {
      const dlg = document.createElement('dialog');
      dlg.className = 'card reauth-dialog';
      dlg.setAttribute('aria-labelledby', 'pkTitle');
      dlg.innerHTML = `<form method="dialog">
        <h3 id="pkTitle">Confirm with your passkey</h3>
        <p class="hint" data-role="msg"></p>
        <p class="hint" data-role="err" role="alert" hidden></p>
        <div data-role="captcha" class="captcha-box"></div>
        <div class="row">
          <button class="btn ghost" type="button" data-role="cancel">Cancel</button>
          <button class="btn primary" type="submit" data-role="ok">Use my passkey</button>
        </div></form>`;
      document.body.appendChild(dlg);
      const q = (r) => dlg.querySelector(`[data-role="${r}"]`);
      q('msg').textContent = message || 'Use your fingerprint, face or screen lock to continue.';
      const err = q('err');
      const done = (ok) => { dlg.close(); dlg.remove(); resolve(ok); };
      let enrol = false;
      (async () => {
        try {
          if (!window.cpayPasskey || !(await window.cpayPasskey.available())) {
            err.textContent = 'Passkeys are not available right now. Ask the owner to switch them on.'; err.hidden = false; return;
          }
          const keys = await window.cpayPasskey.list();
          if (!keys.length) {
            enrol = true;
            q('msg').textContent = 'This account needs a passkey. Add one now with your fingerprint, face or screen lock; you then sign in with it.';
            q('ok').textContent = 'Add a passkey and continue';
            q('ok').dataset.role = 'ok';
            q('ok').dataset.enrol = '1';
          }
        } catch (e) { /* sign-in with an existing passkey stays available */ }
      })();
      q('cancel').onclick = () => done(false);
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
      dlg.querySelector('form').onsubmit = async (e) => {
        e.preventDefault();
        const ok = q('ok');
        if (!window.cpayPasskey) { err.textContent = 'Passkeys are not available on this page. Reload and try again.'; err.hidden = false; return; }
        ok.disabled = true; err.hidden = true;
        try {
          const { data } = await sb().auth.getUser();
          const before = data?.user?.id;
          if (enrol) {
            const add = await window.cpayPasskey.register();
            if (add.cancelled) { ok.disabled = false; return; }
            if (add.error) { err.textContent = add.error; err.hidden = false; ok.disabled = false; return; }
            enrol = false;
          }
          const r = await window.cpayPasskey.signIn({ container: q('captcha') });
          if (r.cancelled) { ok.disabled = false; return; }
          if (r.error) { err.textContent = r.error; err.hidden = false; ok.disabled = false; return; }
          if (!r.user || r.user.id !== before) { await sb().auth.signOut(); location.href = '/login.html'; return; }
          done(true);
        } catch (x) {
          err.textContent = GENERIC; err.hidden = false; ok.disabled = false;
        }
      };
      dlg.showModal();
      q('ok').focus();
    });
  }

  // Resolve true when the session is (or becomes) strong enough.
  async function ensureStrong(message) {
    if (!(await needsChallenge())) return true;
    return promptPasskey(message);
  }

  // Old names kept for callers: the "code" is now the passkey.
  window.cpayMfa = { level, strong, needsChallenge, factors, promptPasskey, promptCode: promptPasskey, ensureStrong, ensureAal2: ensureStrong, GENERIC };
})();
