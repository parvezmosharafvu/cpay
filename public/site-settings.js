// Website footer: links that the owner controls from Admin → Settings
// (get_public_site_settings). The legal pages are linked only when the
// owner has published them (every legal field filled); the CPAY Wallet link
// only when its toggle is on. ci/check_legal.py allows this file to name
// the legal pages for that reason. No globals.
(function () {
  'use strict';
  const LEGAL = [['/terms', 'Terms'], ['/privacy', 'Privacy'], ['/refund', 'Refunds'], ['/contact', 'Contact']];
  async function run() {
    const client = window.supabaseClient;
    const list = document.querySelector('.foot-links');
    if (!client || !list) return;
    const { data, error } = await client.rpc('get_public_site_settings');
    if (error || !data) return;
    if (data.legal_published === true) {
      for (const [href, label] of LEGAL) {
        const li = document.createElement('li'); const a = document.createElement('a');
        a.href = href; a.textContent = label; li.appendChild(a); list.appendChild(li);
      }
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();
