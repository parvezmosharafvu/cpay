// The theme preview must show the Standard (default) design the way the
// payment page and the invoice show it. Those rules are keyed on
// body.checkout / body.invoice, so cpay.css gives the preview stage the same
// rules through data-stage="pay" | "invoice", and the preview switches it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../../public/cpay.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../../public/theme-preview.html', import.meta.url), 'utf8');

test('every Standard checkout rule also covers the preview stage', () => {
  const lines = css.split('\n').filter((l) => l.includes('[data-layout="keypad"] body.'));
  assert.ok(lines.length >= 25, `expected the Standard rules, found ${lines.length}`);
  for (const line of lines) {
    const pay = line.includes('body.checkout:not(.invoice)');
    const want = pay ? '.theme-stage[data-layout="keypad"][data-stage="pay"]' : '.theme-stage[data-layout="keypad"][data-stage="invoice"]';
    const pageSelectors = (line.match(/\[data-layout="keypad"\] body\./g) || []).length;
    const stageSelectors = line.split(want).length - 1;
    assert.equal(stageSelectors, pageSelectors, `preview stage missing in: ${line.slice(0, 120)}`);
  }
});

test('the preview stage says which page it shows', () => {
  assert.match(html, /<div class="theme-stage" id="stage" data-stage="invoice">/);
  assert.match(html, /stage\.dataset\.stage = tab\.dataset\.view;/);
  assert.match(html, /class="status-chip" data-state="waiting"/);
});
