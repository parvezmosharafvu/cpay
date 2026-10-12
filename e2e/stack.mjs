#!/usr/bin/env node
// Disposable local CPAY stack for Playwright E2E (audit P2). Never touches
// production: everything runs on localhost against a throwaway database.
//
//   Postgres  : fresh database $E2E_DB (bootstrap + every migration + e2e/shim.sql)
//   PostgREST : real RLS, JWTs signed with a local test secret
//   Auth      : a small GoTrue stand-in (password sign-up/in, refresh, user, recover)
//   Functions : the real create-invoice and user-withdraw Edge Functions under Deno
//   Payments  : the real payment-service with a fake wallet SDK; no network, no money
//   Gateway   : one origin serving dist/ (with a local config.js), /rest, /auth,
//               /functions, and /__e2e test hooks (mailbox, simulated payment)
//
// Usage: node e2e/stack.mjs   (then http://127.0.0.1:$E2E_PORT)
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createHmac, randomUUID, randomBytes } from 'node:crypto';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'payment-service', 'package.json'));
const pg = require('pg');

const PORT = Number(process.env.E2E_PORT || 54321);
const PGHOST = process.env.PGHOST || 'localhost';
const PGUSER = process.env.PGUSER || 'postgres';
const PGPASSWORD = process.env.PGPASSWORD || 'postgres';
const DB = process.env.E2E_DB || 'cpay_e2e';
const POSTGREST = process.env.POSTGREST_BIN || 'postgrest';
const DENO = process.env.DENO_BIN || 'deno';
const REST_PORT = PORT + 1, INVOICE_FN_PORT = PORT + 2, WITHDRAW_FN_PORT = PORT + 3;
const JWT_SECRET = 'e2e-only-jwt-secret-'.padEnd(48, 'x');
const SERVICE_SECRET = 'e2e-only-service-secret-'.padEnd(48, 'y');
const ORIGIN = `http://127.0.0.1:${PORT}`;
const children = [];

const b64u = (b) => Buffer.from(b).toString('base64url');
export function signJwt(claims) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify(claims));
  return `${h}.${p}.${createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url')}`;
}
function verifyJwt(t) {
  const [h, p, s] = String(t || '').split('.');
  if (!s || createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url') !== s) return null;
  const c = JSON.parse(Buffer.from(p, 'base64url').toString());
  return c.exp && c.exp < Date.now() / 1000 ? null : c;
}
const ANON_KEY = signJwt({ role: 'anon', iss: 'e2e', iat: 1700000000, exp: 4102444800 });
const SERVICE_KEY = signJwt({ role: 'service_role', iss: 'e2e', iat: 1700000000, exp: 4102444800 });

const psql = (args, db = DB) => execFileSync('psql', ['-h', PGHOST, '-U', PGUSER, '-d', db, '-v', 'ON_ERROR_STOP=1', '-q', ...args],
  { env: { ...process.env, PGPASSWORD }, stdio: ['ignore', 'ignore', 'inherit'] });

function buildDatabase() {
  psql(['-c', `drop database if exists ${DB} with (force)`, '-c', `create database ${DB}`], 'postgres');
  psql(['-f', 'ci/bootstrap.sql', '-f', 'ci/supabase_default_privileges.sql']);
  for (const f of readdirSync(path.join(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort()) {
    psql(['-f', `supabase/migrations/${f}`]);
  }
  psql(['-f', 'e2e/shim.sql']);
}

function run(cmd, args, env, name) {
  const c = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = (d) => process.env.E2E_VERBOSE && process.stderr.write(`[${name}] ${d}`);
  c.stdout.on('data', tag); c.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  children.push(c);
  return c;
}

async function waitFor(url, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url, { method: 'OPTIONS' }); if (r.status < 500) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout waiting for ${url}`);
}

// ── payment service with a fake wallet SDK ─────────────────────────────
async function startPaymentService() {
  const { fakeBreez } = await import(path.join(root, 'payment-service/fake-breez.mjs'));
  const { createService } = await import(path.join(root, 'payment-service/service.mjs'));
  const fake = fakeBreez();
  const invoices = new Map();
  fake.receivePayment = async ({ paymentMethod }) => {
    const hash = randomBytes(32).toString('hex');
    const bolt11 = `lnbcrt${paymentMethod.amountSats}n1e2e${hash.slice(0, 40)}`;
    invoices.set(bolt11, hash);
    return { paymentRequest: bolt11 };
  };
  const parse = fake.parse;
  fake.parse = async (input) => (invoices.has(input) ? { type: 'bolt11Invoice', paymentHash: invoices.get(input) } : parse(input));
  const service = createService({
    config: {
      network: 'regtest', apiKey: '', mnemonic: Array(12).fill('abandon').join(' '), dataDir: '/nonexistent',
      databaseUrl: `postgres://${PGUSER}:${PGPASSWORD}@${PGHOST}:5432/${DB}`, secret: SERVICE_SECRET, port: 0,
      catchUpMs: 3_600_000, shutdownTimeoutMs: 2_000, requestAuthMode: 'any', adminJwtMode: 'optional',
    },
    breez: { defaultConfig: (network) => ({ network }), connect: async () => fake },
    log: () => {},
  });
  const port = await service.started;
  return { fake, service, url: `http://127.0.0.1:${port}` };
}

// ── auth stand-in ──────────────────────────────────────────────────────
const mailbox = [];
let pool;
const refreshTokens = new Map();
async function session(userRow, method = 'password') {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    sub: userRow.id, role: 'authenticated', aud: 'authenticated', email: userRow.email, iat: now, exp: now + 3600,
    aal: 'aal1', amr: [{ method, timestamp: now }], session_id: randomUUID(),
  };
  const refresh = randomBytes(16).toString('hex');
  refreshTokens.set(refresh, userRow.id);
  return { access_token: signJwt(claims), token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: refresh, user: userJson(userRow) };
}
const userJson = (u) => ({
  id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: u.email_confirmed_at,
  user_metadata: u.raw_user_meta_data || {}, app_metadata: { provider: 'email' }, factors: [], created_at: u.created_at,
});
const userById = async (id) => (await pool.query('select * from auth.users where id = $1', [id])).rows[0];
const authError = (res, status, msg, code) => send(res, status, { error: code || 'invalid_grant', error_description: msg, msg, code: status, error_code: code });

async function handleAuth(req, res, url, body) {
  const p = url.pathname.replace(/^\/auth\/v1/, '');
  if (p === '/signup' && req.method === 'POST') {
    const email = String(body.email || '').toLowerCase();
    if (!email || String(body.password || '').length < 8) return authError(res, 422, 'Password should be at least 8 characters.', 'weak_password');
    if ((await pool.query('select 1 from auth.users where email = $1', [email])).rowCount) return authError(res, 422, 'User already registered', 'user_already_exists');
    const { rows: [u] } = await pool.query(
      `insert into auth.users(email, encrypted_password, raw_user_meta_data, email_confirmed_at) values ($1, crypt($2, gen_salt('bf', 4)), $3, now()) returning *`,
      [email, body.password, body.data || {}]);
    return send(res, 200, await session(u, 'email/signup'));
  }
  if (p === '/token') {
    const grant = url.searchParams.get('grant_type');
    if (grant === 'password') {
      const { rows: [u] } = await pool.query(
        `select * from auth.users where email = lower($1) and encrypted_password = crypt($2, encrypted_password)`, [body.email, body.password]);
      if (!u) return authError(res, 400, 'Invalid login credentials', 'invalid_credentials');
      await pool.query('update auth.users set last_sign_in_at = now() where id = $1', [u.id]);
      return send(res, 200, await session(u));
    }
    if (grant === 'refresh_token') {
      const id = refreshTokens.get(body.refresh_token);
      if (!id) return authError(res, 400, 'Invalid Refresh Token', 'refresh_token_not_found');
      return send(res, 200, await session(await userById(id)));
    }
  }
  const claims = verifyJwt((req.headers.authorization || '').replace(/^Bearer /i, ''));
  if (p === '/user' && req.method === 'GET') {
    if (!claims?.sub) return authError(res, 401, 'invalid JWT', 'bad_jwt');
    const u = await userById(claims.sub);
    return u ? send(res, 200, userJson(u)) : authError(res, 404, 'User not found', 'user_not_found');
  }
  if (p === '/user' && req.method === 'PUT') {
    if (!claims?.sub) return authError(res, 401, 'invalid JWT', 'bad_jwt');
    if (body.password) await pool.query(`update auth.users set encrypted_password = crypt($2, gen_salt('bf', 4)) where id = $1`, [claims.sub, body.password]);
    return send(res, 200, userJson(await userById(claims.sub)));
  }
  if (p === '/logout') return send(res, 204, null);
  if (p === '/recover') {
    const { rows: [u] } = await pool.query('select * from auth.users where email = lower($1)', [body.email]);
    if (u) {
      const s = await session(u, 'recovery');
      const redirect = url.searchParams.get('redirect_to') || body.redirect_to || `${ORIGIN}/reset.html`;
      mailbox.push({ to: u.email, kind: 'recovery', link: `${redirect}#access_token=${s.access_token}&refresh_token=${s.refresh_token}&expires_in=3600&expires_at=${s.expires_at}&token_type=bearer&type=recovery` });
    }
    return send(res, 200, {});
  }
  if (p === '/settings') return send(res, 200, { external: { email: true }, disable_signup: false, mailer_autoconfirm: true });
  return send(res, 404, { msg: `e2e auth: ${req.method} ${p} not implemented` });
}

// ── gateway ────────────────────────────────────────────────────────────
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info, prefer, range, accept-profile, content-profile, x-supabase-api-version',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-expose-headers': 'content-range',
};
function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...CORS, ...(body === null ? {} : { 'content-type': 'application/json' }), ...headers });
  res.end(body === null ? undefined : JSON.stringify(body));
}
async function proxy(req, res, target, raw) {
  const headers = { ...req.headers };
  delete headers.host; delete headers['content-length'];
  const r = await fetch(target, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw, redirect: 'manual' });
  const out = { ...CORS };
  r.headers.forEach((v, k) => { if (!['content-encoding', 'transfer-encoding', 'content-length', 'connection'].includes(k) && !k.startsWith('access-control-')) out[k] = v; });
  res.writeHead(r.status, out);
  res.end(Buffer.from(await r.arrayBuffer()));
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };
const configJs = `window.SUPABASE_URL = '${ORIGIN}';\nconst SUPABASE_ANON_KEY = '${ANON_KEY}';\nwindow.supabaseClient = window.supabase.createClient(window.SUPABASE_URL, SUPABASE_ANON_KEY);\n`;
function serveStatic(req, res, url) {
  const dist = path.join(root, 'dist');
  if (url.pathname === '/config.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(configJs); }
  const rel = decodeURIComponent(url.pathname);
  for (const cand of [rel, `${rel}.html`, path.join(rel, 'index.html')]) {
    const f = path.join(dist, cand);
    if (f.startsWith(dist) && existsSync(f) && statSync(f).isFile()) {
      res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
      return res.end(readFileSync(f));
    }
  }
  // Cloudflare "404-page" handling: unknown paths (payment-link slugs) get 404.html.
  res.writeHead(404, { 'content-type': TYPES['.html'] });
  res.end(readFileSync(path.join(dist, '404.html')));
}

async function main() {
  buildDatabase();
  pool = new pg.Pool({ connectionString: `postgres://${PGUSER}:${PGPASSWORD}@${PGHOST}:5432/${DB}`, max: 5 });
  run(POSTGREST, [], {
    PGRST_DB_URI: `postgres://authenticator:postgres@${PGHOST}:5432/${DB}`, PGRST_DB_SCHEMAS: 'public', PGRST_DB_ANON_ROLE: 'anon',
    PGRST_JWT_SECRET: JWT_SECRET, PGRST_SERVER_PORT: String(REST_PORT), PGRST_SERVER_HOST: '127.0.0.1', PGRST_DB_POOL: '10',
  }, 'postgrest');
  const pay = await startPaymentService();
  const fnEnv = {
    SUPABASE_URL: ORIGIN, SUPABASE_ANON_KEY: ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    PAYMENT_SERVICE_URL: pay.url, PAYMENT_SERVICE_SECRET: SERVICE_SECRET, PAYMENT_SERVICE_AUTH_MODE: 'bearer',
    PUBLIC_SITE_URL: ORIGIN, SITE_URL: ORIGIN,
  };
  const fn = (name, port) => run(DENO, ['run', '--quiet', '--no-lock', '--allow-net', '--allow-env', '--allow-read', 'e2e/fn-wrapper.ts'],
    { ...fnEnv, FN_PORT: String(port), FN_ENTRY: `../supabase/functions/${name}/index.ts` }, name);
  fn('create-invoice', INVOICE_FN_PORT);
  fn('user-withdraw', WITHDRAW_FN_PORT);

  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    let body = {}; try { body = raw.length ? JSON.parse(raw) : {}; } catch { /* form or empty */ }
    const url = new URL(req.url, ORIGIN);
    try {
      if (req.method === 'OPTIONS') return send(res, 204, null);
      if (url.pathname.startsWith('/rest/v1/')) return await proxy(req, res, `http://127.0.0.1:${REST_PORT}${url.pathname.slice(8)}${url.search}`, raw);
      if (url.pathname.startsWith('/auth/v1/')) return await handleAuth(req, res, url, body);
      if (url.pathname.startsWith('/realtime/')) return send(res, 404, { msg: 'realtime is not part of the e2e stack; pages poll' });
      if (url.pathname === '/functions/v1/create-invoice') return await proxy(req, res, `http://127.0.0.1:${INVOICE_FN_PORT}/`, raw);
      if (url.pathname.startsWith('/functions/v1/user-withdraw')) return await proxy(req, res, `http://127.0.0.1:${WITHDRAW_FN_PORT}${url.pathname.slice('/functions/v1/user-withdraw'.length) || '/'}${url.search}`, raw);
      if (url.pathname.startsWith('/functions/v1/')) return send(res, 503, { error: 'not available in e2e' });
      if (url.pathname === '/__e2e/health') return send(res, 200, { ok: true });
      if (url.pathname === '/__e2e/anon-key') return send(res, 200, { anonKey: ANON_KEY });
      if (url.pathname === '/__e2e/mailbox') return send(res, 200, mailbox.filter((m) => !url.searchParams.get('to') || m.to === url.searchParams.get('to')));
      if (url.pathname === '/__e2e/pay' && req.method === 'POST') {
        // A simulated incoming Lightning payment, delivered to the real
        // payment service through the fake SDK's event stream.
        const { rows: [p] } = await pool.query('select invoice_ref, amount_sat from payments where id = $1', [body.paymentId]);
        if (!p?.invoice_ref) return send(res, 404, { error: 'no invoice' });
        const payment = { id: `e2e-${randomUUID()}`, paymentType: 'receive', status: 'completed', amount: BigInt(body.amountSat ?? p.amount_sat), fees: 0n,
          timestamp: Math.floor(Date.now() / 1000), method: 'lightning', details: { type: 'lightning', htlcDetails: { paymentHash: p.invoice_ref } } };
        pay.fake.received.push(payment);
        pay.fake.onEvent?.({ type: 'paymentSucceeded', payment });
        for (let i = 0; i < 40; i++) {
          const { rows: [s] } = await pool.query('select status from payments where id = $1', [body.paymentId]);
          if (s.status === 'settled') return send(res, 200, { status: 'settled' });
          await new Promise((r) => setTimeout(r, 100));
        }
        return send(res, 200, { status: 'pending' });
      }
      if (url.pathname.startsWith('/__e2e/')) return send(res, 404, {});
      if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'no proxy' }); // as in production assets-only routing
      return serveStatic(req, res, url);
    } catch (e) {
      process.stderr.write(`[gateway] ${e.stack}\n`);
      if (!res.headersSent) send(res, 502, { error: 'gateway error' });
    }
  });
  await waitFor(`http://127.0.0.1:${REST_PORT}/`);
  await waitFor(`http://127.0.0.1:${INVOICE_FN_PORT}/`, 120_000);
  await waitFor(`http://127.0.0.1:${WITHDRAW_FN_PORT}/`, 120_000);
  server.listen(PORT, '127.0.0.1', () => console.log(`e2e stack ready on ${ORIGIN}`));
  const stop = async () => { for (const c of children) c.kill('SIGTERM'); await pay.service.stop('e2e-end').catch(() => {}); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e); for (const c of children) c.kill(); process.exit(1); });
export { ANON_KEY, SERVICE_KEY, JWT_SECRET };
