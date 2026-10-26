// Phone layout for wide tables: a table with class "stack-sm" shows each row
// as a card under 640px. This copies every column header onto its cells
// (data-label) so the CSS can print "Balance  1,000 sats" on each line.
(function () {
  'use strict';
  // .rtable tables (cards when their box is under 640px) get the same labels,
  // except cells whose script already wrote one.
  function label(table) {
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    const keep = !table.classList.contains('stack-sm');
    table.querySelectorAll('tbody tr').forEach((tr) => {
      [...tr.children].forEach((td, i) => {
        if (keep && td.hasAttribute('data-label') && td.dataset.auto !== '1') return;
        if (keep) td.dataset.auto = '1';
        if (td.colSpan > 1) { td.dataset.label = ''; return; }
        if (heads[i] != null && td.dataset.label !== heads[i]) td.dataset.label = heads[i];
      });
      if (keep) fold(tr);
    });
  }
  // Tap to expand (cards only, under 640px): a row shows its first two
  // cells, its status and its actions; a tap or Enter shows the rest. Rows
  // that already open a details view (.row-open) are left alone.
  const INTERACTIVE = 'a,button,input,select,textarea,summary,details,label,[contenteditable]';
  function fold(tr) {
    const cells = [...tr.children];
    if (tr.classList.contains('row-open') || tr.closest('[data-nofold]') || cells.length < 4 || cells.some((td) => td.colSpan > 1)) return;
    tr.classList.add('rt-fold');
    cells.forEach((td, i) => {
      const peek = i < 2 || td.classList.contains('lead') || td.classList.contains('table-actions') || !!td.querySelector('.badge');
      if (peek) delete td.dataset.more; else td.dataset.more = '1';
    });
    // The keyboard/screen-reader control: a real button in the first cell
    // (hidden while the table shows as a table).
    if (!cells[0].querySelector(':scope > .rt-toggle')) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'rt-toggle';
      b.setAttribute('aria-expanded', String(tr.classList.contains('open')));
      b.textContent = document.documentElement.lang === 'bn' ? 'বিস্তারিত' : 'Details';
      cells[0].append(b);
    }
  }
  function toggle(tr) {
    const open = !tr.classList.contains('open');
    tr.classList.toggle('open', open);
    const b = tr.querySelector('.rt-toggle');
    if (b) b.setAttribute('aria-expanded', String(open));
  }
  document.addEventListener('click', (e) => {
    const tr = e.target.closest && e.target.closest('tr.rt-fold');
    if (!tr) return;
    if (e.target.closest('.rt-toggle')) { toggle(tr); return; }
    if (e.target.closest(INTERACTIVE)) return;
    toggle(tr);
  });
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
    document.querySelectorAll('table.stack-sm, table.rtable').forEach(label);
    document.querySelectorAll('.scroll, .card.flush').forEach(region => {
      if (region.querySelector('table')) scrollFocus(region);
    });
  };
  let queued = false;
  const queue = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; run(); }); };
  const start = () => { run(); new MutationObserver(queue).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] }); window.addEventListener('resize', queue); document.addEventListener('cpay:lang', queue); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
