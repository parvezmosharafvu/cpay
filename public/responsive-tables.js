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
  const run = () => document.querySelectorAll('table.stack-sm').forEach(label);
  let queued = false;
  const queue = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; run(); }); };
  const start = () => { run(); new MutationObserver(queue).observe(document.body, { childList: true, subtree: true }); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
