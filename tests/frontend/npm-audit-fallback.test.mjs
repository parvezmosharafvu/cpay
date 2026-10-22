import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT = fileURLToPath(new URL('../../ci/npm-audit-with-retry.sh', import.meta.url));

function auditScenario(kind, fallbackExit = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'cpay-audit-test-'));
  const bin = join(dir, 'bin');
  const pkg = join(dir, 'package');
  const marker = join(dir, 'fallback-called');
  mkdirSync(bin);
  mkdirSync(pkg);
  writeFileSync(join(pkg, 'package-lock.json'), '{"name":"fixture","lockfileVersion":3,"packages":{}}');
  const npmStub = `#!/usr/bin/env bash
case "$AUDIT_SCENARIO" in
  quick400)
    echo 'npm warn audit 400 Bad Request - POST https://registry.npmjs.org/-/npm/v1/security/audits/quick - Bad Request' >&2
    exit 1 ;;
  other400)
    echo 'npm warn audit 400 Bad Request - POST https://registry.npmjs.org/-/other - Bad Request' >&2
    exit 1 ;;
  vulnerable)
    echo '1 high severity vulnerability' >&2
    exit 1 ;;
  clean)
    echo 'found 0 vulnerabilities'
    exit 0 ;;
esac
exit 99
`;
  const npxStub = `#!/usr/bin/env bash
printf '%s\\n' "$*" > "$AUDIT_MARKER"
exit "$AUDIT_FALLBACK_EXIT"
`;
  const npmPath = join(bin, 'npm');
  const npxPath = join(bin, 'npx');
  writeFileSync(npmPath, npmStub);
  writeFileSync(npxPath, npxStub);
  chmodSync(npmPath, 0o755);
  chmodSync(npxPath, 0o755);
  try {
    const out = spawnSync('bash', [SCRIPT, pkg], {
      encoding: 'utf8',
      timeout: 8000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH || ''}`,
        AUDIT_SCENARIO: kind,
        AUDIT_MARKER: marker,
        AUDIT_FALLBACK_EXIT: String(fallbackExit),
      },
    });
    assert.equal(out.error, undefined, out.error?.message);
    return { status: out.status, stdout: out.stdout, stderr: out.stderr, fallback: existsSync(marker) ? readFileSync(marker, 'utf8').trim() : null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('retired npm Quick Audit HTTP 400 uses pinned modern full audit', () => {
  const result = auditScenario('quick400', 0);
  assert.equal(result.status, 0);
  assert.match(result.fallback, /npm@11\\.21\\.1 audit --omit=dev --audit-level=high/);
  assert.match(result.stderr, /Quick Audit endpoint returned 400/);
});

test('modern audit failure still blocks the security gate', () => {
  const result = auditScenario('quick400', 1);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /security gate remains blocked/);
});

test('a vulnerability must never trigger a clean fallback', () => {
  const result = auditScenario('vulnerable');
  assert.equal(result.status, 1);
  assert.equal(result.fallback, null);
});

test('unrelated bad requests are not whitelisted as Quick Audit retirement', () => {
  const result = auditScenario('other400');
  assert.equal(result.status, 1);
  assert.equal(result.fallback, null);
});

test('a successful original audit never invokes fallback', () => {
  const result = auditScenario('clean');
  assert.equal(result.status, 0);
  assert.equal(result.fallback, null);
});
