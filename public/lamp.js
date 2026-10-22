/* Pull-chain lamp for the log-in and register pages (docs/DESIGN-SYSTEM.md).
   Progressive enhancement: the form is only hidden once this script has
   added html.lamp-js, so without JavaScript the form simply shows. The form
   starts visible; explicitly switching the light off makes it inert and aria-hidden. */
(function () {
  'use strict';
  var root = document.documentElement;
  root.classList.add('lamp-js');

  var OPEN_PARAMS = ['error', 'error_code', 'error_description', 'confirmed', 'code', 'token', 'token_hash', 'type'];

  function urlWantsForm() {
    if (location.hash && location.hash.length > 1) return true;
    try {
      var q = new URLSearchParams(location.search);
      return OPEN_PARAMS.some(function (k) { return q.has(k); });
    } catch (e) { return false; }
  }

  function init() {
    var chain = document.getElementById('lampChain');
    var lamp = document.querySelector('[data-lamp]');
    var target = chain && document.getElementById(chain.getAttribute('aria-controls'));
    var region = target && target.closest('.auth-card');
    if (!chain || !lamp || !region) { root.classList.remove('lamp-js'); return; }

    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
    var on = false;

    function set(next, opts) {
      on = !!next;
      root.classList.toggle('lamp-on', on);
      chain.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on) { region.removeAttribute('inert'); region.removeAttribute('aria-hidden'); }
      else {
        // Never hide the form while focus or a message is inside it.
        if (region.contains(document.activeElement)) chain.focus();
        region.setAttribute('inert', ''); region.setAttribute('aria-hidden', 'true');
      }
      if (!(opts && opts.quiet) && !(reduce && reduce.matches)) {
        lamp.classList.remove('tug'); void lamp.offsetWidth; lamp.classList.add('tug');
      }
    }
    window.cpayLamp = { open: function () { if (!on) set(true, { quiet: true }); }, isOn: function () { return on; } };

    set(true, { quiet: true });

    // Drag the chain down and let go; a tap, Enter or Space also toggles.
    var startY = null, pulled = 0, dragged = false, MAX = 72, THRESHOLD = 28;
    chain.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      startY = e.clientY; pulled = 0; dragged = false;
      try { chain.setPointerCapture(e.pointerId); } catch (err) {}
      lamp.classList.add('dragging');
    });
    chain.addEventListener('pointermove', function (e) {
      if (startY === null) return;
      pulled = Math.max(0, Math.min(MAX, e.clientY - startY));
      if (pulled > 4) dragged = true;
      lamp.style.setProperty('--pull', pulled + 'px');
    });
    function release() {
      if (startY === null) return;
      startY = null;
      lamp.classList.remove('dragging');
      lamp.style.setProperty('--pull', '0px');
      if (dragged) {
        if (pulled >= THRESHOLD) set(!on, { quiet: true });
        chain.dataset.suppressClick = '1';
        setTimeout(function () { delete chain.dataset.suppressClick; }, 0);
      }
    }
    chain.addEventListener('pointerup', release);
    chain.addEventListener('pointercancel', release);
    chain.addEventListener('click', function () {
      if (chain.dataset.suppressClick) { delete chain.dataset.suppressClick; return; }
      set(!on);
    });

    // Show the form without a pull when the page needs it: a URL hash or
    // auth result, a password manager filling the fields, or a message.
    if (urlWantsForm()) set(true, { quiet: true });
    window.addEventListener('hashchange', function () { if (urlWantsForm()) set(true, { quiet: true }); });
    region.addEventListener('input', function () { if (!on) set(true, { quiet: true }); }, true);
    function checkAutofill() {
      if (on) return;
      var filled = region.querySelectorAll('input');
      for (var i = 0; i < filled.length; i++) {
        var el = filled[i], af = false;
        try { af = el.matches(':autofill'); } catch (e) { try { af = el.matches(':-webkit-autofill'); } catch (e2) {} }
        if (af || (el.type !== 'radio' && el.type !== 'checkbox' && el.value)) { set(true, { quiet: true }); return; }
      }
    }
    region.addEventListener('animationstart', function (e) { if (e.animationName === 'cpay-autofill') set(true, { quiet: true }); }, true);
    [300, 1200, 2500].forEach(function (t) { setTimeout(checkAutofill, t); });
    if (window.MutationObserver) {
      new MutationObserver(function () {
        if (on) return;
        var msg = region.querySelector('[role="alert"]:not([hidden]), #okMsg:not([hidden]), #confirmBox:not([hidden]), #successMsg:not([hidden])');
        if (msg) set(true, { quiet: true });
      }).observe(region, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
    }
  }

  function safeInit() { try { init(); } catch (e) { root.classList.remove('lamp-js'); } }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', safeInit);
  else safeInit();
})();
