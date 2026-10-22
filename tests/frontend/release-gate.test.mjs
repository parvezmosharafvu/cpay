import test from 'node:test';
import assert from 'node:assert/strict';
import { latestDrill, drillProblem, openBlockers, isEntrypoint } from '../../scripts/release-gate.mjs';
import { mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const log = (rows) => `| Date (Dhaka) | Who | Source | Target | Result |\n|---|---|---|---|---|\n${rows.join('\n')}\n`;
const now = Date.parse('2026-10-14T00:00:00+06:00');

test('latest passing drill within window is accepted', () => {
  const md = log(['| 2026-10-13 11:50 | a | b | c | **Pass.** ok |']);
  assert.deepEqual(latestDrill(md), { date: '2026-10-13', pass: true });
  assert.equal(drillProblem(md, 90, now), null);
});
test('stale drill is refused', () => {
  assert.match(drillProblem(log(['| 2026-06-01 10:00 | a | b | c | **Pass.** |']), 90, now), /days old/);
});
test('failed latest drill is refused even if an older one passed', () => {
  assert.match(drillProblem(log(['| 2026-09-01 | a | b | c | **Pass.** |', '| 2026-10-10 | a | b | c | Fail: rows differ |']), 90, now), /did not pass/);
});
test('no drill is refused', () => { assert.match(drillProblem('nothing', 90, now), /no restore drill/); });
test('future-dated restore evidence is refused, even if marked Pass', () => {
  assert.match(drillProblem(log(['| 2026-10-15 12:00 | a | b | c | **Pass.** |']), 90, now), /future/);
});
test('invalid calendar dates cannot satisfy the restore gate', () => {
  assert.match(drillProblem(log(['| 2026-02-30 12:00 | a | b | c | **Pass.** |']), 365, now), /invalid restore drill date/);
  assert.match(drillProblem(log(['| 2026-13-01 12:00 | a | b | c | **Pass.** |']), 365, now), /invalid restore drill date/);
});
test('invalid drill windows or clock inputs refuse a release', () => {
  const md = log(['| 2026-10-13 12:00 | a | b | c | **Pass.** |']);
  for (const days of [-1, Infinity, NaN, 0.5]) assert.match(drillProblem(md, days, now), /invalid restore drill age limit/);
  assert.match(drillProblem(md, 90, NaN), /invalid current time/);
});
test('open Critical/High blockers are found, closed and Medium are not', () => {
  const md = '| A | High | open | x |\n| B | Critical | closed | y |\n| C | Medium | open | z |\n| D | critical | OPEN | w |';
  assert.equal(openBlockers(md).length, 2);
});
test('repository blockers file has no open Critical/High today', async () => {
  const { readFileSync } = await import('node:fs');
  assert.equal(openBlockers(readFileSync('docs/RELEASE-BLOCKERS.md', 'utf8')).length, 0);
});
test('entrypoint check survives spaces and symlinks in the path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release gate '));
  const file = join(dir, 'gate.mjs');
  writeFileSync(file, '');
  const link = join(dir, 'link.mjs');
  symlinkSync(file, link);
  const url = pathToFileURL(file).href;
  assert.equal(isEntrypoint(url, file), true);
  assert.equal(isEntrypoint(url, link), true);
  assert.equal(isEntrypoint(url, join(dir, 'other.mjs')), false);
  assert.equal(isEntrypoint(url, undefined), false);
});

// End to end: run the real script from paths that used to skip main() and
// exit 0 silently. The copy sits outside any git repo, so a gate that runs
// must refuse (git fails) and say so; exit 0 or empty output is the old bug.
test('gate never exits 0 silently: spaces, unicode, symlinks, missing path, failing command', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdirSync, copyFileSync, realpathSync } = await import('node:fs');
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'gate-e2e-')));
  const tree = join(base, 'repo with spaces ü');
  mkdirSync(join(tree, 'scripts'), { recursive: true });
  copyFileSync('scripts/release-gate.mjs', join(tree, 'scripts', 'release-gate.mjs'));
  symlinkSync(tree, join(base, 'linked repo'));
  mkdirSync(join(base, 'nested', 'deeper'), { recursive: true });
  symlinkSync(join(base, 'linked repo'), join(base, 'nested', 'deeper', 'link2'));
  symlinkSync(join(tree, 'scripts', 'release-gate.mjs'), join(base, 'gate-link.mjs'));
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: base };
  const run = (script, cwd = base) => spawnSync(process.execPath, [script, '--skip-legal'], { cwd, env, encoding: 'utf8' });
  for (const script of [
    join(tree, 'scripts', 'release-gate.mjs'),
    join(base, 'linked repo', 'scripts', 'release-gate.mjs'),
    join(base, 'nested', 'deeper', 'link2', 'scripts', 'release-gate.mjs'),
    join(base, 'gate-link.mjs'),
    './repo with spaces ü/scripts/release-gate.mjs',
  ]) {
    const r = run(script);
    assert.equal(r.status, 1, `${script}: exit ${r.status}\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /RELEASE REFUSED/, script);
    // Anchored to the script's own canonical repository, not the launch cwd.
    assert.match(r.stdout, new RegExp(`repository ${tree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`), script);
  }
  // Launched from inside this (real) repository it still checks its own tree.
  const fromRepo = run(join(tree, 'scripts', 'release-gate.mjs'), process.cwd());
  assert.equal(fromRepo.status, 1);
  assert.match(fromRepo.stdout, /repository .*repo with spaces ü\n/);
  const missing = run(join(base, 'does not exist.mjs'));
  assert.notEqual(missing.status, 0);
  const broken = join(base, 'broken.mjs');
  symlinkSync(join(base, 'gone.mjs'), broken);
  assert.notEqual(run(broken).status, 0);
});
