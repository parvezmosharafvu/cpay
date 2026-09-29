/**
 * CPAY checkout designs for the payment page and the invoice page.
 *
 * Ten designs. A payment link stores its own payment-page theme and an
 * optional invoice-page theme. Domains do not pick a theme.
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

function setDesign(name, target) {
  const design = resolveDesign(name) || CPAY_DEFAULT_LAYOUT;
  const node = target || document.documentElement;
  node.setAttribute('data-layout', design);
  node.setAttribute('data-entry', CPAY_LAYOUTS[design].entry);
  loadDesignFont(design);
  if (!target) window.CPAY_LAYOUT = design;
  return design;
}

// Kept so older pages that still call it do not break. Domains do not theme.
async function applyDomainTheme() {
  return setDesign(CPAY_DEFAULT_LAYOUT);
}

function applyLinkTheme(theme) {
  return setDesign(resolveDesign(theme) || CPAY_DEFAULT_LAYOUT);
}

function invoiceDesignFor(invoiceTheme, linkDesign) {
  const v = String(invoiceTheme || '').toLowerCase();
  return (v && v !== 'default' && resolveDesign(v)) || resolveDesign(linkDesign) || window.CPAY_LAYOUT;
}
