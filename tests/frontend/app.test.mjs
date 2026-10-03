import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const context = vm.createContext({ window: {} });
vm.runInContext(readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8'), context);
const escapeHtml = context.window.CPAY_APP.escapeHtml;

test('escapeHtml encodes HTML-significant characters', () => {
  assert.equal(escapeHtml('& < > " \''), '&amp; &lt; &gt; &quot; &#39;');
});

test('escapeHtml neutralizes markup in user-controlled text', () => {
  assert.equal(
    escapeHtml('<img src=x onerror="alert(1)">'),
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;',
  );
});

test('escapeHtml handles nullish and non-string values', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml(false), 'false');
});
