/**
 * CPAY payment-page layouts.
 * A layout changes how the payer enters an amount, not the colours. The
 * database still accepts the older names (tile, focus, receipt, ...); any
 * name missing here falls back to the domain default, then to keypad.
 */
const CPAY_LAYOUTS = {
  keypad:  { label: 'Keypad', help: 'Big amount over a number pad' },
  classic: { label: 'Amount field', help: 'Type an amount or pick a preset' },
};
const CPAY_DEFAULT_LAYOUT = 'keypad';
window.CPAY_LAYOUT = CPAY_DEFAULT_LAYOUT;
window.CPAY_LAYOUTS = CPAY_LAYOUTS;
async function applyDomainTheme() {
  const host = window.location.hostname;
  try {
    const { data, error } = await window.supabaseClient
      .from('site_domains')
      .select('hostname, theme')
      .eq('is_active', true);
    if (error || !data) return window.CPAY_LAYOUT;
    const row = data.find(d => (d.hostname || '').toLowerCase() === host.toLowerCase());
    const name = row && CPAY_LAYOUTS[row.theme] ? row.theme : CPAY_DEFAULT_LAYOUT;
    window.CPAY_LAYOUT = name;
    document.documentElement.setAttribute('data-layout', name);
    return name;
  } catch (e) {
    console.error('layout lookup failed:', e);
    return window.CPAY_LAYOUT;
  }
}
function applyLinkTheme(theme) {
  const name = theme && CPAY_LAYOUTS[theme] ? theme : window.CPAY_LAYOUT;
  window.CPAY_LAYOUT = name;
  document.documentElement.setAttribute('data-layout', name);
  return name;
}
