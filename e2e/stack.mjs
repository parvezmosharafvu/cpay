#!/usr/bin/env node
// Disposable local CPAY stack for Playwright E2E (audit P2). Never touches
// production: everything runs on localhost against a throwaway database.
//
//   Postgres  : fresh database $E2E_DB (bootstrap + every migration + e2e/shim.sql)
//   PostgREST : real RLS, JWTs signed with a local test secret
//   Auth      : a small GoTrue stand-in (password sign-up/in, refresh, user, recover, verify)
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
import { stackPorts, assertPortsFree, waitReady } from './ports.mjs';
import { totp, b32encode } from './totp.mjs';

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
// Like production, the website and the API live on different origins
// (pay-cashapp.buzz and *.supabase.co): pages load from SITE and call ORIGIN,
// so the browser enforces CORS, including the Edge Functions' own headers.
// localhost also lets WebAuthn (passkeys) run; it refuses IP addresses.
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SITE = `http://localhost:${PORT}`;
// Tagged on every Edge Function response (e2e/fn-wrapper.ts), so readiness
// can tell this run's functions from a stale process holding the port.
const RUN_ID = randomUUID();
const children = [];
// Only ever stop what this run started, on any exit path.
process.on('exit', () => { for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL'); });

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
const recoveryHashes = new Map(); // token hash -> user id, single use
let pool;
const refreshTokens = new Map();
// Like Supabase Auth: a sign-in is aal1 with its method in amr; a verified
// TOTP challenge upgrades to aal2 and adds {method:'totp'}; a refresh keeps
// the aal and amr it was issued with (it is not a new sign-in).
async function session(userRow, method = 'password', { aal = 'aal1', amr } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const methods = amr || [{ method, timestamp: now }];
  const claims = {
    sub: userRow.id, role: 'authenticated', aud: 'authenticated', email: userRow.email, iat: now, exp: now + 3600,
    aal, amr: methods, session_id: randomUUID(),
  };
  const refresh = randomBytes(16).toString('hex');
  refreshTokens.set(refresh, { id: userRow.id, aal, amr: methods });
  return { access_token: signJwt(claims), token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: refresh, user: await userJson(userRow) };
}
const factorsFor = async (id) => (await pool.query(
  `select id, friendly_name, factor_type, status, created_at, updated_at from auth.mfa_factors where user_id = $1 order by created_at`, [id])).rows;
const userJson = async (u) => ({
  id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: u.email_confirmed_at,
  user_metadata: u.raw_user_meta_data || {}, app_metadata: { provider: 'email' }, factors: await factorsFor(u.id), created_at: u.created_at,
});

const challenges = new Map(); // challenge id -> factor id
// Factor writes run as Supabase Auth's own role, as in production, so the
// audit trigger tells them apart from an operator's break-glass delete.
async function asAuth(sql, params) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local session authorization supabase_auth_admin');
    const r = await c.query(sql, params);
    await c.query('commit');
    return r;
  } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
}
function mailConfirm(u, redirect) {
  const token = randomBytes(16).toString('hex');
  confirmTokens.set(token, { id: u.id, redirect });
  mailbox.push({ to: u.email, kind: 'signup', link: `${ORIGIN}/__e2e/verify?token=${token}` });
}
const userById = async (id) => (await pool.query('select * from auth.users where id = $1', [id])).rows[0];
const authError = (res, status, msg, code) => send(res, status, { error: code || 'invalid_grant', error_description: msg, msg, code: status, error_code: code });

// Supabase Auth CAPTCHA protection, off unless a test turns it on via
// /__e2e/captcha. Like GoTrue, sign-up, password sign-in and reset-email
// requests then need gotrue_meta_security.captcha_token; refresh, MFA and
// /verify do not. A token passes once, and only if it starts "e2e-pass-".
let captchaRequired = false;
// "Confirm email" (Supabase Auth mailer_autoconfirm = false), off unless a
// test turns it on via /__e2e/confirm: sign-up then returns no session and
// mails a link, password sign-in is refused until the link is opened.
let confirmRequired = false;
const confirmTokens = new Map(); // token -> { id, redirect }
// Google provider via /__e2e/google: when on, /settings lists it and
// /authorize signs in (or creates) the configured Google account.
let google = { on: false, email: '', name: '' };
const usedCaptcha = new Set();
function captchaRefused(res, body) {
  if (!captchaRequired) return false;
  const t = String(body?.gotrue_meta_security?.captcha_token || '');
  if (!t) { authError(res, 400, 'captcha protection: request disallowed (no captcha_token found)', 'captcha_failed'); return true; }
  if (!t.startsWith('e2e-pass-') || usedCaptcha.has(t)) { authError(res, 400, 'captcha protection: request disallowed (captcha verification process failed)', 'captcha_failed'); return true; }
  usedCaptcha.add(t);
  return false;
}

async function handleAuth(req, res, url, body) {
  const p = url.pathname.replace(/^\/auth\/v1/, '');
  const grantType = url.searchParams.get('grant_type');
  if (((p === '/signup' || p === '/recover' || p === '/resend') && req.method === 'POST') || (p === '/token' && grantType === 'password')) {
    if (captchaRefused(res, body)) return;
  }
  if (p === '/signup' && req.method === 'POST') {
    const email = String(body.email || '').toLowerCase();
    if (!email || String(body.password || '').length < 8) return authError(res, 422, 'Password should be at least 8 characters.', 'weak_password');
    if ((await pool.query('select 1 from auth.users where email = $1', [email])).rowCount) return authError(res, 422, 'User already registered', 'user_already_exists');
    const { rows: [u] } = await pool.query(
      `insert into auth.users(email, encrypted_password, raw_user_meta_data, email_confirmed_at) values ($1, crypt($2, gen_salt('bf', 4)), $3, ${confirmRequired ? 'null' : 'now()'}) returning *`,
      [email, body.password, body.data || {}]);
    if (confirmRequired) {
      mailConfirm(u, url.searchParams.get('redirect_to') || `${SITE}/`);
      return send(res, 200, await userJson(u));
    }
    return send(res, 200, await session(u, 'email/signup'));
  }
  if (p === '/token') {
    const grant = url.searchParams.get('grant_type');
    if (grant === 'password') {
      const { rows: [u] } = await pool.query(
        `select * from auth.users where email = lower($1) and encrypted_password = crypt($2, encrypted_password)`, [body.email, body.password]);
      if (!u) return authError(res, 400, 'Invalid login credentials', 'invalid_credentials');
      if (!u.email_confirmed_at) return authError(res, 400, 'Email not confirmed', 'email_not_confirmed');
      await pool.query('update auth.users set last_sign_in_at = now() where id = $1', [u.id]);
      return send(res, 200, await session(u));
    }
    if (grant === 'refresh_token') {
      const prev = refreshTokens.get(body.refresh_token);
      if (!prev) return authError(res, 400, 'Invalid Refresh Token', 'refresh_token_not_found');
      return send(res, 200, await session(await userById(prev.id), 'password', { aal: prev.aal, amr: prev.amr }));
    }
  }
  const claims = verifyJwt((req.headers.authorization || '').replace(/^Bearer /i, ''));
  if (p === '/user' && req.method === 'GET') {
    if (!claims?.sub) return authError(res, 401, 'invalid JWT', 'bad_jwt');
    const u = await userById(claims.sub);
    return u ? send(res, 200, await userJson(u)) : authError(res, 404, 'User not found', 'user_not_found');
  }
  if (p === '/user' && req.method === 'PUT') {
    if (!claims?.sub) return authError(res, 401, 'invalid JWT', 'bad_jwt');
    // Like Supabase Auth: once a factor is verified, changing the password
    // needs an aal2 session (a reset link alone is aal1).
    if (body.password && claims.aal !== 'aal2' && (await factorsFor(claims.sub)).some((f) => f.status === 'verified')) {
      return authError(res, 403, 'AAL2 session is required to update email or password when MFA is enabled.', 'insufficient_aal');
    }
    if (body.password && String(body.password).length < 8) return authError(res, 422, 'Password should be at least 8 characters.', 'weak_password');
    if (body.password) await pool.query(`update auth.users set encrypted_password = crypt($2, gen_salt('bf', 4)) where id = $1`, [claims.sub, body.password]);
    return send(res, 200, await userJson(await userById(claims.sub)));
  }
  // MFA (TOTP), mirroring Supabase Auth: enrolling another factor or
  // removing a verified one needs an aal2 session once a factor is verified.
  const fm = p.match(/^\/factors(?:\/([0-9a-f-]{36}))?(?:\/(challenge|verify))?$/);
  if (fm) {
    if (!claims?.sub) return authError(res, 401, 'invalid JWT', 'bad_jwt');
    const [, fid, step] = fm;
    const mine = await factorsFor(claims.sub);
    const hasVerified = mine.some((f) => f.status === 'verified');
    if (!fid && req.method === 'POST') {
      if (body.factor_type !== 'totp') return authError(res, 422, 'only totp in e2e', 'validation_failed');
      if (hasVerified && claims.aal !== 'aal2') return authError(res, 403, 'AAL2 required to enroll a new factor', 'insufficient_aal');
      if (mine.some((f) => f.friendly_name === body.friendly_name)) return authError(res, 422, 'A factor with the friendly name already exists', 'mfa_factor_name_conflict');
      const secret = b32encode(randomBytes(20));
      const { rows: [f] } = await asAuth(
        `insert into auth.mfa_factors(user_id, friendly_name, factor_type, status, secret) values ($1, $2, 'totp', 'unverified', $3) returning id`,
        [claims.sub, body.friendly_name || null, secret]);
      return send(res, 200, { id: f.id, type: 'totp', friendly_name: body.friendly_name,
        totp: { qr_code: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>', secret, uri: `otpauth://totp/${body.issuer || 'CPAY'}:${claims.email}?secret=${secret}` } });
    }
    const { rows: [f] } = await pool.query('select * from auth.mfa_factors where id = $1 and user_id = $2', [fid, claims.sub]);
    if (!f) return authError(res, 404, 'Factor not found', 'mfa_factor_not_found');
    if (step === 'challenge' && req.method === 'POST') {
      const id = randomUUID(); challenges.set(id, f.id);
      await asAuth('update auth.mfa_factors set last_challenged_at = now() where id = $1', [f.id]);
      return send(res, 200, { id, type: 'totp', expires_at: Math.floor(Date.now() / 1000) + 300 });
    }
    if (step === 'verify' && req.method === 'POST') {
      if (challenges.get(body.challenge_id) !== f.id) return authError(res, 422, 'Challenge not found', 'mfa_challenge_expired');
      challenges.delete(body.challenge_id);
      const now = Date.now();
      if (![now - 30000, now, now + 30000].some((t) => totp(f.secret, t) === String(body.code))) {
        return authError(res, 422, 'Invalid TOTP code entered', 'mfa_verification_failed');
      }
      if (f.status !== 'verified') await asAuth(`update auth.mfa_factors set status = 'verified', updated_at = now() where id = $1`, [f.id]);
      const ts = Math.floor(now / 1000);
      return send(res, 200, await session(await userById(claims.sub), 'totp',
        { aal: 'aal2', amr: [{ method: 'totp', timestamp: ts }, ...(claims.amr || [])] }));
    }
    if (!step && req.method === 'DELETE') {
      if (f.status === 'verified' && claims.aal !== 'aal2') return authError(res, 403, 'AAL2 required to unenroll a verified factor', 'insufficient_aal');
      await asAuth('delete from auth.mfa_factors where id = $1', [f.id]);
      return send(res, 200, { id: f.id });
    }
  }
  if (p === '/logout') return send(res, 204, null);
  if (p === '/recover') {
    const { rows: [u] } = await pool.query('select * from auth.users where email = lower($1)', [body.email]);
    if (u) {
      const s = await session(u, 'recovery');
      const redirect = url.searchParams.get('redirect_to') || body.redirect_to || `${SITE}/reset.html`;
      // Like the branded template: a one-time hash, used only by /verify.
      const tokenHash = randomBytes(20).toString('hex');
      recoveryHashes.set(tokenHash, u.id);
      mailbox.push({ to: u.email, kind: 'recovery', tokenHash,
        link: `${redirect}#access_token=${s.access_token}&refresh_token=${s.refresh_token}&expires_in=3600&expires_at=${s.expires_at}&token_type=bearer&type=recovery` });
    }
    return send(res, 200, {});
  }
  if (p === '/resend' && req.method === 'POST') {
    const { rows: [u] } = await pool.query('select * from auth.users where email = lower($1)', [body.email]);
    if (u && !u.email_confirmed_at && body.type === 'signup') mailConfirm(u, url.searchParams.get('redirect_to') || `${SITE}/`);
    return send(res, 200, {});
  }
  if (p === '/authorize' && req.method === 'GET') {
    if (!google.on || url.searchParams.get('provider') !== 'google') return authError(res, 400, 'Unsupported provider: provider is not enabled', 'validation_failed');
    let { rows: [u] } = await pool.query('select * from auth.users where email = lower($1)', [google.email]);
    if (!u) {
      ({ rows: [u] } = await pool.query(
        `insert into auth.users(email, raw_user_meta_data, email_confirmed_at) values (lower($1), $2, now()) returning *`,
        [google.email, { full_name: google.name, name: google.name.split(' ')[0], provider_id: 'g-e2e' }]));
    }
    const sess = await session(u, 'oauth');
    const back = url.searchParams.get('redirect_to') || `${SITE}/`;
    res.writeHead(302, { location: `${back}#access_token=${sess.access_token}&refresh_token=${sess.refresh_token}&expires_in=3600&expires_at=${sess.expires_at}&provider_token=e2e-google&token_type=bearer` });
    return res.end();
  }
  if (p === '/verify' && req.method === 'POST') {
    const id = body.type === 'recovery' && recoveryHashes.get(String(body.token_hash || ''));
    if (!id) return authError(res, 403, 'Email link is invalid or has expired', 'otp_expired');
    recoveryHashes.delete(String(body.token_hash));
    return send(res, 200, await session(await userById(id), 'recovery'));
  }
  if (p === '/settings') return send(res, 200, { external: { email: true, google: google.on }, disable_signup: false, mailer_autoconfirm: !confirmRequired });
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
// ownCors: the target answers CORS itself (Edge Functions do, in
// production), so its access-control headers reach the browser unchanged.
async function proxy(req, res, target, raw, { ownCors = false } = {}) {
  const headers = { ...req.headers };
  delete headers.host; delete headers['content-length'];
  const r = await fetch(target, { method: req.method, headers, body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : raw, redirect: 'manual' });
  const out = ownCors ? {} : { ...CORS };
  r.headers.forEach((v, k) => { if (!['content-encoding', 'transfer-encoding', 'content-length', 'connection'].includes(k) && (ownCors || !k.startsWith('access-control-'))) out[k] = v; });
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
  await assertPortsFree(stackPorts(PORT));
  buildDatabase();
  pool = new pg.Pool({ connectionString: `postgres://${PGUSER}:${PGPASSWORD}@${PGHOST}:5432/${DB}`, max: 5 });
  const rest = run(POSTGREST, [], {
    PGRST_DB_URI: `postgres://authenticator:postgres@${PGHOST}:5432/${DB}`, PGRST_DB_SCHEMAS: 'public', PGRST_DB_ANON_ROLE: 'anon',
    PGRST_JWT_SECRET: JWT_SECRET, PGRST_SERVER_PORT: String(REST_PORT), PGRST_SERVER_HOST: '127.0.0.1', PGRST_DB_POOL: '10',
  }, 'postgrest');
  const pay = await startPaymentService();
  const fnEnv = {
    SUPABASE_URL: ORIGIN, SUPABASE_ANON_KEY: ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    PAYMENT_SERVICE_URL: pay.url, PAYMENT_SERVICE_SECRET: SERVICE_SECRET, PAYMENT_SERVICE_AUTH_MODE: 'bearer',
    PUBLIC_SITE_URL: SITE, SITE_URL: SITE, ALLOWED_ORIGINS: SITE, E2E_RUN_ID: RUN_ID,
  };
  const fn = (name, port) => run(DENO, ['run', '--quiet', '--no-lock', '--allow-net', '--allow-env', '--allow-read', 'e2e/fn-wrapper.ts'],
    { ...fnEnv, FN_PORT: String(port), FN_ENTRY: `../supabase/functions/${name}/index.ts` }, name);
  const invoiceFn = fn('create-invoice', INVOICE_FN_PORT);
  const withdrawFn = fn('user-withdraw', WITHDRAW_FN_PORT);

  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    let body = {}; try { body = raw.length ? JSON.parse(raw) : {}; } catch { /* form or empty */ }
    const url = new URL(req.url, ORIGIN);
    try {
      // Edge Functions answer their own preflight, as on Supabase.
      if (req.method === 'OPTIONS' && !url.pathname.startsWith('/functions/v1/')) return send(res, 204, null);
      if (url.pathname.startsWith('/rest/v1/')) return await proxy(req, res, `http://127.0.0.1:${REST_PORT}${url.pathname.slice(8)}${url.search}`, raw);
      if (url.pathname.startsWith('/auth/v1/')) return await handleAuth(req, res, url, body);
      if (url.pathname.startsWith('/realtime/')) return send(res, 404, { msg: 'realtime is not part of the e2e stack; pages poll' });
      if (url.pathname === '/functions/v1/create-invoice') return await proxy(req, res, `http://127.0.0.1:${INVOICE_FN_PORT}/`, raw, { ownCors: true });
      if (url.pathname.startsWith('/functions/v1/user-withdraw')) return await proxy(req, res, `http://127.0.0.1:${WITHDRAW_FN_PORT}${url.pathname.slice('/functions/v1/user-withdraw'.length) || '/'}${url.search}`, raw, { ownCors: true });
      if (url.pathname.startsWith('/functions/v1/')) return send(res, 503, { error: 'not available in e2e' });
      if (url.pathname === '/__e2e/health') return send(res, 200, { ok: true });
      if (url.pathname === '/__e2e/confirm' && req.method === 'POST') { confirmRequired = url.searchParams.get('on') === '1'; return send(res, 200, { confirmRequired }); }
      if (url.pathname === '/__e2e/google' && req.method === 'POST') {
        google = { on: url.searchParams.get('on') === '1', email: url.searchParams.get('email') || '', name: url.searchParams.get('name') || '' };
        return send(res, 200, { google: google.on });
      }
      if (url.pathname === '/__e2e/verify') {
        // Like GoTrue's GET /verify for a sign-up link: confirm, then redirect
        // with a session in the fragment (or an error when used or unknown).
        const t = confirmTokens.get(url.searchParams.get('token') || '');
        if (!t) { res.writeHead(302, { location: `${SITE}/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired` }); return res.end(); }
        confirmTokens.delete(url.searchParams.get('token'));
        await pool.query('update auth.users set email_confirmed_at = now() where id = $1', [t.id]);
        const sess = await session(await userById(t.id), 'otp');
        res.writeHead(302, { location: `${t.redirect}#access_token=${sess.access_token}&refresh_token=${sess.refresh_token}&expires_in=3600&expires_at=${sess.expires_at}&token_type=bearer&type=signup` });
        return res.end();
      }
      if (url.pathname === '/__e2e/captcha' && req.method === 'POST') { captchaRequired = url.searchParams.get('on') === '1'; return send(res, 200, { captchaRequired }); }
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
  const ours = (r) => r.headers.get('x-e2e-run') === RUN_ID;
  await waitReady(rest, 'postgrest', `http://127.0.0.1:${REST_PORT}/`);
  await waitReady(invoiceFn, 'create-invoice', `http://127.0.0.1:${INVOICE_FN_PORT}/`, { ok: ours, ms: 120_000 });
  await waitReady(withdrawFn, 'user-withdraw', `http://127.0.0.1:${WITHDRAW_FN_PORT}/`, { ok: ours, ms: 120_000 });
  server.listen(PORT, '127.0.0.1', () => console.log(`e2e stack ready on ${ORIGIN}`));
  const stop = async () => { for (const c of children) c.kill('SIGTERM'); await pay.service.stop('e2e-end').catch(() => {}); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e); for (const c of children) c.kill(); process.exit(1); });
export { ANON_KEY, SERVICE_KEY, JWT_SECRET };
