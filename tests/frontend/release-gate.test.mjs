import test from 'node:test';
import assert from 'node:assert/strict';
import { latestDrill, drillProblem, openBlockers } from '../../scripts/release-gate.mjs';

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
test('open Critical/High blockers are found, closed and Medium are not', () => {
  const md = '| A | High | open | x |\n| B | Critical | closed | y |\n| C | Medium | open | z |\n| D | critical | OPEN | w |';
  assert.equal(openBlockers(md).length, 2);
});
test('repository blockers file has no open Critical/High today', async () => {
  const { readFileSync } = await import('node:fs');
  assert.equal(openBlockers(readFileSync('docs/RELEASE-BLOCKERS.md', 'utf8')).length, 0);
});
