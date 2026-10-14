// Two-step sign-in (TOTP) for the browser. Used by login.html (finish a
// sign-in at aal2), reauth.js (payout step-up: password, then the code) and
// the admin Security section (enrol / remove authenticators).
//
// The authenticator secret, the QR code and every code go only between the
// browser and Supabase Auth. Nothing here logs them, stores them or sends
// them anywhere else; error messages are deliberately generic.
(function () {
  const sb = () => window.supabaseClient;
  const GENERIC = 'That code did not work. Check the time on your phone and try the newest code.';
  const MAX_TRIES = 5;

  async function level() {
    const { data, error } = await sb().auth.mfa.getAuthenticatorAssuranceLevel();
    if (error) throw error;
    return data; // { currentLevel, nextLevel, currentAuthenticationMethods }
  }

  // True when this session has a verified factor but is still aal1, i.e. a
  // code is needed before anything that requires aal2.
  async function needsChallenge() {
    const l = await level();
    return l.currentLevel === 'aal1' && l.nextLevel === 'aal2';
  }

  async function factors() {
    const { data, error } = await sb().auth.mfa.listFactors();
    if (error) throw error;
    return { verified: data.totp || [], all: data.all || [] };
  }

  // Best effort, for the audit log only; never blocks or reveals anything.
  function noteFailure() {
    try { Promise.resolve(sb().rpc('record_mfa_challenge_failure')).catch(() => {}); } catch (e) { /* ignore */ }
  }

  // Ask for a 6-digit code and verify it against the first verified TOTP
  // factor. Resolves true once the session is aal2, false on cancel or
  // after MAX_TRIES wrong codes. Shown once per call: callers never retry
  // automatically, so there is no prompt loop.
  function promptCode(message) {
    return new Promise((resolve) => {
      const dlg = document.createElement('dialog');
      dlg.className = 'card reauth-dialog';
      dlg.setAttribute('aria-labelledby', 'mfaTitle');
      dlg.innerHTML = `<form method="dialog">
        <h3 id="mfaTitle">Enter your authentication code</h3>
        <p class="hint" data-role="msg"></p>
        <div class="field" data-role="pick" hidden><label for="mfaFactor">Authenticator</label>
          <select id="mfaFactor" data-role="factor"></select></div>
        <div class="field"><label for="mfaCode">6-digit code</label>
          <input id="mfaCode" data-role="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></div>
        <p class="hint" data-role="err" role="alert" hidden></p>
        <div class="row">
          <button class="btn ghost" type="button" data-role="cancel">Cancel</button>
          <button class="btn primary" type="submit" data-role="ok">Continue</button>
        </div></form>`;
      document.body.appendChild(dlg);
      const q = (r) => dlg.querySelector(`[data-role="${r}"]`);
      q('msg').textContent = message || 'Open your authenticator app and enter the current code for CPAY.';
      const input = q('code');
      const err = q('err');
      const pick = q('factor');
      let tries = 0;
      // With two authenticators (the recommended setup) the user picks which
      // one the code comes from; a backup device's code must work too.
      factors().then(({ verified }) => {
        if (verified.length < 2) return;
        for (const f of verified) { const o = document.createElement('option'); o.value = f.id; o.textContent = f.friendly_name || 'Authenticator'; pick.append(o); }
        q('pick').hidden = false;
      }).catch(() => {});
      const done = (ok) => { input.value = ''; dlg.close(); dlg.remove(); resolve(ok); };
      q('cancel').onclick = () => done(false);
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
      dlg.querySelector('form').onsubmit = async (e) => {
        e.preventDefault();
        const code = input.value.replace(/\s+/g, '');
        input.value = '';
        if (!/^\d{6}$/.test(code)) { err.textContent = 'Enter the 6 digits shown in your authenticator app.'; err.hidden = false; return; }
        const ok = q('ok');
        ok.disabled = true;
        err.hidden = true;
        try {
          const { verified } = await factors();
          if (!verified.length) throw new Error('none');
          const chosen = verified.find((f) => f.id === pick.value) || verified[0];
          const { error } = await sb().auth.mfa.challengeAndVerify({ factorId: chosen.id, code });
          if (error) throw error;
          done(true);
        } catch (x) {
          tries += 1;
          noteFailure();
          if (tries >= MAX_TRIES) { done(false); return; }
          err.textContent = GENERIC;
          err.hidden = false;
          ok.disabled = false;
          input.focus();
        }
      };
      dlg.showModal();
      input.focus();
    });
  }

  // Resolve true when the session is (or becomes) good enough: no factor
  // enrolled, already aal2, or the user enters a valid code now.
  async function ensureAal2(message) {
    if (!(await needsChallenge())) return true;
    return promptCode(message);
  }

  window.cpayMfa = { level, needsChallenge, factors, promptCode, ensureAal2, GENERIC };
})();
