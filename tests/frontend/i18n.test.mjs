// Dashboard language (public/i18n.js): every menu label on both dashboards
// has a Bangla text, the switch is on both pages, and the Settings owner
// sections build their text with DOM nodes (no innerHTML).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL(`../../public/${f}`, import.meta.url), 'utf8');

function phrases() {
  const ctx = { window: {}, document: { readyState: 'loading', addEventListener() {} }, localStorage: { getItem: () => null } };
  vm.runInNewContext(read('i18n.js'), ctx);
  return ctx.window.cpayI18n.phrases;
}

test('every Bangla text is non-empty and Bangla (or a product name)', () => {
  for (const [en, bn] of Object.entries(phrases())) {
    assert.ok(bn && bn.trim(), `empty Bangla for "${en}"`);
    assert.ok(/[ঀ-৿]/.test(bn) || /^(Cloudflare|CPAY)/.test(bn), `"${en}" -> "${bn}" is not Bangla`);
  }
});

for (const page of ['admin.html', 'dashboard.html']) {
  test(`${page}: loads i18n.js and every menu label has Bangla`, () => {
    const html = read(page);
    assert.match(html, /<script src="i18n\.js/, 'i18n.js loaded');
    assert.match(html, /Noto\+Sans\+Bengali/, 'Bangla font loaded');
    const bn = phrases();
    const labels = [...html.matchAll(/<span class="navi-label">([^<]+)<\/span>|<p class="side-label"[^>]*>([^<]+)<\/p>|<div class="kicker">([^<]+)<\/div>/g)]
      .map((m) => (m[1] || m[2] || m[3]).trim());
    assert.ok(labels.length > 5, 'found the menu');
    for (const l of labels) assert.ok(bn[l], `${page}: no Bangla for menu label "${l}"`);
  });
}

test('Settings owner sections never use innerHTML', () => {
  const src = read('admin-owner-settings.js');
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(read('admin.html'), /<script src="admin-owner-settings\.js/);
});
