// ci/check_legal.py: legal fields come from Admin → Settings; release mode
// passes only when the settings say published with every field filled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const run = (...a) => spawnSync('python3', ['ci/check_legal.py', ...a], { encoding: 'utf8' });
const dir = mkdtempSync(join(tmpdir(), 'legal-'));
const full = { legal_entity_name: 'X Ltd', legal_address: '1 Road', legal_effective_date: '2026-11-01', legal_jurisdiction: 'J', legal_courts: 'C', legal_privacy_email: 'p@x.io', legal_support_email: 's@x.io' };
const file = (o) => { const f = join(dir, Math.random() + '.json'); writeFileSync(f, JSON.stringify(o)); return f; };

test('default mode passes on the repository pages', () => assert.equal(run().status, 0, run().stdout));
test('release passes when published and complete', () => assert.equal(run('--release', '--settings-file', file({ ...full, legal_published: true })).status, 0));
test('release fails when not published', () => {
  const r = run('--release', '--settings-file', file({ ...full, legal_published: false }));
  assert.equal(r.status, 1); assert.match(r.stdout, /not published/);
});
test('release fails when a field is empty', () => {
  const r = run('--release', '--settings-file', file({ ...full, legal_courts: '', legal_published: true }));
  assert.equal(r.status, 1); assert.match(r.stdout, /legal_courts/);
});
test('every legal page loads legal-fields.js and stays noindex in static HTML', () => {
  for (const n of ['terms', 'privacy', 'refund', 'contact']) {
    const s = readFileSync(`public/${n}.html`, 'utf8');
    assert.match(s, /legal-fields\.js/); assert.match(s, /noindex/); assert.doesNotMatch(s, /\bDRAFT\b/);
  }
});
