import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import pg from 'pg';

// Audit P4: financial invariants proven at the transaction level against a
// fully migrated database, with separate sessions racing for real. Each test
// uses fresh users. Invariants covered elsewhere are listed in
// docs/FINANCIAL-INVARIANTS.md.
const url = process.env.DATABASE_URL;
const db = new pg.Pool({ connectionString: url, max: 10 });
const users = [];
const TRON = 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL';

after(async () => {
  if (users.length) {
    await db.query("delete from webhook_events where delivery_id like 'breez:inv-%'");
    await db.query('delete from auth.users where id = any($1::uuid[])', [users]);
  }
  await db.end();
});

async function makeUser({ earned = 0, platformFee = 0 } = {}) {
  const id = randomUUID();
  users.push(id);
  await db.query('insert into auth.users(id, email) values ($1, $2)', [id, `inv-${id}@test.invalid`]);
  await db.query(`update profiles set role = 'creator', account_status = 'active', withdrawal_fee_percent = 0,
                  platform_fee_percent = $2 where id = $1`, [id, platformFee]);
  if (earned) {
    await db.query(`insert into payments(user_id, amount_requested, amount_settled, status, settled_at, expires_at)
                    values ($1, $2, $2, 'settled', now(), now() + interval '1 hour')`, [id, earned]);
  }
  return id;
}

async function openInvoice(user, usd, sats) {
  const hash = randomBytes(32).toString('hex');
  const { rows } = await db.query(
    `insert into payments(user_id, invoice_ref, lightning_invoice, amount_requested, amount_sat, btc_usd_rate, status, expires_at)
     values ($1, $2, 'lnbcrt1inv', $3, $4, 100000, 'new', now() + interval '1 hour') returning id`, [user, hash, usd, sats]);
  return { id: rows[0].id, hash };
}

const balance = async (id) => (await db.query('select earned::text, available::text from get_balance_for($1)', [id])).rows[0];

test('duplicate settlement: eight sessions settling the same payment at once credit it once', async () => {
  const user = await makeUser();
  const inv = await openInvoice(user, '12.34', 12340);
  const bid = `inv-${randomUUID()}`;
  const clients = await Promise.all(Array.from({ length: 8 }, async () => {
    const c = new pg.Client({ connectionString: url }); await c.connect(); return c;
  }));
  try {
    const outcomes = await Promise.all(clients.map((c, i) =>
      // half reuse the same Breez id (webhook replay), half a new id for the same hash
      c.query('select settle_breez_payment($1, $2, $3) as o', [i % 2 ? bid : `${bid}-${i}`, inv.hash, 12340]).then((r) => r.rows[0].o)));
    assert.equal(outcomes.filter((o) => o === 'settled').length, 1, outcomes.join(','));
    for (const o of outcomes.filter((x) => x !== 'settled')) assert.ok(['duplicate', 'already_settled'].includes(o), o);
  } finally {
    await Promise.all(clients.map((c) => c.end()));
  }
  assert.equal((await balance(user)).earned, '12.34000000');
});

test('creator credit plus platform fee equals the settled amount, in exact cents, at several fee rates', async () => {
  for (const [pct, usd] of [['0', '10.00'], ['2.5', '19.99'], ['7', '0.01'], ['10', '33.33'], ['12.345', '1234.57']]) {
    const user = await makeUser({ platformFee: pct });
    const inv = await openInvoice(user, usd, 1000);
    assert.equal((await db.query('select settle_breez_payment($1,$2,1000) as o', [`inv-${randomUUID()}`, inv.hash])).rows[0].o, 'settled');
    const { rows: [p] } = await db.query(
      'select amount_settled::text s, platform_fee_amount::text f, (amount_settled - platform_fee_amount)::text net, platform_fee_amount = round(platform_fee_amount, 2) as cents from payments where id = $1', [inv.id]);
    const b = await balance(user);
    assert.ok(p.cents, `fee ${p.f} is not whole cents`);
    if (pct === '10') assert.equal(p.f, '3.33');
    assert.equal(Number(b.earned).toFixed(8), Number(p.net).toFixed(8), `pct ${pct}: earned ${b.earned} != settled ${p.s} - fee ${p.f}`);
    assert.equal(Math.round(Number(b.earned) * 100) + Math.round(Number(p.f) * 100), Math.round(Number(p.s) * 100));
  }
});

test('an expired quote cannot reserve funds', async () => {
  const user = await makeUser({ earned: 100 });
  const before = await balance(user);
  const past = new Date(Date.now() - 1000).toISOString();
  await assert.rejects(db.query('select id from reserve_stablecoin_withdrawal($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [user, randomUUID(), '10.00', '0.00', '10.00', 'USDT', 'tron', TRON, '0.5', '9.5', 10_000, past]), /expire/i);
  assert.deepEqual(await balance(user), before);
  assert.equal((await db.query('select count(*)::int n from withdrawals where user_id = $1', [user])).rows[0].n, 0);
});

test('concurrent confirm of one quote from five sessions reserves once; available never negative', async () => {
  const user = await makeUser({ earned: 50 });
  const quote = randomUUID();
  const expires = new Date(Date.now() + 60_000).toISOString();
  const res = await Promise.all(Array.from({ length: 5 }, () => db.query(
    'select id from reserve_stablecoin_withdrawal($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [user, quote, '40.00', '0.00', '40.00', 'USDT', 'tron', TRON, '0.5', '39.5', 40_000, expires]).then((r) => r.rows[0].id, (e) => `ERR ${e.message}`)));
  const ids = new Set(res.filter((r) => !String(r).startsWith('ERR')));
  assert.equal(ids.size, 1, res.join(' | '));
  assert.equal((await db.query('select count(*)::int n from withdrawals where user_id = $1', [user])).rows[0].n, 1);
  const b = await balance(user);
  assert.equal(b.available, '10.00000000');
  assert.ok(Number(b.available) >= 0);
});

test('cross-creator isolation: another creator reads none of my payments, withdrawals or links and cannot change them', async () => {
  const a = await makeUser({ earned: 20 });
  const b = await makeUser();
  await db.query(`insert into payment_links(user_id, slug, title) values ($1, $2, 'mine')`, [a, `iso-${a.slice(0, 8)}`]).catch(async () => {
    await db.query(`insert into payment_links(user_id, slug) values ($1, $2)`, [a, `iso-${a.slice(0, 8)}`]);
  });
  const c = await db.connect();
  try {
    await c.query('begin');
    // Supabase's auth.uid(), as production defines it; the CI bootstrap stub
    // returns null. Inside this transaction only.
    await c.query(`create or replace function auth.uid() returns uuid language sql stable as
      $f$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$`);
    // Production's table grants for authenticated (RLS is the gate); the CI
    // database without Supabase default privileges has none. Rolled back.
    await c.query(`grant usage on schema auth to authenticated;
      grant execute on function auth.uid() to authenticated;
      grant select on payments, withdrawals, payment_links to authenticated;
      grant update on payment_links to authenticated`);
    await c.query('set local role authenticated');
    await c.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)",
      [b, JSON.stringify({ sub: b, role: 'authenticated' })]);
    for (const t of ['payments', 'withdrawals', 'payment_links']) {
      const { rows } = await c.query(`select count(*)::int n from ${t} where user_id = $1`, [a]);
      assert.equal(rows[0].n, 0, `${t} leaked to another creator`);
    }
    const upd = await c.query(`update payment_links set slug = 'stolen-' || left(id::text, 8) where user_id = $1`, [a]);
    assert.equal(upd.rowCount, 0);
    // Positive control: the owner does see their own rows, so zero above is RLS, not an empty table.
    await c.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)",
      [a, JSON.stringify({ sub: a, role: 'authenticated' })]);
    assert.equal((await c.query('select count(*)::int n from payments where user_id = $1', [a])).rows[0].n, 1);
    assert.equal((await c.query('select count(*)::int n from payment_links where user_id = $1', [a])).rows[0].n, 1);
    await c.query('rollback');
  } finally { await c.query('rollback').catch(() => {}); c.release(); }
  assert.equal((await db.query(`select count(*)::int n from payment_links where user_id = $1 and slug like 'stolen-%'`, [a])).rows[0].n, 0);
});

test('public invoice lookup returns only the allowlisted fields', async () => {
  const user = await makeUser();
  const inv = await openInvoice(user, '5.00', 5000);
  const c = await db.connect();
  try {
    await c.query('begin');
    await c.query('set local role anon');
    const r = await c.query('select * from get_invoice_public($1)', [inv.id]);
    assert.deepEqual(r.fields.map((f) => f.name).sort(),
      ['amount_requested', 'amount_settled', 'expires_at', 'id', 'lightning_invoice', 'link_slug', 'merchant_name', 'method', 'status']);
    assert.equal(r.rows.length, 1);
    const s = await c.query('select * from lookup_payment_status($1)', [inv.hash]);
    assert.deepEqual(s.fields.map((f) => f.name).sort(), ['amount', 'created_at', 'settled_at', 'status']);
    await c.query('rollback');
  } finally { await c.query('rollback').catch(() => {}); c.release(); }
});
