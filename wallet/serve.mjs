// Local static server for wallet/dist that applies dist/_headers the way
// Workers static assets does, so tests run under the real CSP.
//   node serve.mjs [port]   (default 8790; WALLET_DIST=<dir> to serve another build)
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.WALLET_DIST || join(dirname(fileURLToPath(import.meta.url)), 'dist');
const port = Number(process.argv[2] || process.env.PORT || 8790);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png',
};

function rules() {
  const out = [];
  let cur = null;
  for (const line of readFileSync(join(root, '_headers'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) { cur = { path: line.trim(), headers: [] }; out.push(cur); continue; }
    const i = line.indexOf(':');
    cur.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  return out;
}
const RULES = rules();

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (rel.startsWith('..')) { res.writeHead(400).end(); return; }
  let file = join(root, rel);
  if (!rel || (existsSync(file) && statSync(file).isDirectory())) file = join(file, 'index.html');
  if (!existsSync(file) || rel === '_headers') { res.writeHead(404).end('not found'); return; }
  for (const r of RULES) {
    if (r.path === '/*' || r.path === url.pathname) for (const [k, v] of r.headers) res.setHeader(k, v);
  }
  res.setHeader('Content-Type', TYPES[extname(file)] || 'application/octet-stream');
  res.end(readFileSync(file));
}).listen(port, '127.0.0.1', () => console.log(`wallet: http://127.0.0.1:${port}/`));
