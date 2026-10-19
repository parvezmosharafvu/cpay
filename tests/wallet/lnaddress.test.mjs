// node --test tests/wallet/lnaddress.test.mjs
// Lightning address names the wallet offers (wallet/src/lnaddress.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIGHTNING_NAME_MAX, lightningName } from '../../wallet/src/lnaddress.js';

test('plain names pass, lowercased and trimmed', () => {
  for (const [raw, value] of [['alice', 'alice'], [' Alice.Shop ', 'alice.shop'], ['a1-b_c', 'a1-b_c'], ['7', '7'], ['x'.repeat(LIGHTNING_NAME_MAX), 'x'.repeat(LIGHTNING_NAME_MAX)]]) {
    assert.deepEqual(lightningName(raw), { ok: true, value }, raw);
  }
});

test('anything that could read as another address, a path or a lookalike is refused', () => {
  for (const raw of ['', '   ', 'a..b', 'a.-b', '.a', 'a.', '-a', 'a_', 'a b', 'a/b', 'a@b', 'a+b', 'a%2fb', 'é', 'аlice' /* Cyrillic а */, 'x'.repeat(LIGHTNING_NAME_MAX + 1), null, undefined]) {
    assert.equal(lightningName(raw).ok, false, String(raw));
  }
});
