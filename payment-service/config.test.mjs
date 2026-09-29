import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, redactor } from './config.mjs';
import { logJson } from './app.mjs';

const WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const SECRET = 's'.repeat(20) + 'k'.repeat(20);
const base = {
  BREEZ_NETWORK: 'regtest', BREEZ_MNEMONIC: WORDS, BREEZ_DATA_DIR: '/data/breez',
  DATABASE_URL: 'postgres://svc:db-pass-123@db.example:5432/postgres', PAYMENT_SERVICE_SECRET: SECRET,
};

test('a complete environment loads, with defaults for the optional settings', () => {
  const c = loadConfig(base);
  assert.equal(c.network, 'regtest');
  assert.equal(c.mnemonic, WORDS);
  assert.equal(c.port, 8080);
  assert.equal(c.catchUpMs, 300_000);
  assert.equal(c.shutdownTimeoutMs, 90_000);
  assert.ok(Object.isFrozen(c));
});

test('the mnemonic is read from BREEZ_MNEMONIC_FILE, whitespace tidied', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cfg-')), 'mnemonic');
  writeFileSync(file, `  ${WORDS.replaceAll(' ', '\n')}\n\n`);
  const { BREEZ_MNEMONIC, ...env } = base;
  assert.equal(loadConfig({ ...env, BREEZ_MNEMONIC_FILE: file }).mnemonic, WORDS);
  assert.throws(() => loadConfig({ ...base, BREEZ_MNEMONIC_FILE: file }), /set BREEZ_MNEMONIC or BREEZ_MNEMONIC_FILE, not both/);
  assert.throws(() => loadConfig({ ...env, BREEZ_MNEMONIC_FILE: `${file}.missing` }), /BREEZ_MNEMONIC_FILE cannot be read/);
});

test('every bad variable is named in one error, and no value ever appears in it', () => {
  const env = {
    BREEZ_NETWORK: 'testnet', BREEZ_MNEMONIC: 'only three words', PAYMENT_SERVICE_SECRET: 'short-secret-value',
    PORT: '80a', CATCH_UP_INTERVAL_SECS: '5', SHUTDOWN_TIMEOUT_SECS: '9999',
  };
  let message = '';
  try { loadConfig(env); } catch (e) { message = e.message; }
  for (const expected of [
    'BREEZ_NETWORK must be mainnet or regtest', 'the mnemonic must be 12 or 24 words', 'BREEZ_DATA_DIR is required',
    'DATABASE_URL is required', 'PAYMENT_SERVICE_SECRET must be at least 32 characters', 'PORT must be',
    'CATCH_UP_INTERVAL_SECS must be', 'SHUTDOWN_TIMEOUT_SECS must be',
  ]) assert.ok(message.includes(expected), `${expected} in: ${message}`);
  for (const value of ['only three words', 'short-secret-value', 'testnet', '80a', '9999']) assert.ok(!message.includes(value), value);
});

test('mainnet needs an API key', () => {
  assert.throws(() => loadConfig({ ...base, BREEZ_NETWORK: 'mainnet' }), /BREEZ_API_KEY is required on mainnet/);
  assert.equal(loadConfig({ ...base, BREEZ_NETWORK: 'mainnet', BREEZ_API_KEY: 'api-key-value' }).network, 'mainnet');
});

test('log lines never carry the secret, the mnemonic, the API key or the database password', (t) => {
  const c = loadConfig({ ...base, BREEZ_API_KEY: 'api-key-value-9' });
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  const redact = redactor(c);
  logJson({ event: 'request-failed', error: `connect to ${c.databaseUrl} failed; auth Bearer ${SECRET}; seed ${WORDS}; key api-key-value-9` }, redact);
  logJson({ event: 'db', error: 'password authentication failed: db-pass-123' }, redact);
  const out = lines.join('\n');
  for (const s of [SECRET, WORDS, 'api-key-value-9', 'db-pass-123']) assert.ok(!out.includes(s), s);
  assert.equal(out.match(/\[redacted\]/g).length, 5);
});
