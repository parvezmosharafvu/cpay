// Build CPAY Wallet with the REAL wallet library (production build rules,
// regtest so no API key is needed) into a temp directory and serve it with
// its real headers. Used by sdk.spec.ts.
//   node tests/wallet/build-real.mjs [port]
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

//   node tests/wallet/build-real.mjs <port> [rp-id]   (rp-id turns on passkeys)
const port = process.argv[2] || '8792';
const out = mkdtempSync(join(tmpdir(), 'cpay-wallet-real-'));
const env = { ...process.env, WALLET_TEST: '', WALLET_ENGINE: 'sdk', WALLET_NETWORK: 'regtest', WALLET_OUT: out, WALLET_LINK: 'off', WALLET_RP_ID: process.argv[3] || '' };
execFileSync(process.execPath, ['wallet/build.mjs'], { env, stdio: 'inherit' });
spawn(process.execPath, ['wallet/serve.mjs', port], { env: { ...process.env, WALLET_DIST: out }, stdio: 'inherit' });
