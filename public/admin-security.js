// Security: passkeys, on the admin desk (Admin → Security) and the
// Freelancer desk (Security). Since 2026-10-21 a passkey is the only second
// step: authenticator apps (TOTP) are retired and can no longer be added.
//
// The server treats a passkey sign-in as the strong factor
// (public.strong_session(), 20261021020000): admin work, payouts and payout
// address changes accept it where they used to ask for an authenticator code.
//
// Lockout guards: adding a second passkey, or removing one, needs a passkey
// sign-in first, so a stolen password alone cannot swap them. On the admin
// desk the last passkey cannot be removed (admins need one to sign in to
// admin work). The first passkey can be added after a normal sign-in.
(function () {
  let renderVersion = 0;
  let actionBusy = false;
  const root = () => document.querySelector('main > section#security');
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const say = (msg, ok) => { if (typeof toast === 'function') toast(msg, ok); };
  const adminDesk = /\/admin(\.html)?$/.test(location.pathname);

  async function confirmStrong(message) {
    if (!window.cpayMfa) return false;
    if (await window.cpayMfa.strong()) return true;
    return window.cpayMfa.promptPasskey(message);
  }

  function retryButton() {
    const button = el('button', 'btn ghost sm', 'Refresh security');
    button.type = 'button';
    button.dataset.role = 'refresh-security';
    button.onclick = render;
    return button;
  }
  async function securityAction(button, action) {
    if (actionBusy || button.disabled) return;
    actionBusy = true;
    button.disabled = true;
    try { await action(); }
    catch (error) { say('Security action could not be completed. Try again.'); }
    finally { actionBusy = false; button.disabled = false; await render(); }
  }
  async function render() {
    const sec = root();
    if (!sec || actionBusy) return;
    const version = ++renderVersion;
    sec.setAttribute('aria-busy', 'true');
    sec.replaceChildren(el('p', 'muted', 'Loading security settings…'));
    try {
      const card = await passkeyCard();
      if (version !== renderVersion) return;
      const intro = el('div', 'section-intro');
      const title = el('div');
      title.append(el('h2', null, 'Account security'), el('p', null, 'Manage sign-in credentials and keep a backup way to access your account.'));
      intro.append(title, retryButton());
      const recovery = el('div', 'card security-recovery');
      recovery.append(el('h3', null, 'Keep a backup passkey'), el('p', 'hint', 'Save a second passkey on another device or in a password manager. Check that it works before relying on it for recovery.'), el('p', 'faint', 'Withdrawals and receive-address changes require passkey confirmation.'));
      const fallback = el('div', 'card', 'Passkeys are not available right now.');
      sec.replaceChildren(intro, card || fallback, recovery);
      // Retained authenticator names are information only, not usable codes.
      try {
        const { verified } = await window.cpayMfa.factors();
        if (version !== renderVersion) return;
        if (verified.length) {
          const old = el('div', 'card');
          old.dataset.role = 'old-authenticators';
          old.append(el('h3', null, 'Authenticator app (no longer used)'));
          old.append(el('p', 'hint', 'CPAY now uses passkeys instead of authenticator codes. Add a passkey above; after that your old authenticator is not needed.'));
          old.append(el('p', 'muted', verified.map((f) => f.friendly_name || 'Authenticator').join(', ')));
          sec.append(old);
        }
      } catch (error) { /* Optional historical information only. */ }
    } catch (error) {
      if (version === renderVersion) sec.replaceChildren(el('div', 'card', 'Security settings could not be loaded.'), retryButton());
    } finally { if (version === renderVersion) sec.removeAttribute('aria-busy'); }
  }

  async function passkeyCard() {
    if (!window.cpayPasskey || !window.cpayAuthFeatures) return null;
    if (!(await window.cpayAuthFeatures()).passkeys) return null;
    const card = el('div', 'card');
    card.dataset.role = 'passkeys';
    const heading = el('div', 'card-title');
    heading.append(el('h3', null, 'Passkeys'));
    card.append(heading);
    card.append(el('p', 'hint', adminDesk
      ? 'Admin work needs a passkey sign-in. Add two passkeys (for example your phone and your password manager) so losing one device does not lock you out.'
      : 'Sign in, confirm payouts and change payout addresses with your fingerprint, face or screen lock. The passkey is kept by this device or your password manager.'));
    if (!window.cpayPasskey.supported()) {
      card.append(el('p', 'muted', 'This browser cannot use passkeys. Try an up-to-date Chrome, Safari, Edge or Firefox.'));
      return card;
    }
    let keys = [];
    try { keys = await window.cpayPasskey.list(); } catch (e) {
      card.append(el('p', 'muted', 'Your passkeys did not load. Refresh security to try again.'), retryButton());
      return card;
    }
    heading.append(el('span', 'badge', String(keys.length)));
    if (adminDesk) {
      const readiness = el('div', 'security-readiness');
      readiness.dataset.role = 'admin-mfa-readiness';
      const ready = keys.length >= 2, started = keys.length > 0;
      readiness.append(el('h4', null, 'Admin two-step sign-in'));
      readiness.append(el('p', ready ? 'ok' : 'hint',
        ready ? 'Two passkeys are registered. Keep both available as recovery methods.'
          : started ? 'One passkey registered. Add a second on another device or password manager before enabling stricter access policies.'
            : 'Setup required: register your first passkey before using protected admin actions.'));
      readiness.append(el('p', 'faint',
        'Admin sign-in requires a passkey; password alone cannot complete protected admin access. Authenticator codes are not used.'));
      if (started) {
        const verify = el('button', 'btn ghost sm', 'Verify my passkey');
        verify.type = 'button';
        verify.dataset.role = 'verify-admin-passkey';
        verify.onclick = () => securityAction(verify, async () => {
          const ok = await window.cpayMfa.promptPasskey('Check your registered admin passkey.');
          if (ok) say('Your passkey sign-in worked.', true);
        });
        readiness.append(verify);
      }
      card.append(readiness);
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
        if (adminDesk && keys.length <= 1) {
          rm.disabled = true;
          rm.title = 'Admins need a passkey: add another one before removing this one.';
        }
        rm.onclick = () => securityAction(rm, () => removePasskey(k, keys.length));
        li.append(label, rm);
        list.append(li);
      }
      card.append(list);
    } else {
      card.append(el('p', 'muted', 'No passkey yet.'));
    }
    const add = el('button', 'btn primary', keys.length ? 'Add another passkey' : 'Add a passkey');
    add.dataset.role = 'add-passkey';
    add.onclick = () => securityAction(add, async () => {
      // Preserve the existing strong-session gate for additional keys.
      if (keys.length && !(await confirmStrong('Use a passkey you already have, to add another.'))) return;
      const r = await window.cpayPasskey.register();
      if (r.cancelled) return;
      if (r.error) { say(r.error); return; }
      say('Passkey added. You can now sign in with it.', true);
    });
    card.append(add);
    return card;
  }

  async function removePasskey(k, count) {
    if (adminDesk && count <= 1) return;
    if (!(await confirmStrong('Confirm with your passkey to remove a passkey.'))) return;
    if (!window.confirm(`Remove the passkey "${k.friendly_name || 'Passkey'}"?`)) return;
    try { await window.cpayPasskey.remove(k.id); } catch (e) { say('Could not remove the passkey. Sign in again and retry.'); return; }
    say('Passkey removed', true);
  }

  document.querySelectorAll('.navi[data-tab="security"]').forEach((b) => b.addEventListener('click', () => render()));
  window.addEventListener('hashchange', () => { if (location.hash === '#security') render(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else render();
  window.cpayAdminSecurity = { render };
})();
