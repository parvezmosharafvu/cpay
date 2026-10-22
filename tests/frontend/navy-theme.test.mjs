// The navy palette (CPAY design artifacts, 2026-10-17): the website, sign-in
// pages and desks opt in with <html data-ui="navy">; payment pages keep the
// light base under each merchant's chosen design. Every text pair meets
// WCAG AA, and the website says plainly that balances are held by CPAY.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pub = (f) => readFileSync(`public/${f}`, 'utf8');
const css = pub('cpay.css');

function block(selector) {
  const i = css.indexOf(`${selector}{`);
  assert.ok(i >= 0, `missing ${selector}`);
  const body = css.slice(i + selector.length + 1, css.indexOf('}', i));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

function rgba(v) {
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) return [0, 2, 4].map((k) => parseInt(m[1].slice(k, k + 2), 16)).concat(1);
  m = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(v.replace(/\s/g, ''));
  if (m) return [+m[1], +m[2], +m[3], +m[4]];
  throw new Error(`not a plain colour: ${v}`);
}
// A translucent colour as it shows over an opaque one.
const over = (top, base) => [0, 1, 2].map((k) => top[k] * top[3] + base[k] * (1 - top[3])).concat(1);
function luminance([r, g, b]) {
  const c = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}
const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const navy = block(':root[data-ui="navy"]');
const c = (name) => rgba(navy[name]);

test('navy text meets WCAG AA (4.5:1) on every surface it is used on', () => {
  const grounds = ['--bg', '--surface', '--surface-2', '--row-hover'];
  for (const fg of ['--text', '--muted', '--faint', '--accent']) {
    for (const bg of grounds) {
      const r = ratio(c(fg), c(bg));
      assert.ok(r >= 4.5, `${fg} on ${bg}: ${r.toFixed(2)}`);
    }
  }
  assert.ok(ratio(c('--on-accent'), c('--accent')) >= 4.5, 'primary button text');
  assert.ok(ratio(c('--on-accent'), c('--accent-hover')) >= 4.5, 'primary button hover');
  // Active navigation and tags: accent text on the soft accent tint.
  assert.ok(ratio(c('--accent'), over(c('--accent-soft'), c('--surface'))) >= 4.5, 'accent on accent-soft');
});

test('navy status colours meet WCAG AA on their own tints, and keep a visible edge', () => {
  for (const [fg, soft, line] of [
    ['--success', '--success-soft', '--success-line'],
    ['--danger', '--danger-soft', '--danger-line'],
    ['--warn', '--warn-soft', '--warn-line'],
    ['--info-fg', '--info-soft', '--info-line'],
  ]) {
    for (const base of ['--surface', '--bg']) {
      const tint = over(c(soft), c(base));
      const r = ratio(c(fg), tint);
      assert.ok(r >= 4.5, `${fg} on ${soft} over ${base}: ${r.toFixed(2)}`);
      assert.ok(ratio(over(c(line), c(base)), tint) >= 1.5, `${line} edge over ${base}`);
    }
  }
});

test('navy form fields and table edges stand out from the card (1.4.11, 3:1 for the focus ring)', () => {
  assert.ok(ratio(c('--line-strong'), c('--surface')) >= 1.6, 'input border visible');
  assert.ok(ratio(c('--accent'), c('--surface')) >= 3, 'focus outline');
  const raw = css.slice(css.indexOf(':root[data-ui="navy"]{'), css.indexOf('}', css.indexOf(':root[data-ui="navy"]{')));
  assert.match(raw, /color-scheme:dark;/, 'native controls and scrollbars follow the palette');
});

const SITE = ['index.html', 'login.html', 'register.html', 'reset.html', 'dashboard.html', 'admin.html', 'theme-preview.html', 'assets/wallet.html'];
const PAYMENT = ['404.html', 'invoice-cpay-v2.html', 'store.html'];

test('the website and desks opt in to navy; their browser colour metas match', () => {
  for (const f of SITE) {
    const s = pub(f);
    assert.match(s, /<html lang="en" data-ui="navy">/, f);
    assert.match(s, /<meta name="color-scheme" content="dark">/, f);
    assert.match(s, /<meta name="theme-color" content="#0a1120">/, f);
    assert.doesNotMatch(s, /content="light"/, f);
  }
  assert.equal(navy['--bg'], '#0a1120', 'theme-color is the navy page colour');
});

test('payment pages keep the light base and the merchant designs: no navy there', () => {
  for (const f of PAYMENT) {
    const s = pub(f);
    assert.doesNotMatch(s, /data-ui=/, f);
    assert.doesNotMatch(s, /color-scheme" content="dark"/, f);
  }
  // Designs live on <html> (theme.js setDesign). Script sets navy only in
  // useNavyState(), which the not-found states call; setDesign never does.
  assert.doesNotMatch(pub('app.js'), /data-ui/, 'app.js');
  const theme = pub('theme.js');
  const navyFn = theme.match(/function useNavyState\(\) \{[\s\S]*?\n\}/);
  assert.ok(navyFn, 'theme.js defines useNavyState');
  assert.doesNotMatch(theme.replace(navyFn[0], ''), /data-ui/, 'theme.js outside useNavyState');
});

test('not-found states switch to navy; the payment card does not', () => {
  const checkout = pub('404.html');
  const nf = checkout.match(/function showNotFound\(\)\{[\s\S]*?\n\}/);
  assert.ok(nf && /useNavyState\(\)/.test(nf[0]), '404.html showNotFound uses navy');
  assert.equal((checkout.match(/useNavyState\(/g) || []).length, 1, '404.html calls navy only for not-found');
  const store = pub('store.html');
  assert.equal((store.match(/useNavyState\(\)/g) || []).length, 3, 'store.html: missing, not-found and read-error branches');
});

test('legal pages are navy with no page-level styles', () => {
  for (const f of ['contact.html', 'privacy.html', 'terms.html', 'refund.html']) {
    const s = pub(f);
    assert.match(s, /<html lang="en" data-ui="navy">/, f);
    assert.match(s, /<body class="legal">/, f);
    assert.doesNotMatch(s, /<style>/, f);
  }
});

test('checkout previews inside a navy page show the payer view', () => {
  // Swatches and the theme stage get the light base at zero specificity, so a
  // design's own [data-layout] tokens still win over it.
  assert.match(css, /^:root,:where\(\[data-ui="navy"\]\) :where\(\.theme-stage,\.swatch\)\{/m);
  const light = block(':root,:where([data-ui="navy"]) :where(.theme-stage,.swatch)');
  assert.equal(light['--bg'], '#f6f7f9');
  assert.equal(light['--surface'], '#fff');
});

test('shared components read status colours from tokens, so both palettes work', () => {
  for (const rule of ['.alert-info{', '.alert-success{', '.alert-warn{', '.alert-danger{', '.callout{', '#toast{', '#toast.ok{', '.btn.danger{', '.design.on{', '.table tbody tr:hover td{', '.badge.completed{', '.badge.failed{']) {
    const i = css.indexOf(rule);
    assert.ok(i >= 0, rule);
    const body = css.slice(i, css.indexOf('}', i));
    assert.doesNotMatch(body, /#[0-9a-f]{3,6}\b/i, `${rule} has a fixed colour`);
  }
  assert.doesNotMatch(css.slice(css.indexOf('.skeleton{'), css.indexOf('.skeleton.line')), /#fff/, 'skeleton shimmer');
});

test('the website says CPAY holds website balances, and never calls itself non-custodial', () => {
  const home = pub('index.html');
  assert.match(home, /id="custody"/);
  assert.match(home, /With Auto withdraw off, your balance is <strong>held by CPAY<\/strong>/);
  assert.match(home, /CPAY Wallet, when it is released, is a separate app/);
  const desk = pub('freelancer-desk.js');
  assert.match(desk, /Held by CPAY, ready to withdraw/);
  assert.match(desk, /<strong id="wAvail">\$\{money\(b\.available\)\}<\/strong>, held by CPAY/);
  for (const f of ['index.html', 'login.html', 'register.html', 'reset.html', 'dashboard.html', 'admin.html', 'freelancer-desk.js', 'app.js']) {
    assert.doesNotMatch(pub(f), /non-?custodial|self-?custody|not your keys/i, f);
  }
});
