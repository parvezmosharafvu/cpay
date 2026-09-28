import http from 'node:http';
import { createRequire } from 'node:module';
import pg from 'pg';
import { loadConfig } from './config.mjs';
import { createApp, logJson } from './app.mjs';

const breez = createRequire(import.meta.url)('@breeztech/breez-sdk-spark');
const config = loadConfig();

const db = new pg.Pool({ connectionString: config.databaseUrl });
db.on('error', (e) => logJson({ event: 'db-idle-client-error', error: e.message }));

const sdkConfig = breez.defaultConfig(config.network);
if (config.apiKey) sdkConfig.apiKey = config.apiKey;
// Stablecoin withdrawals need the cross-chain providers. The SDK only
// accepts this config on mainnet.
if (config.network === 'mainnet') sdkConfig.crossChainConfig = {};

const sdk = await breez.connect({
  config: sdkConfig,
  seed: { type: 'mnemonic', mnemonic: config.mnemonic },
  storageDir: config.dataDir,
});
const app = createApp({ sdk, db, secret: config.secret });
await sdk.addEventListener({ onEvent: app.onEvent });
const server = http.createServer(app.handle);
let timer = null;

let stopping = null;
async function shutdown(signal) {
  logJson({ event: 'shutdown', signal });
  clearInterval(timer);
  server.close();
  server.closeIdleConnections();
  const { drained } = await app.drain(config.shutdownTimeoutMs);
  server.closeAllConnections();
  let disconnected = true;
  try { await sdk.disconnect(); } catch (e) { disconnected = false; logJson({ event: 'sdk-disconnect-failed', error: String(e?.message ?? e) }); }
  await db.end().catch(() => {});
  logJson({ event: 'stopped', drained, disconnected });
  // The SDK leaves handles open after disconnect, so exit explicitly.
  process.exit(drained && disconnected ? 0 : 1);
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopping ??= shutdown(signal); });

await sdk.getInfo({ ensureSynced: true });
app.markSynced();
await app.catchUp();
if (!stopping) {
  timer = setInterval(() => app.catchUp().catch((e) => logJson({ event: 'catch-up-failed', error: String(e?.message ?? e) })), config.catchUpMs);
  server.listen(config.port, () => logJson({ event: 'listening', port: config.port, network: config.network }));
}
