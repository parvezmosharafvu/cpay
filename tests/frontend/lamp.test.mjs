import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pub = (f) => readFileSync(new URL(`../../public/${f}`, import.meta.url), 'utf8');

for (const [page, card] of [['login.html', 'loginCard'], ['register.html', 'registerCard']]) {
  test(`${page}: lamp is wired as an accessible toggle`, () => {
    const s = pub(page);
    assert.match(s, /<link rel="stylesheet" href="lamp\.css">/);
    assert.match(s, /<script src="lamp\.js"><\/script>/);
    const btn = s.match(/<button class="lamp-chain"[^>]*>/);
    assert.ok(btn, 'chain is a <button>');
    assert.match(btn[0], /type="button"/);
    assert.match(btn[0], /aria-pressed="false"/);
    assert.match(btn[0], new RegExp(`aria-controls="${card}"`));
    assert.match(btn[0], /aria-label="Turn on the light to sign in"/);
    assert.match(s, new RegExp(`id="${card}"`));
    // The form is never hidden in the markup; only lamp.js hides it.
    assert.doesNotMatch(s, /<main class="auth-card"[^>]*(inert|aria-hidden|hidden)/);
    assert.ok(s.indexOf('id="lampChain"') < s.indexOf('<main class="auth-card"'), 'chain comes before the form');
  });
}

test('lamp.css hides the form only under html.lamp-js and honours reduced motion', () => {
  const css = pub('lamp.css');
  assert.match(css, /\.lamp-js:not\(\.lamp-on\) \.auth-card\{/);
  assert.doesNotMatch(css.replace(/\.lamp-js[^{]*\{[^}]*\}/g, ''), /\.auth-card[^{]*\{[^}]*(opacity:0|display:none|visibility:hidden)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /color:var\(--on-accent/);
});

test('lamp.js: inert + aria-hidden while off, pointer, click and fallback', () => {
  const js = pub('lamp.js');
  for (const k of ["setAttribute('inert'", "setAttribute('aria-hidden'", "removeAttribute('inert')", 'pointerdown', 'pointerup', 'pointercancel', "'click'", 'aria-pressed', 'prefers-reduced-motion', 'location.hash', ':autofill', "classList.remove('lamp-js')"]) {
    assert.ok(js.includes(k), k);
  }
});
