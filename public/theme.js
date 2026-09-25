/**
 * CPAY checkout designs.
 *
 * Ten designs, named after the ten payment-page values the database accepts
 * (payment_links.theme and site_domains.theme, migrations 0069/0070/0091).
 * Each design sets the colours, type and shape of the payment-link page, the
 * invoice page and the storefront through the tokens in cpay.css.
 * `entry` says how the payer types an amount on the payment-link page.
 *
 * Older, narrower value sets map onto the same ten designs:
 *   payment_links.invoice_theme ('default' follows the link's own design)
 *   profiles.store_theme
 */
const CPAY_LAYOUTS = {
  keypad:    { label: 'Standard',  entry: 'keypad', help: 'Clean light checkout with a number pad' },
  classic:   { label: 'Classic',   entry: 'field',  help: 'Amount field with preset amounts, calm blue' },
  tile:      { label: 'Tile',      entry: 'keypad', help: 'Bold green page with large key tiles',
               font: 'Manrope:wght@500..800' },
  focus:     { label: 'Focus',     entry: 'keypad', help: 'Dark, quiet checkout with a mint accent' },
  receipt:   { label: 'Receipt',   entry: 'keypad', help: 'Printed receipt with monospaced totals',
               font: 'IBM+Plex+Mono:wght@400;500;600' },
  pulse:     { label: 'Pulse',     entry: 'keypad', help: 'Violet gradient header, friendly and modern',
               font: 'Plus+Jakarta+Sans:wght@400..800' },
  ledger:    { label: 'Ledger',    entry: 'field',  help: 'Formal invoice layout in navy, split on desktop',
               font: 'IBM+Plex+Sans:wght@400;500;600;700' },
  studio:    { label: 'Studio',    entry: 'keypad', help: 'Editorial black and cream with serif figures',
               font: 'Fraunces:opsz,wght@9..144,500..700' },
  boulevard: { label: 'Boulevard', entry: 'keypad', help: 'Warm sunset colours with rounded pill buttons',
               font: 'DM+Sans:opsz,wght@9..40,400..700' },
  aurora:    { label: 'Aurora',    entry: 'keypad', help: 'Frosted glass over a deep blue night sky',
               font: 'Space+Grotesk:wght@400..700' },
};
const CPAY_INVOICE_THEME_MAP = { compact: 'ledger', poster: 'tile', night: 'focus', cashier: 'receipt' };
const CPAY_STORE_THEME_MAP = { midnight: 'focus', snow: 'classic', glass: 'aurora', sunset: 'boulevard' };
const CPAY_DEFAULT_LAYOUT = 'keypad';
window.CPAY_LAYOUT = CPAY_DEFAULT_LAYOUT;
window.CPAY_LAYOUTS = CPAY_LAYOUTS;
window.CPAY_INVOICE_THEME_MAP = CPAY_INVOICE_THEME_MAP;
window.CPAY_STORE_THEME_MAP = CPAY_STORE_THEME_MAP;

// Any saved value, from any of the three columns, to one of the ten designs.
// Unknown or empty values return null so the caller can fall back.
function resolveDesign(value) {
  const v = String(value || '').toLowerCase();
  if (CPAY_LAYOUTS[v]) return v;
  return CPAY_INVOICE_THEME_MAP[v] || CPAY_STORE_THEME_MAP[v] || null;
}

function loadDesignFont(name) {
  const spec = CPAY_LAYOUTS[name] && CPAY_LAYOUTS[name].font;
  if (!spec || document.querySelector(`link[data-design-font="${name}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${spec}&display=swap`;
  link.dataset.designFont = name;
  document.head.appendChild(link);
}

// Sets the design on <html> (or on `target`, for the preview page).
function setDesign(name, target) {
  const design = resolveDesign(name) || CPAY_DEFAULT_LAYOUT;
  const node = target || document.documentElement;
  node.setAttribute('data-layout', design);
  node.setAttribute('data-entry', CPAY_LAYOUTS[design].entry);
  loadDesignFont(design);
  if (!target) window.CPAY_LAYOUT = design;
  return design;
}

async function applyDomainTheme() {
  const host = window.location.hostname;
  try {
    const { data, error } = await window.supabaseClient
      .from('site_domains')
      .select('hostname, theme')
      .eq('is_active', true);
    if (error || !data) return setDesign(window.CPAY_LAYOUT);
    const row = data.find(d => (d.hostname || '').toLowerCase() === host.toLowerCase());
    return setDesign(row && resolveDesign(row.theme) ? row.theme : CPAY_DEFAULT_LAYOUT);
  } catch (e) {
    console.error('layout lookup failed:', e);
    return setDesign(window.CPAY_LAYOUT);
  }
}

// A link's own design; NULL keeps whatever the domain resolved to.
function applyLinkTheme(theme) {
  return setDesign(resolveDesign(theme) || window.CPAY_LAYOUT);
}

// The invoice page design: the link's invoice_theme when it is set to
// something other than 'default', otherwise the link's payment design.
function invoiceDesignFor(invoiceTheme, linkDesign) {
  const v = String(invoiceTheme || '').toLowerCase();
  return (v && v !== 'default' && resolveDesign(v)) || resolveDesign(linkDesign) || window.CPAY_LAYOUT;
}
