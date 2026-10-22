// Phone layout for wide tables: a table with class "stack-sm" shows each row
// as a card under 640px. This copies every column header onto its cells
// (data-label) so the CSS can print "Balance  1,000 sats" on each line.
(function () {
  'use strict';
  function label(table) {
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    table.querySelectorAll('tbody tr').forEach((tr) => {
      [...tr.children].forEach((td, i) => {
        if (td.colSpan > 1) { td.dataset.label = ''; return; }
        if (heads[i] != null && td.dataset.label !== heads[i]) td.dataset.label = heads[i];
      });
    });
  }
  function scrollFocus(region) {
    const style = getComputedStyle(region);
    const overflowing = region.clientWidth > 0 && region.scrollWidth > region.clientWidth + 1 && /auto|scroll/.test(style.overflowX);
    if (overflowing && !region.hasAttribute('tabindex')) {
      region.tabIndex = 0;
      region.dataset.tableScrollFocus = '1';
      if (!region.hasAttribute('role') && !region.hasAttribute('aria-label') && !region.hasAttribute('aria-labelledby')) {
        const heading = region.closest('.card')?.querySelector('h2,h3,h4') || region.closest('section')?.querySelector('h2,h3');
        region.setAttribute('role', 'region');
        region.setAttribute('aria-label', heading?.textContent.trim() || (document.documentElement.lang === 'bn' ? 'স্ক্রলযোগ্য টেবিল' : 'Scrollable table'));
        region.dataset.tableScrollName = '1';
      }
    } else if (!overflowing && region.dataset.tableScrollFocus === '1') {
      region.removeAttribute('tabindex');
      delete region.dataset.tableScrollFocus;
      if (region.dataset.tableScrollName === '1') {
        region.removeAttribute('role'); region.removeAttribute('aria-label');
        delete region.dataset.tableScrollName;
      }
    }
  }
  const run = () => {
    document.querySelectorAll('table.stack-sm').forEach(label);
    document.querySelectorAll('.scroll, .card.flush').forEach(region => {
      if (region.querySelector('table')) scrollFocus(region);
    });
  };
  let queued = false;
  const queue = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; run(); }); };
  const start = () => { run(); new MutationObserver(queue).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] }); window.addEventListener('resize', queue); document.addEventListener('cpay:lang', queue); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
