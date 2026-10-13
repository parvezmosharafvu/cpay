// Admin → Security: two-step sign-in (TOTP authenticators).
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

  async function removeUnverified(all) {
    for (const f of all) if (f.status !== 'verified') await sb.auth.mfa.unenroll({ factorId: f.id }).catch(() => {});
  }

  async function render() {
    const sec = root();
    if (!sec || !window.cpayMfa) return;
    let verified = [];
    let all = [];
    try { ({ verified, all } = await window.cpayMfa.factors()); } catch (e) {
      sec.replaceChildren(el('div', 'card', 'Two-step sign-in settings did not load. Reload the page to try again.'));
      return;
    }
    const card = el('div', 'card');
    card.append(el('h3', null, 'Two-step sign-in'));
    card.append(el('p', verified.length ? 'ok' : 'muted', verified.length
      ? `On: ${verified.length} authenticator${verified.length > 1 ? 's' : ''}. Sign-in and payouts ask for a code.`
      : 'Off. Signing in needs only your password.'));
    card.append(el('p', 'hint', 'Add two authenticators (your phone and a backup device kept somewhere safe). CPAY cannot show recovery codes: if you lose every authenticator, recovery is the owner break-glass procedure in the runbooks.'));

    if (verified.length) {
      const list = el('ul', 'list');
      for (const f of verified) {
        const li = el('li');
        const added = f.created_at ? new Date(f.created_at).toLocaleDateString() : '';
        li.append(el('span', null, `${f.friendly_name || 'Authenticator'}${added ? ` (added ${added})` : ''} `));
        const rm = el('button', 'btn ghost sm', 'Remove');
        rm.dataset.factor = f.id;
        rm.onclick = () => removeFactor(f, verified.length);
        li.append(rm);
        list.append(li);
      }
      card.append(list);
    }

    const name = el('input');
    name.type = 'text'; name.maxLength = 40; name.placeholder = verified.length ? 'Backup device' : 'Phone';
    name.setAttribute('aria-label', 'Authenticator name');
    name.dataset.role = 'factor-name';
    const add = el('button', 'btn primary', verified.length ? 'Add another authenticator' : 'Turn on two-step sign-in');
    add.dataset.role = 'add-factor';
    add.onclick = () => startEnrol(name.value.trim() || name.placeholder, verified.length > 0, all);
    const row = el('div', 'row'); row.append(name, add);
    card.append(row);
    sec.replaceChildren(card);
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
