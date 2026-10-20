import { test, expect } from '@playwright/test';
import { makeUser, makeLink, login, loginAdmin, db, ORIGIN, type User } from './helpers';

let ANON_KEY = '';
test.beforeAll(async () => { ANON_KEY = (await (await fetch(`${ORIGIN}/__e2e/anon-key`)).json()).anonKey; });

async function token(u: User) {
  const r = await fetch(`${ORIGIN}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ email: u.email, password: u.password }),
  });
  return (await r.json()).access_token as string;
}
const rest = (path: string, jwt?: string, init: RequestInit = {}) => fetch(`${ORIGIN}/rest/v1/${path}`, {
  ...init, headers: { apikey: ANON_KEY, authorization: `Bearer ${jwt ?? ANON_KEY}`, 'content-type': 'application/json', prefer: 'return=representation', ...(init.headers || {}) },
});
const rpc = (fn: string, jwt?: string, body = {}) => rest(`rpc/${fn}`, jwt, { method: 'POST', body: JSON.stringify(body) });

test('anonymous: no private table rows, no admin RPCs, no table writes', async () => {
  const victim = await makeUser({ earned: 10 });
  await makeLink(victim.id);
  for (const t of ['payments', 'withdrawals', 'profiles', 'usdt_wallets', 'audit_log']) {
    const r = await rest(`${t}?select=*&limit=5`);
    if (r.ok) expect(await r.json(), t).toEqual([]);
    else expect([401, 403]).toContain(r.status);
  }
  expect((await rpc('admin_list_creators')).ok).toBe(false);
  const w = await rest('site_domains', undefined, { method: 'POST', body: JSON.stringify({}) });
  expect([401, 403]).toContain(w.status);
});

test('a Freelancer sees only their own rows and cannot change another Freelancer\'s link', async () => {
  const a = await makeUser({ earned: 25 });
  const b = await makeUser({ earned: 30 });
  const bSlug = await makeLink(b.id);
  const ta = await token(a);
  const pays = await (await rest('payments?select=user_id', ta)).json();
  expect(pays.length).toBe(1);
  expect(pays.every((p: { user_id: string }) => p.user_id === a.id)).toBe(true);
  expect(await (await rest(`profiles?select=id&id=eq.${b.id}`, ta)).json()).toEqual([]);
  const upd = await rest(`payment_links?slug=eq.${bSlug}`, ta, { method: 'PATCH', body: JSON.stringify({ is_active: false }) });
  expect(upd.ok ? await upd.json() : []).toEqual([]);
  expect((await db.query('select is_active from payment_links where slug = $1', [bSlug])).rows[0].is_active).toBe(true);
});

test('a Freelancer cannot make themselves admin or change their own fee', async () => {
  const a = await makeUser({ fee: 3 });
  await db.query('update profiles set platform_fee_percent = 5 where id = $1', [a.id]);
  const ta = await token(a);
  await rest(`profiles?id=eq.${a.id}`, ta, { method: 'PATCH', body: JSON.stringify({ role: 'admin' }) });
  await rest(`profiles?id=eq.${a.id}`, ta, { method: 'PATCH', body: JSON.stringify({ platform_fee_percent: 0, withdrawal_fee_percent: 0, account_status: 'active' }) });
  const { rows: [p] } = await db.query('select role, platform_fee_percent::text pf, withdrawal_fee_percent::text wf from profiles where id = $1', [a.id]);
  expect(p.role).toBe('creator');
  expect(Number(p.pf)).toBe(5);
  expect(Number(p.wf)).toBe(3);
  expect((await rpc('admin_list_creators', ta)).ok).toBe(false);
  expect((await rpc('admin_set_platform_fee', ta, {})).ok).toBe(false);
});

test('a Freelancer opening admin.html gets no admin data', async ({ page }) => {
  const a = await makeUser();
  await login(page, a);
  await page.waitForURL(/dashboard\.html/);
  const adminCalls: number[] = [];
  page.on('response', (r) => { if (/rpc\/admin_/.test(r.url())) adminCalls.push(r.status()); });
  await page.goto('/admin.html');
  await page.waitForTimeout(1500);
  expect(page.url()).not.toMatch(/admin\.html$/);
  expect(adminCalls.filter((s) => s < 300)).toHaveLength(0);
});

test('an admin reaches the admin desk and admin RPCs', async ({ page }) => {
  const admin = await makeUser({ role: 'admin', name: 'Op' });
  expect((await rpc('admin_list_creators', await token(admin))).ok).toBe(true);
  await loginAdmin(page, admin);
});

test('retired and removed roles cannot be assigned', async () => {
  const a = await makeUser();
  for (const role of ['moderator', 'reseller']) {
    await expect(db.query('update profiles set role = $2 where id = $1', [a.id, role])).rejects.toThrow(/check constraint/);
  }
});

test('a suspended Freelancer is signed out at login and cannot create links', async ({ page }) => {
  const s = await makeUser();
  const ts = await token(s);
  await db.query(`update profiles set account_status = 'suspended' where id = $1`, [s.id]);
  await login(page, s);
  await expect(page.locator('#errorMsg')).toHaveText(/suspended/i);
  expect((await rpc('create_link_variants', ts, { p_display_name: 'Nope', p_styles: ['kebab'] })).ok).toBe(false);
});
