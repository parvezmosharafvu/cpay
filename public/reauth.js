// Step-up sign-in for payouts. When a confirm answers code "reauth_required"
// (the last real sign-in is older than a few minutes), ask for the password
// in a small dialog, sign in again with the same email, and let the caller
// retry once. The password goes only to Supabase Auth.
(function () {
  function ask(message) {
    return new Promise((resolve) => {
      const dlg = document.createElement('dialog');
      dlg.className = 'card reauth-dialog';
      dlg.setAttribute('aria-labelledby', 'reauthTitle');
      dlg.innerHTML = `<form method="dialog">
        <h3 id="reauthTitle">Confirm it is you</h3>
        <p class="hint" id="reauthMsg"></p>
        <div class="field"><label for="reauthPw">Password</label>
          <input id="reauthPw" type="password" autocomplete="current-password" required></div>
        <p class="hint" id="reauthErr" role="alert" hidden></p>
        <div class="row">
          <button class="btn ghost" value="cancel" type="button" id="reauthCancel">Cancel</button>
          <button class="btn primary" value="ok" type="submit" id="reauthOk">Continue</button>
        </div></form>`;
      document.body.appendChild(dlg);
      dlg.querySelector('#reauthMsg').textContent = message || 'For your security, enter your password again to confirm this payout.';
      const pw = dlg.querySelector('#reauthPw');
      const err = dlg.querySelector('#reauthErr');
      const done = (ok) => { dlg.close(); dlg.remove(); resolve(ok); };
      dlg.querySelector('#reauthCancel').onclick = () => done(false);
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
      dlg.querySelector('form').onsubmit = async (e) => {
        e.preventDefault();
        const btn = dlg.querySelector('#reauthOk');
        btn.disabled = true;
        err.hidden = true;
        try {
          const sb = window.supabaseClient;
          const { data } = await sb.auth.getUser();
          const email = data?.user?.email;
          if (!email) throw new Error('Sign in again to continue.');
          const { error } = await sb.auth.signInWithPassword({ email, password: pw.value });
          pw.value = '';
          if (error) throw new Error('That password is not right.');
          done(true);
        } catch (x) {
          err.textContent = x.message || 'Could not confirm. Try again.';
          err.hidden = false;
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
