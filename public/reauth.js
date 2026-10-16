// Step-up sign-in for payouts. When a confirm answers code "reauth_required"
// (the last real sign-in is older than a few minutes, or the account has an
// authenticator and the session is not aal2), ask the person to sign in
// again in a small dialog: with the password, a passkey (passkey.js) when
// the account has one, or Google when the account signs in with Google.
// Then ask for the authenticator code when one is enrolled (mfa.js), and let
// the caller retry once. The password and the code go only to Supabase Auth.
(function () {
  const sb = () => window.supabaseClient;

  // A passkey picks its own account; make sure it is this one.
  async function samePerson(beforeId, user) {
    if (user && user.id === beforeId) return true;
    await sb().auth.signOut();
    location.href = '/login.html';
    return false;
  }

  function ask(message) {
    return new Promise((resolve) => {
      const dlg = document.createElement('dialog');
      dlg.className = 'card reauth-dialog';
      dlg.setAttribute('aria-labelledby', 'reauthTitle');
      dlg.innerHTML = `<form method="dialog">
        <h3 id="reauthTitle">Confirm it is you</h3>
        <p class="hint" id="reauthMsg"></p>
        <div class="alt-confirm" id="reauthAlt" hidden>
          <button class="btn oauth-btn block" type="button" id="reauthPasskey" hidden>Use a passkey</button>
          <button class="btn oauth-btn block" type="button" id="reauthGoogle" hidden>Sign in with Google again</button>
        </div>
        <div class="field"><label for="reauthPw">Password</label>
          <input id="reauthPw" type="password" autocomplete="current-password" required></div>
        <p class="hint" id="reauthErr" role="alert" hidden></p>
        <div id="reauthCaptcha" class="captcha-box"></div>
        <div class="row">
          <button class="btn ghost" value="cancel" type="button" id="reauthCancel">Cancel</button>
          <button class="btn primary" value="ok" type="submit" id="reauthOk">Continue</button>
        </div></form>`;
      document.body.appendChild(dlg);
      dlg.querySelector('#reauthMsg').textContent = message || 'For your security, enter your password again to confirm this payout.';
      const pw = dlg.querySelector('#reauthPw');
      const err = dlg.querySelector('#reauthErr');
      const captchaBox = dlg.querySelector('#reauthCaptcha');
      const showErr = (t) => { err.textContent = t; err.hidden = false; };
      const done = (ok) => { dlg.close(); dlg.remove(); resolve(ok); };
      // A password or passkey sign-in is aal1. With an authenticator enrolled
      // the payout needs aal2, so ask for the code now instead of sending the
      // user round the dialog again (mfa.js).
      const finish = async () => {
        if (window.cpayMfa && await window.cpayMfa.needsChallenge()) {
          dlg.close(); dlg.remove();
          resolve(await window.cpayMfa.promptCode('Enter the code from your authenticator app to confirm this payout.'));
          return;
        }
        done(true);
      };
      dlg.querySelector('#reauthCancel').onclick = () => done(false);
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });

      // Other ways to confirm, shown only when they apply to this account.
      (async () => {
        try {
          const { data } = await sb().auth.getUser();
          const user = data?.user;
          if (!user) return;
          const pkBtn = dlg.querySelector('#reauthPasskey');
          const gBtn = dlg.querySelector('#reauthGoogle');
          if (window.cpayPasskey && await window.cpayPasskey.available()) {
            const keys = await window.cpayPasskey.list().catch(() => []);
            pkBtn.hidden = keys.length === 0;
          }
          gBtn.hidden = !(user.identities || []).some((i) => i && i.provider === 'google');
          dlg.querySelector('#reauthAlt').hidden = pkBtn.hidden && gBtn.hidden;
          pkBtn.onclick = async () => {
            if (pkBtn.disabled) return;
            pkBtn.disabled = true; err.hidden = true;
            try {
              const r = await window.cpayPasskey.signIn({ container: captchaBox });
              if (r.cancelled) return;
              if (r.error) { showErr(r.error); return; }
              if (!(await samePerson(user.id, r.user))) return;
              await finish();
            } finally { pkBtn.disabled = false; }
          };
          // Google returns to log in, then the desk; the payout starts again
          // from there, with a fresh sign-in.
          gBtn.onclick = async () => {
            gBtn.disabled = true;
            const { error } = await sb().auth.signInWithOAuth({
              provider: 'google',
              options: { redirectTo: `${location.origin}/login.html?via=google`, queryParams: { prompt: 'select_account' } },
            });
            if (error) { gBtn.disabled = false; showErr('Google sign-in is not available right now. Use your password.'); }
          };
        } catch (e) { /* the password stays available */ }
      })();

      dlg.querySelector('form').onsubmit = async (e) => {
        e.preventDefault();
        const btn = dlg.querySelector('#reauthOk');
        btn.disabled = true;
        err.hidden = true;
        try {
          const { data } = await sb().auth.getUser();
          const email = data?.user?.email;
          if (!email) throw new Error('Sign in again to continue.');
          // Supabase Auth CAPTCHA applies to this sign-in too (turnstile.js).
          let captcha = {};
          if (window.cpayCaptchaOptions) captcha = await window.cpayCaptchaOptions('reauth', { container: captchaBox });
          const { error } = await sb().auth.signInWithPassword({ email, password: pw.value, options: captcha });
          pw.value = '';
          if (error && window.cpayIsCaptchaError && window.cpayIsCaptchaError(error)) throw new Error(window.CPAY_CAPTCHA_MESSAGE);
          if (error) throw new Error('That password is not right.');
          await finish();
        } catch (x) {
          showErr(x.message || 'Could not confirm. Try again.');
          btn.disabled = false;
        }
      };
      dlg.showModal();
      pw.focus();
    });
  }
  window.cpayReauth = ask;
  // Runs fn(); if it reports reauth_required, asks once and runs it again.
  // isReauth(resultOrError) decides; by default it reads .data.code or .code.
  window.cpayWithStepUp = async function (fn, isReauth) {
    const check = isReauth || ((r) => (r && (r.code === 'reauth_required' || (r.data && r.data.code === 'reauth_required'))));
    let first;
    try { first = await fn(); } catch (e) { if (!check(e)) throw e; first = e; }
    if (!check(first)) return first;
    const msg = (first && (first.message || (first.data && first.data.error))) || undefined;
    if (!(await ask(msg))) return first instanceof Error ? Promise.reject(first) : first;
    return fn();
  };
})();
