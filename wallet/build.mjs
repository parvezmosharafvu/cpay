// Build CPAY Wallet into wallet/dist (a static site for its own origin).
//
//   cd wallet && npm ci --ignore-scripts && npm run build
//
// Environment (all optional except where noted):
//   WALLET_NETWORK          mainnet (default) | regtest
//   WALLET_API_KEY          the wallet library's API key. Required on mainnet.
//                           A key issued for this app, NOT the website's
//                           server key. It ships inside the app, like any
//                           mobile wallet's key; it is not a secret that
//                           protects funds.
//   CPAY_SUPABASE_URL       } for the optional CPAY account link; default
//   CPAY_SUPABASE_ANON_KEY  } is the website's public config (public/config.js)
//   WALLET_LINK=off         build without the CPAY account link
//   WALLET_SYNC=on          turn on the wallet library's real-time sync
//                           service (datasync.breez.technology). Off by
//                           default: the wallet works without it, and with it
//                           off no wallet data goes to that service.
//   WALLET_OUT=<dir>        output directory (default wallet/dist)
//   WALLET_TEST=1           test build: ships fake-engine.js and allows
//                           WALLET_ENGINE=fake. Never deploy a test build.
//   WALLET_RP_ID=<host>     passkey login: the Relying Party ID, normally the
//                           wallet's own hostname (wallet.pay-cashapp.buzz).
//                           Unset = no passkey option. Every passkey is bound
//                           to this value for good: changing it later strands
//                           existing passkeys (their owners restore with the
//                           12 words).
//   WALLET_STAGE=staging    the staging project (cpay-wallet-staging, test
//                           coins only): must be regtest, with no API key and
//                           the CPAY link off. `npm run build:staging` sets it.
//
// The wallet library, supabase-js and qrcode-generator come from node_modules, pinned with
// integrity hashes in package-lock.json, and are copied, not edited.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const env = (k, d = '') => (process.env[k] ?? d).trim();
const out = env('WALLET_OUT') ? resolve(env('WALLET_OUT')) : join(here, 'dist');
const fail = (m) => { console.error(`wallet build: ${m}`); process.exit(1); };

const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
const test = env('WALLET_TEST') === '1';
const engine = env('WALLET_ENGINE', 'sdk');
const network = env('WALLET_NETWORK', 'mainnet');
const apiKey = env('WALLET_API_KEY');

if (!['sdk', 'fake'].includes(engine)) fail('WALLET_ENGINE must be sdk or fake');
if (engine === 'fake' && !test) fail('WALLET_ENGINE=fake is for test builds only (set WALLET_TEST=1)');
if (!['mainnet', 'regtest'].includes(network)) fail('WALLET_NETWORK must be mainnet or regtest');
const rpId = env('WALLET_RP_ID').toLowerCase();
if (rpId && rpId !== 'localhost' && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(rpId)) fail('WALLET_RP_ID must be a host name such as wallet.example.com');
if (/service_role/.test(env('CPAY_SUPABASE_ANON_KEY'))) fail('that is a service-role key; only the public anon key belongs in the wallet');
// Staging never touches real money or real accounts, and never carries the
// dedicated wallet key, which belongs only on the production project.
const stage = env('WALLET_STAGE');
if (stage && stage !== 'staging') fail('WALLET_STAGE must be staging or unset');
if (stage === 'staging') {
  if (network !== 'regtest') fail('a staging build must be WALLET_NETWORK=regtest (test coins only)');
  if (apiKey) fail('a staging build takes no WALLET_API_KEY; the dedicated key belongs only on the production project');
  if (env('WALLET_LINK') !== 'off') fail('a staging build must set WALLET_LINK=off (no link to real CPAY accounts)');
}

// Optional CPAY link: the website's own public config by default.
let supabaseUrl = env('CPAY_SUPABASE_URL');
let anonKey = env('CPAY_SUPABASE_ANON_KEY');
if (env('WALLET_LINK') !== 'off' && (!supabaseUrl || !anonKey)) {
  const site = readFileSync(join(here, '..', 'public', 'config.js'), 'utf8');
  supabaseUrl ||= (site.match(/SUPABASE_URL\s*=\s*'([^']+)'/) || [])[1] || '';
  anonKey ||= (site.match(/SUPABASE_ANON_KEY\s*=\s*'([^']+)'/) || [])[1] || '';
}
if (env('WALLET_LINK') === 'off') { supabaseUrl = ''; anonKey = ''; }
if (supabaseUrl && !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(supabaseUrl) && !test) fail('CPAY_SUPABASE_URL must be https://<project>.supabase.co');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// App files.
const SKIP = test ? new Set() : new Set(['fake-engine.js']);
for (const f of readdirSync(join(here, 'src'))) {
  if (SKIP.has(f)) continue;
  cpSync(join(here, 'src', f), join(out, f), { recursive: true });
}

// Vendored libraries, byte for byte.
const sdkWeb = join(here, 'node_modules', '@breeztech', 'breez-sdk-spark', 'web');
const supaUmd = join(here, 'node_modules', '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js');
if (!existsSync(sdkWeb) || !existsSync(supaUmd)) fail('run `npm ci --ignore-scripts` in wallet/ first');
mkdirSync(join(out, 'vendor'), { recursive: true });
cpSync(sdkWeb, join(out, 'vendor', 'sdk'), {
  recursive: true,
  filter: (p) => !/\.d\.ts$/.test(p), // types are not used
});
cpSync(supaUmd, join(out, 'vendor', 'supabase.js'));
const qrLib = join(here, 'node_modules', 'qrcode-generator', 'dist', 'qrcode.mjs');
if (!existsSync(qrLib)) fail('qrcode-generator missing: run `npm ci --ignore-scripts` in wallet/');
cpSync(qrLib, join(out, 'vendor', 'qrcode.js'));
const sdkVersion = JSON.parse(readFileSync(join(here, 'node_modules', '@breeztech', 'breez-sdk-spark', 'package.json'), 'utf8')).version;

// Runtime config (public values only).
const config = {
  version: pkg.version, network, engine, apiKey: apiKey || null,
  cpaySupabaseUrl: supabaseUrl || null, cpaySupabaseAnonKey: anonKey || null,
  serviceWorker: env('WALLET_SW') !== 'off',
  sync: env('WALLET_SYNC') === 'on',
  rpId: rpId || null,
};
writeFileSync(join(out, 'config.js'),
  `// Generated by wallet/build.mjs. Public values only: no recovery phrase,\n// no service-role key, no server secret.\nwindow.CPAY_WALLET_CONFIG = Object.freeze(${JSON.stringify(config, null, 2)});\n`);

// Strict headers for the wallet's own origin. No inline script, no eval
// (WebAssembly compile only), connections only to the payment network the
// wallet library uses and, if linking is on, the CPAY account API.
const supaOrigin = supabaseUrl ? new URL(supabaseUrl).origin : null;
const connect = [
  "'self'",
  'https://0.spark.lightspark.com', 'https://spark-operator.breez.technology', 'https://2.spark.flashnet.xyz',
  'https://api.lightspark.com', 'https://api.flashnet.xyz',
  ...(config.sync ? ['https://datasync.breez.technology:442'] : []), 'https://nd1.breez.technology', 'https://bsw1.breez.technology',
  'https://mempool.space', 'https://cloudflare-dns.com',
  ...(network === 'regtest' ? ['https://regtest-mempool.us-west-2.sparkinfra.net'] : []),
  ...(supaOrigin ? [supaOrigin] : []),
].join(' ');
const csp = [
  "default-src 'none'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self'", "img-src 'self' data:",
  `connect-src ${connect}`, "worker-src 'self' blob:", "manifest-src 'self'",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'", "object-src 'none'",
].join('; ');
writeFileSync(join(out, '_headers'), `/*
  Content-Security-Policy: ${csp}
  Strict-Transport-Security: max-age=31536000
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), publickey-credentials-get=(self), publickey-credentials-create=(self)
  Cross-Origin-Opener-Policy: same-origin

/sw.js
  Cache-Control: no-cache
/version.json
  Cache-Control: no-cache
`);

// Release manifest: every file and its sha256, so a published release can
// be checked file by file. The service worker precaches the same list.
function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(out).map((p) => relative(out, p).split('\\').join('/')).filter((p) => p !== '_headers').sort();
const sw = readFileSync(join(out, 'sw.js'), 'utf8')
  .replace("const VERSION = '__VERSION__';", `const VERSION = ${JSON.stringify(`${pkg.version}-${network}`)};`)
  .replace('const FILES = __PRECACHE__;', `const FILES = ${JSON.stringify(['./', ...files.filter((f) => f !== 'sw.js')])};`);
if (/const (VERSION|FILES) = __/.test(sw)) fail('sw.js placeholders not replaced');
writeFileSync(join(out, 'sw.js'), sw);
const hashes = {};
for (const f of walk(out).map((p) => relative(out, p).split('\\').join('/')).sort()) {
  hashes[f] = createHash('sha256').update(readFileSync(join(out, f))).digest('hex');
}
const release = { name: 'CPAY Wallet', version: pkg.version, network, walletLibrary: { name: '@breeztech/breez-sdk-spark', version: sdkVersion }, test, files: hashes };
writeFileSync(join(out, 'version.json'), JSON.stringify(release, null, 2) + '\n');
const manifestHash = createHash('sha256').update(readFileSync(join(out, 'version.json'))).digest('hex');

console.log(`wallet build: v${pkg.version} ${network}${test ? ' (TEST BUILD)' : ''}, engine ${engine}, library ${sdkVersion}, ${Object.keys(hashes).length} files`);
console.log(`wallet build: link ${supaOrigin ? `on (${supaOrigin})` : 'off'}, sync ${config.sync ? 'on' : 'off'}, api key ${apiKey ? 'set' : 'NOT set'}`);
console.log(`wallet build: version.json sha256 ${manifestHash}`);
if (network === 'mainnet' && !apiKey && engine === 'sdk') console.log('wallet build: NOTE without WALLET_API_KEY the app shows "Not available yet" and creates nothing');
