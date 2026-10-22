import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { configuredCronSecret as shared } from '../../supabase/functions/_shared/scoped-cron-secret.mjs';
import { configuredCronSecret as standalone } from '../../supabase/functions/breez-wallet/cron-secret.mjs';

for (const [label, select] of [['shared', shared], ['standalone wallet', standalone]]) {
  const get = (record) => (key) => Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
  test(label + ' uses legacy credential only before scoped cutover', () => {
    assert.equal(select(get({ CRON_SECRET: 'old' }), 'HEALTH_CRON_SECRET'), 'old');
  });
  test(label + ' rejects legacy credential when scoped is set', () => {
    const expected = select(get({ CRON_SECRET: 'old', HEALTH_CRON_SECRET: 'new' }), 'HEALTH_CRON_SECRET');
    assert.equal(expected, 'new');
    assert.notEqual(expected, 'old');
  });
  test(label + ' explicitly empty scoped secret refuses fallback', () => {
    assert.equal(select(get({ CRON_SECRET: 'old', HEALTH_CRON_SECRET: '' }), 'HEALTH_CRON_SECRET'), '');
  });
  test(label + ' absent secrets refuse all callers', () => {
    assert.equal(select(get({}), 'HEALTH_CRON_SECRET'), '');
  });
}
test('cron entry points select their own scoped credentials', () => {
  const pairs = [
    ['daily-report', 'DAILY_REPORT_CRON_SECRET'],
    ['ledger-backup', 'LEDGER_BACKUP_CRON_SECRET'],
    ['health', 'HEALTH_CRON_SECRET'],
    ['telegram-notify', 'TELEGRAM_NOTIFY_CRON_SECRET'],
    ['breez-wallet', 'BREEZ_WALLET_CRON_SECRET'],
  ];
  for (const [name, scope] of pairs) {
    const src = readFileSync(new URL('../../supabase/functions/' + name + '/index.ts', import.meta.url), 'utf8');
    assert.match(src, /configuredCronSecret\(/);
    assert.ok(src.includes('"' + scope + '"'));
  }
});
