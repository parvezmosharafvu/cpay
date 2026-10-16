#!/usr/bin/env node
// Check a published CPAY Wallet against its own release manifest, file by
// file, before the website's Download page links to it (release gate G5 in
// docs/WALLET-RELEASE-GATES.md). Read-only: it only downloads public files.
//
//   node scripts/wallet-verify-release.mjs <https://wallet-host>
//        [--network mainnet|regtest] [--sha256 <version.json sha256>]
//
// Passes only when:
//   - the address is https on its own host (never the CPAY website), with no
//     path, query or credentials;
//   - version.json is a release build (not a test build), for the expected
//     network, and its sha256 equals --sha256 when given (the value the
//     build printed, also recorded in public/wallet-release.js);
//   - every file version.json lists downloads with the same sha256
//     (_headers is read by Cloudflare and never served, so it is checked
//     through the response headers instead);
//   - the page is served with the wallet's strict security headers.
//
// The GitHub workflow "Wallet release check" runs this from the browser.
// Tests use --insecure-local to check a build served on 127.0.0.1.
import { createHash } from 'node:crypto';

const WEBSITE_HOSTS = /(^|\.)pay-cashapp\.buzz$/i;

function parse(argv) {
  const o = { url: null, network: null, sha256: null, insecureLocal: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--network') o.network = argv[++i];
    else if (a === '--sha256') o.sha256 = (argv[++i] || '').toLowerCase();
    else if (a === '--insecure-local') o.insecureLocal = true;
    else if (!o.url) o.url = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!o.url) throw new Error('usage: wallet-verify-release.mjs <https://wallet-host> [--network mainnet|regtest] [--sha256 <hex>]');
  if (o.network && !['mainnet', 'regtest'].includes(o.network)) throw new Error('--network must be mainnet or regtest');
  if (o.sha256 && !/^[0-9a-f]{64}$/.test(o.sha256)) throw new Error('--sha256 must be 64 hex characters');
  return o;
}

function origin(raw, insecureLocal) {
  const u = new URL(raw);
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !(insecureLocal && local && u.protocol === 'http:')) throw new Error(`${raw}: must be https`);
  if (u.username || u.password) throw new Error(`${raw}: no credentials in the address`);
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) throw new Error(`${raw}: give the wallet's own host only, no path or query`);
  if (WEBSITE_HOSTS.test(u.hostname)) throw new Error(`${u.hostname}: the wallet needs its own hostname, not the CPAY website's`);
  return u.origin;
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

async function get(base, path) {
  const r = await fetch(`${base}/${path}`, { redirect: 'follow', headers: { 'cache-control': 'no-cache' } });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return { body: Buffer.from(await r.arrayBuffer()), headers: r.headers };
}

export async function verify(opts) {
  const base = origin(opts.url, opts.insecureLocal);
  const problems = [];
  const manifest = await get(base, 'version.json');
  const manifestSha = sha(manifest.body);
  let release;
  try { release = JSON.parse(manifest.body.toString('utf8')); } catch { throw new Error('version.json is not JSON'); }
  if (opts.sha256 && manifestSha !== opts.sha256) problems.push(`version.json sha256 ${manifestSha}, expected ${opts.sha256}`);
  if (release.test !== false) problems.push('version.json says this is a TEST build; never publish one');
  if (opts.network && release.network !== opts.network) problems.push(`network ${release.network}, expected ${opts.network}`);
  const files = Object.entries(release.files || {});
  if (!files.length) problems.push('version.json lists no files');

  let checked = 0;
  for (const [path, want] of files) {
    if (path === '_headers' || path === 'version.json') continue;
    if (!/^[\w./-]+$/.test(path) || path.includes('..')) { problems.push(`${path}: unexpected file name`); continue; }
    try {
      const got = sha((await get(base, path)).body);
      if (got !== want) problems.push(`${path}: sha256 ${got}, manifest says ${want}`);
      checked += 1;
    } catch (e) {
      problems.push(e.message);
    }
  }

  // Cloudflare applies _headers; check what it actually serves.
  const page = await get(base, '');
  const csp = page.headers.get('content-security-policy') || '';
  for (const rule of ["default-src 'none'", "script-src 'self' 'wasm-unsafe-eval'", "frame-ancestors 'none'", "object-src 'none'"]) {
    if (!csp.includes(rule)) problems.push(`page CSP is missing ${rule}`);
  }
  if (/unsafe-inline/.test(csp)) problems.push('page CSP allows unsafe-inline');
  if ((page.headers.get('x-frame-options') || '').toUpperCase() !== 'DENY') problems.push('X-Frame-Options is not DENY');

  return { ok: problems.length === 0, problems, origin: base, version: release.version, network: release.network, manifestSha, checked };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const opts = parse(process.argv.slice(2));
    const r = await verify(opts);
    console.log(`wallet release check: ${r.origin} v${r.version} ${r.network}, ${r.checked} files checked`);
    console.log(`wallet release check: version.json sha256 ${r.manifestSha}`);
    if (!r.ok) {
      for (const p of r.problems) console.error(`FAIL ${p}`);
      process.exit(1);
    }
    console.log('wallet release check: PASS (every file matches the manifest; strict headers served)');
  } catch (e) {
    console.error(`wallet release check: ${e.message}`);
    process.exit(2);
  }
}
