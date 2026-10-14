// A stand-in for the CPAY account API (Supabase Auth + the get_my_balance
// RPC) for the wallet's link tests. It records every request it receives,
// body included, so tests can prove the recovery phrase never reaches CPAY.
//   node tests/wallet/fake-cpay.mjs [port]
import { createServer } from 'node:http';

const port = Number(process.argv[2] || 8791);
const log = [];
const sessions = new Set();
const USER = { id: '00000000-0000-4000-8000-00000000c0de', email: 'member@example.test', aud: 'authenticated', role: 'authenticated' };

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

createServer(async (req, res) => {
  cors(res);
  const url = new URL(req.url, 'http://x');
  let body = '';
  for await (const c of req) body += c;
  if (url.pathname === '/__log') return json(res, 200, log);
  if (url.pathname === '/__reset') { log.length = 0; sessions.clear(); return json(res, 200, {}); }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  log.push({ method: req.method, path: url.pathname, query: url.search, headers: req.headers, body });

  if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
    const b = JSON.parse(body || '{}');
    if (b.email !== USER.email || b.password !== 'site-password-123') return json(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
    const token = `at-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessions.add(token);
    return json(res, 200, {
      access_token: token, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: `rt-${token}`, user: USER,
    });
  }
  if (url.pathname === '/auth/v1/logout') {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (url.searchParams.get('scope') === 'global') sessions.clear(); else sessions.delete(token);
    res.writeHead(204); res.end(); return;
  }
  if (url.pathname === '/auth/v1/user') {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    return sessions.has(token) ? json(res, 200, USER) : json(res, 401, { msg: 'invalid JWT' });
  }
  if (url.pathname === '/rest/v1/rpc/get_my_balance') {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!sessions.has(token)) return json(res, 401, { message: 'Not authenticated' });
    return json(res, 200, [{ earned: 40, queued: 0, withdrawn: 27.5, available: 12.5 }]);
  }
  json(res, 404, { message: `not mocked: ${url.pathname}` });
}).listen(port, '127.0.0.1', () => console.log(`fake CPAY API: http://127.0.0.1:${port}/`));
