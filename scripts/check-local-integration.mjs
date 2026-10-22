#!/usr/bin/env node
// Read-only prerequisite check for the disposable E2E stack. No database access.
import { spawnSync } from 'node:child_process';
const checks = [
  ['PostgreSQL client', 'psql', ['--version']],
  ['PostgREST', process.env.POSTGREST_BIN || 'postgrest', ['--version']],
  ['Deno', process.env.DENO_BIN || 'deno', ['--version']],
];
let missing = false;
for (const [label, command, args] of checks) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10000 });
  const ok = !result.error && result.status === 0;
  console.log(`${ok ? 'OK' : 'MISSING'} ${label}: ${command}`);
  if (!ok) missing = true;
}
console.log('A running disposable PostgreSQL server, installed root/payment-service dependencies and Chromium are also required.');
console.log('This check does not connect to a database, validate credentials or prove integration readiness.');
process.exitCode = missing ? 1 : 0;
