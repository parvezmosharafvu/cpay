import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const file=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');
test('payment parity navigation and scripts are installed in the admin desk',()=>{
 const h=file('public/admin.html');
 for(const id of ['statements','methods']) {
   assert.match(h,new RegExp('data-tab="'+id+'"'));
   assert.match(h,new RegExp('<section id="'+id+'"'));
 }
 assert.match(h,/admin-parity\.js/);
 const p=file('public/admin-parity.js');
 assert.match(p,/admin_statement_list/);
 assert.match(p,/admin_statement_write/);
 assert.match(p,/admin-user-invite/);
 assert.match(p,/admin_set_platform_setting/);
 assert.match(p,/paid status requires|Paid status requires|Paid status requires/i);
 assert.match(p,/window\.confirm/);
});
test('monthly member report is a separately mounted, scoped RPC',()=>{
 const h=file('public/dashboard.html'),j=file('public/monthly-reports.js');
 assert.match(h,/data-tab="reports"/);
 assert.match(h,/<section id="reports"/);
 assert.match(h,/monthly-reports\.js/);
 assert.match(j,/my_monthly_report/);
 assert.match(j,/paid \+ expired \+ failed/);
});
test('password visibility toggles are accessible controls, not credential storage',()=>{
 const s=file('public/password-visibility.js');
 const l=file('public/login.html'),r=file('public/register.html');
 assert.match(l,/password-visibility\.js/);
 assert.match(r,/password-visibility\.js/);
 assert.match(s,/aria-pressed/);
 assert.match(s,/aria-controls/);
 assert.match(s,/input\.type=visible\?'text':'password'/);
 assert.doesNotMatch(s,/localStorage|sessionStorage|clipboard|console\.log/);
});
test('admin second step stays passkey based and has setup/backup readiness',()=>{
 const s=file('public/admin-security.js');
 assert.match(s,/admin-mfa-readiness/);
 assert.match(s,/Verify my passkey/);
 assert.match(s,/keys\.length >= 2/);
 assert.match(s,/cpayMfa\.promptPasskey/);
 assert.doesNotMatch(s,/mfa\.enroll\(\{[^}]*totp/);
});
