import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../../ci/solvency_readonly_snapshot.sql', import.meta.url), 'utf8');

test('solvency report cannot certify assets or convert USD to sats', () => {
  assert.match(sql, /'verdict',\s*'UNVERIFIED'/);
  assert.match(sql, /'liabilities_usd'/);
  assert.match(sql, /'wallet_evidence_sat'/);
});

test('settled forwards are excluded by an actual SQL WHERE clause', () => {
  // A literal backslash-n after an SQL comment once disabled this filter.
  assert.match(sql, /^\s+WHERE status IS NULL OR status NOT IN \('forwarded', 'released'\)/m);
  assert.equal(sql.includes('\\n    WHERE status IS NULL'), false);
});

test('paid or rejected withdrawals are not counted as pending', () => {
  assert.match(sql, /^\s+WHERE status IS NULL OR status NOT IN \('paid', 'rejected', 'failed'\)/m);
});

test('wallet reserve figures exclude non-mainnet and stale sync reports', () => {
  assert.match(sql, /w\.network = 'mainnet'/);
  assert.match(sql, /w\.status = 'active'/);
  assert.match(sql, /interval '15 minutes'/);
  assert.match(sql, /s\.balance_sat IS NULL OR s\.balance_sat < 0/);
});
