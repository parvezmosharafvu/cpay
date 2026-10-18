// Build CPAY Wallet with the REAL wallet library (production build rules,
// regtest so no API key is needed) into a temp directory and serve it with
// its real headers. Used by sdk.spec.ts.
//   node tests/wallet/build-real.mjs [port]
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

//   node tests/wallet/build-real.mjs <port> [rp-id [off]]
// An rp-id turns passkeys on unless followed by "off" (RP ID set, switch
// off: production's setting until release gate G9).
const port = process.argv[2] || '8792';
const out = mkdtempSync(join(tmpdir(), 'cpay-wallet-real-'));
const env = { ...process.env, WALLET_TEST: '', WALLET_ENGINE: 'sdk', WALLET_NETWORK: 'regtest', WALLET_OUT: out, WALLET_LINK: 'off', WALLET_RP_ID: process.argv[3] || '', WALLET_PASSKEYS: process.argv[3] && process.argv[4] !== 'off' ? 'on' : 'off' };
execFileSync(process.execPath, ['wallet/build.mjs'], { env, stdio: 'inherit' });
spawn(process.execPath, ['wallet/serve.mjs', port], { env: { ...process.env, WALLET_DIST: out }, stdio: 'inherit' });
