// Account type (CPAY design artifacts): Individual or Business / Organization.
// Chosen at sign-up, shown as plain text, and it grants nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const pub = (f) => readFileSync(`public/${f}`, 'utf8');
const migration = readFileSync('supabase/migrations/20261017010000_account_type.sql', 'utf8');

test('accountTypeText: Individual unless the row is a business; the name follows when known', () => {
  const ctx = { window: {}, document: {}, location: {} };
  vm.runInNewContext(`${pub('app.js')}\nthis.accountTypeText = accountTypeText;`, ctx);
  const t = ctx.accountTypeText;
  assert.equal(t(null), 'Individual');
  assert.equal(t({}), 'Individual');
  assert.equal(t({ account_type: 'individual', business_name: 'Ignored' }), 'Individual');
  assert.equal(t({ account_type: 'team' }), 'Individual');
  assert.equal(t({ account_type: 'business' }), 'Business / Organization');
  assert.equal(t({ account_type: 'business', business_name: 'Rina Crafts' }), 'Business / Organization: Rina Crafts');
});

test('register offers the two types, Individual first and checked, and sends the name only for a business', () => {
  const r = pub('register.html');
  const ind = r.indexOf('value="individual" checked');
  const biz = r.indexOf('value="business"');
  assert.ok(ind > 0 && biz > ind, 'Individual first and checked');
  assert.match(r, /<legend>Account type<\/legend>/);
  assert.match(r, /<div class="field" id="businessField" hidden>/);
  assert.match(r, /account_type: accountType, business_name: accountType === 'business' \? businessName : undefined \};\s*\(\{ data, error \} = await window\.supabaseClient\.auth\.signUp\(\{\s*email, password,\s*options: \{\s*data: meta,/);
  assert.match(r, /if \(accountType === 'business' && \(businessName\.length < 2 \|\| businessName\.length > 120\)\)/);
  assert.match(r, /Continue with Google opens an Individual account/);
});

test('every place that shows the type escapes it', () => {
  for (const f of ['admin-desk.js', 'admin-home-live.js', 'daily-desk.js']) {
    const s = pub(f);
    const uses = s.match(/accountTypeText\([^)]*\)/g) || [];
    assert.ok(uses.length >= 1, `${f} shows the type`);
    assert.equal((s.match(/escapeHtml\(accountTypeText\(/g) || []).length, uses.length, `${f} escapes it`);
  }
  // The desk heading is set with textContent.
  assert.match(pub('freelancer-desk.js'), /getElementById\('deskKind'\)\.textContent = /);
});

test('the migration records the type only: no grant, no permission, no change to the profile guard', () => {
  const code = migration.replace(/^\s*--.*$/gm, '');
  assert.doesNotMatch(code, /guard_profile_updates|user_editable_fields/, 'users still cannot change it');
  assert.doesNotMatch(code, /grant\s+(update|insert|select)/i, 'no new table grants');
  assert.match(code, /check \(account_type in \('individual', 'business'\)\)/);
  assert.match(code, /v_type text := case when new\.raw_user_meta_data->>'account_type' = 'business' then 'business' else 'individual' end;/);
  // Same role and approval for both types.
  assert.match(code, /\(new\.id, new\.email, v_name, 'creator', v_status,/);
  assert.match(code, /revoke all on function public\.admin_list_account_applications\(text\) from public, anon;/);
  assert.match(code, /if not is_admin\(\) then raise exception 'Not authorized'; end if;/);
});

test('no organization or team features ride along (design: only where supported)', () => {
  for (const f of ['register.html', 'dashboard.html', 'freelancer-desk.js', 'admin-desk.js']) {
    assert.doesNotMatch(pub(f), /team member|invite (a )?member|organization settings|\bmoderator\b.*role|creator role/i, f);
  }
});
