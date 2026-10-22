// Presentation helpers only. Auth requests and validation stay in each page.
(function () {
  'use strict';
  function start() {
    const controls = [];
    const t = (text) => window.cpayI18n ? window.cpayI18n.t(text) : text;
    document.querySelectorAll('.auth-card input[type="password"]').forEach((input) => {
      if (input.closest('.password-control')) return;
      const wrap = document.createElement('div');
      wrap.className = 'password-control';
      input.parentNode.insertBefore(wrap, input);
      wrap.append(input);
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'password-toggle';
      toggle.dataset.noI18n = '';
      toggle.setAttribute('aria-controls', input.id);
      function paint() {
        const shown = input.type === 'text';
        toggle.textContent = t(shown ? 'Hide' : 'Show');
        toggle.setAttribute('aria-label', t(shown ? 'Hide password' : 'Show password'));
        toggle.setAttribute('aria-pressed', String(shown));
      }
      toggle.addEventListener('click', () => {
        input.type = input.type === 'password' ? 'text' : 'password';
        paint();
      });
      controls.push(paint);
      wrap.append(toggle);
      paint();
    });
    document.addEventListener('cpay:lang', () => controls.forEach((paint) => paint()));
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target;
      const id = target && target.dataset && target.dataset.enterSubmit;
      if (!id) return;
      const button = document.getElementById(id);
      if (!button || button.disabled || button.closest('[hidden], [inert]')) return;
      event.preventDefault();
      button.click();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
