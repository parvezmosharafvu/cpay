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
  const sb = window.supabaseClient;
  const root = () => document.querySelector('main > section#security');
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const say = (msg, ok) => { if (typeof toast === 'function') toast(msg, ok); };
  const adminDesk = /\/admin(\.html)?$/.test(location.pathname);

  async function confirmStrong(message) {
    if (!window.cpayMfa) return false;
    if (await window.cpayMfa.strong()) return true;
    return window.cpayMfa.promptPasskey(message);
  }

  async function render() {
    const sec = root();
    if (!sec) return;
    const card = await passkeyCard();
    if (!card) { sec.replaceChildren(el('div', 'card', 'Passkeys are not available right now.')); return; }
    sec.replaceChildren(card);
    // Old authenticator apps: shown only so their owner knows they are no
    // longer asked for. They are removed by support after a passkey works.
    try {
      const { verified } = await window.cpayMfa.factors();
      if (verified.length) {
        const old = el('div', 'card');
        old.dataset.role = 'old-authenticators';
        old.append(el('h3', null, 'Authenticator app (no longer used)'));
        old.append(el('p', 'hint', 'CPAY now uses passkeys instead of authenticator codes. Add a passkey above; after that your old authenticator is not needed.'));
        old.append(el('p', 'muted', verified.map((f) => f.friendly_name || 'Authenticator').join(', ')));
        sec.append(old);
      }
    } catch (e) { /* nothing to show */ }
  }

  async function passkeyCard() {
    if (!window.cpayPasskey || !window.cpayAuthFeatures) return null;
    if (!(await window.cpayAuthFeatures()).passkeys) return null;
    const card = el('div', 'card');
    card.dataset.role = 'passkeys';
    card.append(el('h3', null, 'Passkeys'));
    card.append(el('p', 'hint', adminDesk
      ? 'Admin work needs a passkey sign-in. Add two passkeys (for example your phone and your password manager) so losing one device does not lock you out.'
      : 'Sign in, confirm payouts and change payout addresses with your fingerprint, face or screen lock. The passkey is kept by this device or your password manager.'));
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
        if (adminDesk && keys.length <= 1) {
          rm.disabled = true;
          rm.title = 'Admins need a passkey: add another one before removing this one.';
        }
        rm.onclick = () => removePasskey(k, keys.length);
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
        // A second passkey needs the first one: a stolen password alone
        // cannot add its own passkey to an account that already has one.
        if (keys.length && !(await confirmStrong('Use a passkey you already have, to add another.'))) return;
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

  async function removePasskey(k, count) {
    if (adminDesk && count <= 1) return;
    if (!(await confirmStrong('Confirm with your passkey to remove a passkey.'))) return;
    if (!window.confirm(`Remove the passkey "${k.friendly_name || 'Passkey'}"?`)) return;
    try { await window.cpayPasskey.remove(k.id); } catch (e) { say('Could not remove the passkey. Sign in again and retry.'); return; }
    say('Passkey removed', true);
    render();
  }

  document.querySelectorAll('.navi[data-tab="security"]').forEach((b) => b.addEventListener('click', () => render()));
  window.addEventListener('hashchange', () => { if (location.hash === '#security') render(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else render();
  window.cpayAdminSecurity = { render };
})();
