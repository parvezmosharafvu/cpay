import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const register = readFileSync(new URL('../../public/register.html', import.meta.url), 'utf8');
const admin = readFileSync(new URL('../../public/admin-desk.js', import.meta.url), 'utf8');

test('new registration collects name, international phone, Telegram and matching password', () => {
  for (const id of ['displayName', 'phone', 'telegramUsername', 'passwordConfirm']) {
    assert.match(register, new RegExp('id="' + id + '"'));
  }
  assert.match(register, /password !== passwordConfirm/);
  assert.match(register, /telegram_username: telegramUsername/);
  assert.match(register, /phone, telegram_username:/);
  assert.match(register, /data: meta/);
  assert.match(register, /Enter a phone number with country code/);
});

test('admin review exposes contact fields only in protected application listing', () => {
  assert.match(admin, /admin_list_account_applications/);
  assert.match(admin, /escapeHtml\(a\.phone \|\|/);
  assert.match(admin, /escapeHtml\(a\.telegram_username \|\|/);
  assert.doesNotMatch(admin, /autoApprovalCard\(/);
  assert.doesNotMatch(admin, /setAutoApproval\(/);
});
