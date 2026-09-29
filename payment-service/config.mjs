// Every setting the payment service reads, from the environment only.
// loadConfig() checks all of them and throws one error naming every bad
// variable. Error messages carry variable names, never values.

import { readFileSync } from 'node:fs';

const NETWORKS = new Set(['mainnet', 'regtest']);
export const MIN_SECRET_LENGTH = 32;

function int(env, name, fallback, min, max, errors) {
  const raw = env[name] ?? String(fallback);
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < min || n > max) errors.push(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

function mnemonicFrom(env, errors) {
  const inline = env.BREEZ_MNEMONIC ?? '';
  const file = env.BREEZ_MNEMONIC_FILE ?? '';
  if (inline && file) { errors.push('set BREEZ_MNEMONIC or BREEZ_MNEMONIC_FILE, not both'); return ''; }
  let words = inline;
  if (file) {
    try { words = readFileSync(file, 'utf8'); } catch { errors.push('BREEZ_MNEMONIC_FILE cannot be read'); return ''; }
  }
  words = words.trim().split(/\s+/).join(' ');
  if (!words) errors.push('BREEZ_MNEMONIC or BREEZ_MNEMONIC_FILE is required');
  else if (![12, 24].includes(words.split(' ').length)) errors.push('the mnemonic must be 12 or 24 words');
  return words;
}

export function loadConfig(env = process.env) {
  const errors = [];
  const required = (name) => {
    const v = env[name] ?? '';
    if (!v) errors.push(`${name} is required`);
    return v;
  };
  const network = required('BREEZ_NETWORK');
  if (network && !NETWORKS.has(network)) errors.push('BREEZ_NETWORK must be mainnet or regtest');
  const apiKey = env.BREEZ_API_KEY ?? '';
  if (network === 'mainnet' && !apiKey) errors.push('BREEZ_API_KEY is required on mainnet');
  const mnemonic = mnemonicFrom(env, errors);
  const dataDir = required('BREEZ_DATA_DIR');
  const databaseUrl = required('DATABASE_URL');
  const secret = required('PAYMENT_SERVICE_SECRET');
  if (secret && secret.length < MIN_SECRET_LENGTH) errors.push(`PAYMENT_SERVICE_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  const port = int(env, 'PORT', 8080, 1, 65535, errors);
  const catchUpSecs = int(env, 'CATCH_UP_INTERVAL_SECS', 300, 30, 3600, errors);
  const shutdownSecs = int(env, 'SHUTDOWN_TIMEOUT_SECS', 90, 1, 600, errors);
  if (errors.length) throw new Error(`invalid configuration: ${errors.join('; ')}`);
  return Object.freeze({
    network, apiKey, mnemonic, dataDir, databaseUrl, secret, port,
    catchUpMs: catchUpSecs * 1000, shutdownTimeoutMs: shutdownSecs * 1000,
  });
}

// Replaces every secret value in a log line. The database password is
// included because a connection error can quote the URL.
export function redactor(config) {
  let dbPassword = '';
  try { dbPassword = decodeURIComponent(new URL(config.databaseUrl).password); } catch {}
  const secrets = [config.secret, config.apiKey, config.mnemonic, dbPassword, config.databaseUrl]
    .filter((s) => s && s.length >= 6)
    .sort((a, b) => b.length - a.length);
  return (line) => secrets.reduce((out, s) => out.split(s).join('[redacted]'), line);
}
