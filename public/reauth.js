// Step-up sign-in for payouts. When a confirm answers code "reauth_required"
// (the last real sign-in is older than a few minutes, or the account has an
// authenticator and the session is not aal2), ask the person to sign in
// again in a small dialog: with a passkey (passkey.js) when the account has
// one, or the password. An account that needs the strong factor (an old
// authenticator on it) must use the passkey (mfa.js). Then the caller
// retries once. The password goes only to Supabase Auth.
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
      dlg.querySelector('#reauthMsg').textContent = message || 'For your security, sign in again with your passkey or password to confirm this payout.';
      const pw = dlg.querySelector('#reauthPw');
      const err = dlg.querySelector('#reauthErr');
      const captchaBox = dlg.querySelector('#reauthCaptcha');
      const showErr = (t) => { err.textContent = t; err.hidden = false; };
      const done = (ok) => { dlg.close(); dlg.remove(); resolve(ok); };
      // A password sign-in is not strong. When the account needs the strong
      // factor (an old authenticator on it), ask for the passkey now instead
      // of sending the user round the dialog again (mfa.js).
      const finish = async () => {
        if (window.cpayMfa && await window.cpayMfa.needsChallenge()) {
          dlg.close(); dlg.remove();
          resolve(await window.cpayMfa.promptPasskey('Use your passkey to confirm this payout.'));
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
          if (window.cpayPasskey && await window.cpayPasskey.available()) {
            const keys = await window.cpayPasskey.list().catch(() => []);
            pkBtn.hidden = keys.length === 0;
          }
          dlg.querySelector('#reauthAlt').hidden = pkBtn.hidden;
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
    // Payout address changes need a passkey session; a password cannot do.
    const reason = first && (first.reason || (first.data && first.data.reason));
    const text = String((first && ((first.error && first.error.message) || first.message || (first.data && first.data.error))) || '');
    if (reason === 'passkey_required' || /Confirm with your passkey to change address/.test(text)) {
      if (!window.cpayMfa || !(await window.cpayMfa.promptPasskey('Confirm with your passkey to change address'))) return first instanceof Error ? Promise.reject(first) : first;
      return fn();
    }
    if (!(await ask(msg))) return first instanceof Error ? Promise.reject(first) : first;
    return fn();
  };
})();
