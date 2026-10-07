import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../../public/', import.meta.url);
const read = (name) => readFileSync(new URL(name, root), 'utf8');

function loadApp() {
  const context = vm.createContext({ window: {} });
  vm.runInContext(readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8'), context);
  return context.window.CPAY_APP;
}

test('desk helpers render escaped empty/error and skeleton markup', () => {
  const { deskSkeleton, deskError, deskEmpty, deskFilterBar, escapeHtml } = loadApp();
  assert.match(deskSkeleton(2), /desk-skel/);
  assert.match(deskSkeleton(2), /aria-busy="true"/);
  assert.match(deskError('<img src=x>'), /&lt;img src=x&gt;/);
  assert.match(deskError('x'), /role="alert"/);
  assert.match(deskEmpty('None', 'Try later'), /None/);
  assert.match(deskEmpty('<b>', 'y'), /&lt;b&gt;/);
  assert.match(deskFilterBar('<div class="field"></div>'), /desk-toolbar/);
  assert.equal(escapeHtml('<'), '&lt;');
});

test('roleHome routes only admin to admin desk', () => {
  const { roleHome } = loadApp();
  assert.equal(roleHome('admin'), 'admin.html');
  assert.equal(roleHome('creator'), 'dashboard.html');
  assert.equal(roleHome('moderator'), 'dashboard.html');
  assert.equal(roleHome('reseller'), 'dashboard.html');
  assert.equal(roleHome(undefined), 'dashboard.html');
});

test('desk pages link design system, a11y, and skip links', () => {
  for (const page of ['dashboard.html', 'admin.html']) {
    const html = read(page);
    assert.match(html, /cpay\.css/, `${page} missing cpay.css`);
    assert.match(html, /a11y\.css/, `${page} missing a11y.css`);
    assert.match(html, /color-scheme/, `${page} missing color-scheme`);
    assert.match(html, /skip-link/, `${page} missing skip link`);
  }
  const dash = read('dashboard.html');
  assert.match(dash, /Freelancer/);
  assert.doesNotMatch(dash, />\s*Creator\s*</);
  assert.match(dash, /moderator','reseller/);
});

test('freelancer desk uses payment filters and USDT-only withdraw history', () => {
  const src = read('freelancer-desk.js');
  assert.match(src, /get_my_payments/);
  assert.match(src, /p_status/);
  assert.match(src, /p_search/);
  assert.match(src, /deskSkeleton|deskError|deskEmpty/);
  assert.match(src, /Withdrawal history/);
  assert.match(src, /data-toggle-link/);
  assert.doesNotMatch(src, /request_withdrawal/);
  assert.doesNotMatch(src, /submitManual/);
  assert.doesNotMatch(src, /reseller\.html|moderator\.html/);
});

test('admin desks expose status control and payment/payout filters without reseller UI', () => {
  const desk = read('admin-desk.js');
  const unify = read('admin-unify.js');
  const ops = read('admin-ops-rest.js');
  assert.match(desk, /data-status/);
  assert.match(desk, /admin_update_account_control/);
  assert.match(desk, /peopleStatus|peopleSearch/);
  assert.match(unify, /admin_list_payments/);
  assert.match(unify, /payoutStatus|adminPayStatus|paymentFilter|payoutFilter/);
  assert.match(ops, /audit_log/);
  assert.match(ops, /auditSearch/);
  for (const src of [desk, unify, ops]) {
    assert.doesNotMatch(src, /reseller\.html|moderator\.html|commission_percent|team_messages/);
  }
});

test('cpay.css includes Chat 3 desk toolbar and state panels', () => {
  const css = read('cpay.css');
  assert.match(css, /\.desk-toolbar/);
  assert.match(css, /\.state-panel/);
  assert.match(css, /\.desk-skel/);
});

test('admin people filter keeps state outside the re-rendered section', () => {
  const src = read('admin-desk.js');
  // The skeleton wipes #people before the RPCs return, so filters must not be
  // read back from the (already replaced) inputs inside renderPeople().
  assert.match(src, /let peopleFilter = \{ status: '', search: '' \}/);
  assert.match(src, /const statusFilter = peopleFilter\.status/);
  assert.doesNotMatch(src, /const statusFilter = \(document\.getElementById\('peopleStatus'\)/);
});

test('admin payments filter labels are tied to their controls', () => {
  const src = read('admin-unify.js');
  assert.match(src, /statusLabel\.htmlFor = 'adminPayStatus'/);
  assert.match(src, /searchLabel\.htmlFor = 'adminPaySearch'/);
});
