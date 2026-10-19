// Legal pages: fill the owner's legal fields from Admin → Settings
// (get_public_site_settings) and, only once the owner has published them
// with every field filled, drop the "not yet published" note and noindex.
// No globals.
(function () {
  'use strict';
  async function run() {
    const client = window.supabaseClient;
    if (!client) return;
    const { data, error } = await client.rpc('get_public_site_settings');
    if (error || !data) return;
    document.querySelectorAll('[data-legal]').forEach((el) => {
      const v = data[el.dataset.legal];
      if (typeof v === 'string' && v.trim()) el.textContent = v;
    });
    if (data.legal_published === true) {
      document.querySelectorAll('[data-legal-note]').forEach((el) => el.remove());
      document.querySelectorAll('meta[name="robots"]').forEach((el) => el.remove());
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();
