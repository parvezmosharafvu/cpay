import test from 'node:test';
import assert from 'node:assert/strict';
import { latestDrill, drillProblem, openBlockers, pendingOwnerBlockers, legalGateProblem, isEntrypoint } from '../../scripts/release-gate.mjs';
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

test('latest same-day failed drill refuses release even after earlier success', () => {
  const rows = log([
    '| 2026-10-13 09:00 | operator | backup | staging | **Pass.** |',
    '| 2026-10-13 11:00 | operator | backup | staging | Fail: incorrect totals |',
  ]);
  assert.deepEqual(latestDrill(rows), { date: '2026-10-13', pass: false });
  assert.match(drillProblem(rows, 90, now), /did not pass/);
});
test('latest time wins on same day even when rows are out of order', () => {
  const rows = log([
    '| 2026-10-13 11:00 | operator | backup | staging | Fail: differences |',
    '| 2026-10-13 09:00 | operator | backup | staging | **Pass.** |',
  ]);
  assert.match(drillProblem(rows, 90, now), /did not pass/);
});
test('Pass in backup description does not count as a successful Result', () => {
  const rows = log(['| 2026-10-13 11:00 | operator | **Pass.** previous export | staging | Fail |']);
  assert.match(drillProblem(rows, 90, now), /did not pass/);
});
test('invalid restore drill clock is refused', () => {
  const rows = log(['| 2026-10-13 25:61 | operator | backup | staging | **Pass.** |']);
  assert.match(drillProblem(rows, 90, now), /invalid time/);
});
test('skipping legal verification is diagnostic-only and cannot yield GO', () => {
  let called = 0;
  assert.match(legalGateProblem(['--skip-legal'], () => { called++; }), /production release refused/);
  assert.equal(called, 0);
  assert.equal(legalGateProblem([], () => { called++; }), null);
  assert.equal(called, 1);
  assert.match(legalGateProblem([], () => { throw new Error('not published'); }), /not published/);
});

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
test('Medium owner blockers require a dated owner approval with an evidence link', () => {
  const md = [
    '| A | Medium | open | Owner decision |',
    '| B | Medium | closed | #123 |',
    '| C | Medium | accepted | Owner accepted 2026-10-22 (#169) |',
    '| D | Medium | accepted | Maintainer accepted 2026-10-22 (#169) |',
    '| E | Medium | accepted | Owner accepted 2026-10-22 |',
    '| F | High | open | Owner accepted 2026-10-22 (#169) |',
    '| Mention Medium in description | Low | open | other |',
    '| G | Medium | unknown | Owner decision |',
  ].join('\n');
  const pending = pendingOwnerBlockers(md);
  assert.equal(pending.length, 4);
  for (const name of ['A', 'D', 'E', 'G']) assert.ok(pending.some((row) => row.startsWith(`| ${name} |`)));
  assert.equal(openBlockers(md).length, 1);
});

test('owner-accepted items are case-insensitive but need dated evidence', () => {
  const md = '| A | medium | ACCEPTED | Owner accepted on 2026-10-22 https://github.com/example/project/issues/1 |';
  assert.equal(pendingOwnerBlockers(md).length, 0);
});

test('High/Critical cannot be waived by an accepted or unknown status', () => {
  const rows = [
    '| A | High | accepted | Owner accepted 2026-10-22 (#10) |',
    '| B | Critical | unknown | pending |',
    '| C | Critical | closed | #11 |',
    '| D | Medium | open | pending |',
  ].join('\n');
  assert.equal(openBlockers(rows).length, 2);
});

test('future and invalid owner-acceptance dates remain blocking', () => {
  const today = Date.parse('2026-10-22T12:00:00+06:00');
  const row = (date) => `| A | Medium | accepted | Owner accepted ${date} (#169) |`;
  assert.equal(pendingOwnerBlockers(row('2026-10-22'), today).length, 0);
  assert.equal(pendingOwnerBlockers(row('2026-10-23'), today).length, 1);
  assert.equal(pendingOwnerBlockers(row('2026-02-30'), today).length, 1);
  assert.equal(pendingOwnerBlockers(row('2026-10-22'), NaN).length, 1);
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
