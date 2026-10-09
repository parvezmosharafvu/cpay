// The payment service as a process: connect the SDK, start the HTTP server
// and the catch-up timer, and stop cleanly. server.mjs hands in the real
// SDK module and the config; tests hand in a fake.

import http from 'node:http';
import pg from 'pg';
import { createApp, logJson } from './app.mjs';
import { RECORD_STATEMENT_TIMEOUT_MS } from './receipts.mjs';
import { createAdminTokenVerifier } from './auth.mjs';

const errorText = (e) => String(e?.message ?? e).slice(0, 300);

export function createService({ config, breez, log = logJson }) {
  const db = new pg.Pool({ connectionString: config.databaseUrl });
  db.on('error', (e) => log({ event: 'db-idle-client-error', error: errorText(e) }));
  // F1 PR 1: receipt recording gets its own two-connection pool with a
  // server-side statement timeout and a bounded connect wait, so it can
  // neither exhaust nor hold up the pool settlement uses.
  const receiptRecording = config.receiptRecording === 'shadow' ? 'shadow' : 'off';
  const recordDb = receiptRecording === 'shadow'
    ? new pg.Pool({
      connectionString: config.databaseUrl, max: 2, connectionTimeoutMillis: 1_000,
      statement_timeout: RECORD_STATEMENT_TIMEOUT_MS, idleTimeoutMillis: 30_000,
    })
    : null;
  recordDb?.on('error', (e) => log({ event: 'db-idle-client-error', pool: 'receipts', error: errorText(e) }));
  let sdk = null;
  let app = null;
  let server = null;
  let timer = null;
  let stopping = null;

  async function start() {
    const sdkConfig = breez.defaultConfig(config.network);
    if (config.apiKey) sdkConfig.apiKey = config.apiKey;
    // Stablecoin withdrawals need the cross-chain providers. The SDK only
    // accepts this config on mainnet.
    if (config.network === 'mainnet') sdkConfig.crossChainConfig = {};
    sdk = await breez.connect({
      config: sdkConfig,
      seed: { type: 'mnemonic', mnemonic: config.mnemonic },
      storageDir: config.dataDir,
    });
    const verifyAdminToken = config.supabaseUrl && config.supabaseAnonKey
      ? (config.verifyAdminToken ?? createAdminTokenVerifier({ supabaseUrl: config.supabaseUrl, anonKey: config.supabaseAnonKey }))
      : (config.verifyAdminToken ?? null);
    const requestAuthMode = config.requestAuthMode ?? 'any';
    const adminJwtMode = config.adminJwtMode ?? 'optional';
    app = createApp({
      sdk, db, secret: config.secret, log, receiptRecording, recordDb, recordTimeoutMs: config.recordTimeoutMs,
      requestAuthMode, adminJwtMode, verifyAdminToken,
    });
    log({ event: 'receipt-recording', mode: receiptRecording });
    log({ event: 'auth-modes', requestAuth: requestAuthMode, adminJwt: adminJwtMode, adminTokenVerifier: Boolean(verifyAdminToken) });
    await sdk.addEventListener({ onEvent: app.onEvent });
    await sdk.getInfo({ ensureSynced: true });
    app.markSynced();
    await app.catchUp();
    // Listen only after the first catch-up so /ready is true when traffic can arrive.
    app.markReady();
    if (stopping) return null;
    timer = setInterval(() => app.catchUp().catch((e) => log({ event: 'catch-up-failed', error: errorText(e) })), config.catchUpMs);
    server = http.createServer(app.handle);
    await new Promise((resolve) => server.listen(config.port, resolve));
    const { port } = server.address();
    log({ event: 'listening', port, network: config.network });
    return port;
  }

  const started = start();

  // Stop taking requests, wait up to config.shutdownTimeoutMs for in-flight
  // work (requests, user withdrawal sends, admin sends, settles, leaf
  // optimization), then disconnect the SDK. A stop during startup waits for
  // startup to finish first, so the SDK is never torn down mid-connect.
  async function shutdown(signal) {
    log({ event: 'shutdown', signal });
    await started.catch(() => {});
    clearInterval(timer);
    server?.close();
    server?.closeIdleConnections();
    const { drained } = app ? await app.drain(config.shutdownTimeoutMs) : { drained: true };
    server?.closeAllConnections();
    let disconnected = true;
    if (sdk) {
      try { await sdk.disconnect(); } catch (e) { disconnected = false; log({ event: 'sdk-disconnect-failed', error: errorText(e) }); }
    }
    await db.end().catch(() => {});
    await recordDb?.end().catch(() => {});
    log({ event: 'stopped', drained, disconnected });
    return { ok: drained && disconnected, drained, disconnected };
  }

  return {
    started,
    stop: (signal) => (stopping ??= shutdown(signal)),
    get app() { return app; },
  };
}
