// Security: two-step sign-in (TOTP authenticators) and passkeys, on the
// admin desk (Admin → Security) and the Freelancer desk (Security).
//
// Enrolling the first authenticator works from a normal (aal1) session.
// Adding another, or removing one, needs the current code first (aal2);
// Supabase Auth refuses otherwise. CPAY shows no recovery codes, so two
// authenticators (phone + an offline backup device) is the recovery path;
// losing every one is the owner break-glass procedure in docs/RUNBOOKS.md.
//
// The secret and QR code are shown once, only in this section, and removed
// from the page as soon as enrolment finishes or is cancelled. Nothing here
// logs or stores them.
(function () {
  const sb = window.supabaseClient;
  const root = () => document.querySelector('main > section#security');
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const say = (msg, ok) => { if (typeof toast === 'function') toast(msg, ok); };
  const adminDesk = /\/admin(\.html)?$/.test(location.pathname);

  async function removeUnverified(all) {
    for (const f of all) if (f.status !== 'verified') await sb.auth.mfa.unenroll({ factorId: f.id }).catch(() => {});
  }

  // app_settings.admin_mfa_required (Admin → Settings). While it is on, an
  // admin's last authenticator cannot be removed (the database refuses too).
  async function required() {
    if (!adminDesk) return false;
    const { data } = await sb.from('app_settings').select('value').eq('key', 'admin_mfa_required').maybeSingle();
    return data?.value === true || data?.value === 'true';
  }

  async function render() {
    const sec = root();
    if (!sec || !window.cpayMfa) return;
    let verified = [];
    let all = [];
    let enforced = false;
    try { enforced = await required(); } catch (e) { enforced = false; }
    try { ({ verified, all } = await window.cpayMfa.factors()); } catch (e) {
      sec.replaceChildren(el('div', 'card', 'Two-step sign-in settings did not load. Reload the page to try again.'));
      return;
    }
    const card = el('div', 'card');
    card.append(el('h3', null, 'Two-step sign-in'));
    card.append(el('p', verified.length ? 'ok' : 'muted', verified.length
      ? `On: ${verified.length} authenticator${verified.length > 1 ? 's' : ''}. Sign-in and payouts ask for a code.`
      : 'Off. Signing in needs only your password.'));
    if (enforced) card.append(el('p', 'ok', 'Required for every admin (Admin → Settings).'));
    card.append(el('p', 'hint', adminDesk
      ? 'Add two authenticators (your phone and a backup device kept somewhere safe). CPAY cannot show recovery codes: if you lose every authenticator, recovery is the owner break-glass procedure in the runbooks.'
      : 'Use an authenticator app such as Google Authenticator, Microsoft Authenticator or 1Password. Add a second one on a backup device: CPAY cannot show recovery codes, so if you lose every authenticator you need to contact support to prove it is your account.'));

    if (verified.length) {
      const list = el('ul', 'list');
      for (const f of verified) {
        const li = el('li');
        const added = f.created_at ? new Date(f.created_at).toLocaleDateString() : '';
        li.append(el('span', null, `${f.friendly_name || 'Authenticator'}${added ? ` (added ${added})` : ''} `));
        const rm = el('button', 'btn ghost sm', 'Remove');
        rm.dataset.factor = f.id;
        if (enforced && verified.length <= 1) {
          rm.disabled = true;
          rm.title = 'Two-step sign-in is required for admins: add another authenticator before removing this one.';
        }
        rm.onclick = () => removeFactor(f, verified.length);
        li.append(rm);
        list.append(li);
      }
      card.append(list);
    }

    const name = el('input');
    name.type = 'text'; name.maxLength = 40; name.placeholder = verified.length ? 'Backup authenticator' : 'Google Authenticator';
    name.setAttribute('aria-label', 'Authenticator name');
    name.dataset.role = 'factor-name';
    const add = el('button', 'btn primary', verified.length ? 'Add another authenticator' : 'Turn on two-step sign-in');
    add.dataset.role = 'add-factor';
    add.onclick = () => startEnrol(name.value.trim() || name.placeholder, verified.length > 0, all);
    const row = el('div', 'row'); row.append(name, add);
    card.append(row);
    sec.replaceChildren(card);
    const pk = await passkeyCard(verified.length > 0);
    if (pk && root() === sec && sec.firstChild === card) sec.append(pk);
  }

  // Passkeys (passkey.js): sign in, and confirm payouts, with the device's
  // fingerprint, face or screen lock instead of the password. Shown only when
  // the owner has switched passkeys on in Supabase. Adding or removing one
  // asks for the authenticator code first when two-step sign-in is on, so a
  // stolen password alone cannot plant a passkey.
  async function passkeyCard(hasAuthenticator) {
    if (!window.cpayPasskey || !window.cpayAuthFeatures) return null;
    if (!(await window.cpayAuthFeatures()).passkeys) return null;
    const card = el('div', 'card');
    card.dataset.role = 'passkeys';
    card.append(el('h3', null, 'Passkeys'));
    card.append(el('p', 'hint', hasAuthenticator
      ? 'Sign in with your fingerprint, face or screen lock instead of your password. Two-step sign-in stays on: you still enter your authenticator code.'
      : 'Sign in with your fingerprint, face or screen lock instead of your password. The passkey is kept by this device or your password manager (Google Password Manager, iCloud Keychain, 1Password).'));
    if (!window.cpayPasskey.supported()) {
      card.append(el('p', 'muted', 'This browser cannot use passkeys. Try an up-to-date Chrome, Safari, Edge or Firefox.'));
      return card;
    }
    let keys = [];
    try { keys = await window.cpayPasskey.list(); } catch (e) {
      card.append(el('p', 'muted', 'Your passkeys did not load. Reload the page to try again.'));
      return card;
    }
    if (keys.length) {
      const list = el('ul', 'passkey-list');
      for (const k of keys) {
        const li = el('li');
        const label = el('span', 'pk-name', k.friendly_name || 'Passkey');
        const when = [k.created_at ? `added ${new Date(k.created_at).toLocaleDateString()}` : '', k.last_used_at ? `last used ${new Date(k.last_used_at).toLocaleDateString()}` : ''].filter(Boolean).join(' · ');
        if (when) label.append(el('span', 'pk-meta', when));
        const rm = el('button', 'btn ghost sm', 'Remove');
        rm.dataset.passkey = k.id;
        rm.onclick = () => removePasskey(k);
        li.append(label, rm);
        list.append(li);
      }
      card.append(list);
    } else {
      card.append(el('p', 'muted', 'No passkey yet.'));
    }
    const add = el('button', 'btn primary', keys.length ? 'Add another passkey' : 'Add a passkey');
    add.dataset.role = 'add-passkey';
    add.onclick = async () => {
      if (add.disabled) return;
      add.disabled = true;
      try {
        // Checked at click time (not from this card's render): an account
        // with an authenticator must be at aal2 first.
        if (!(await window.cpayMfa.ensureAal2('Enter your authenticator code to add a passkey.'))) return;
        const r = await window.cpayPasskey.register();
        if (r.cancelled) return;
        if (r.error) { say(r.error); return; }
        say('Passkey added. You can now sign in with it.', true);
        render();
      } finally { add.disabled = false; }
    };
    card.append(add);
    return card;
  }

  async function removePasskey(k) {
    if (!(await window.cpayMfa.ensureAal2('Enter your authenticator code to remove a passkey.'))) return;
    if (!window.confirm(`Remove the passkey "${k.friendly_name || 'Passkey'}"? You can still sign in with your password.`)) return;
    try { await window.cpayPasskey.remove(k.id); } catch (e) { say('Could not remove the passkey. Sign in again and retry.'); return; }
    say('Passkey removed', true);
    render();
  }

  async function startEnrol(friendlyName, hasVerified, all) {
    if (hasVerified && !(await window.cpayMfa.ensureAal2('Enter a code from an authenticator you already have, to add another.'))) return;
    await removeUnverified(all);
    const { data, error } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName, issuer: 'CPAY' });
    if (error || !data?.totp) { say('Could not start adding the authenticator. Try another name or reload.'); return; }
    const sec = root();
    const card = el('div', 'card');
    card.append(el('h3', null, 'Scan with your authenticator app'));
    const img = el('img'); img.alt = 'QR code for your authenticator app'; img.width = 200; img.height = 200; img.src = data.totp.qr_code;
    card.append(img);
    card.append(el('p', 'hint', 'Or type this key into the app:'));
    const key = el('code', null, data.totp.secret);
    key.dataset.role = 'totp-secret';
    card.append(key);
    const code = el('input');
    code.type = 'text'; code.inputMode = 'numeric'; code.autocomplete = 'one-time-code'; code.maxLength = 6;
    code.setAttribute('aria-label', '6-digit code from the app');
    code.dataset.role = 'enrol-code';
    const err = el('p', 'hint'); err.setAttribute('role', 'alert'); err.hidden = true;
    const ok = el('button', 'btn primary', 'Verify and turn on'); ok.dataset.role = 'enrol-verify';
    const cancel = el('button', 'btn ghost', 'Cancel'); cancel.dataset.role = 'enrol-cancel';
    const wipe = () => { key.textContent = ''; img.removeAttribute('src'); code.value = ''; };
    cancel.onclick = async () => { wipe(); await sb.auth.mfa.unenroll({ factorId: data.id }).catch(() => {}); render(); };
    ok.onclick = async () => {
      const c = code.value.replace(/\s+/g, '');
      code.value = '';
      if (!/^\d{6}$/.test(c)) { err.textContent = 'Enter the 6 digits shown in the app.'; err.hidden = false; return; }
      ok.disabled = true;
      const { error: vErr } = await sb.auth.mfa.challengeAndVerify({ factorId: data.id, code: c });
      if (vErr) { ok.disabled = false; err.textContent = window.cpayMfa.GENERIC; err.hidden = false; return; }
      wipe();
      say('Two-step sign-in is on for this authenticator', true);
      render();
    };
    const row = el('div', 'row'); row.append(code, ok, cancel);
    card.append(row, err);
    sec.replaceChildren(card);
    code.focus();
  }

  async function removeFactor(f, count) {
    if (!(await window.cpayMfa.ensureAal2('Enter your current code to remove an authenticator.'))) return;
    const last = count <= 1;
    const msg = last
      ? `Remove "${f.friendly_name || 'Authenticator'}"? It is your only authenticator: two-step sign-in turns off.`
      : `Remove "${f.friendly_name || 'Authenticator'}"?`;
    if (!window.confirm(msg)) return;
    const { error } = await sb.auth.mfa.unenroll({ factorId: f.id });
    if (error) { say('Could not remove the authenticator. Sign in again and retry.'); return; }
    say('Authenticator removed', true);
    render();
  }

  document.querySelectorAll('.navi[data-tab="security"]').forEach((b) => b.addEventListener('click', () => render()));
  window.addEventListener('hashchange', () => { if (location.hash === '#security') render(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else render();
  window.cpayAdminSecurity = { render };
})();
