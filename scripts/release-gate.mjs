#!/usr/bin/env node
// CPAY release gate. Refuses a production release unless:
//   1. the SHA is the current origin/main and the worktree is clean
//   2. the Verify workflow has a successful run for that exact SHA
//   3. "Workers Builds: cpay" (the site deploy) succeeded for that SHA, so
//      the deployed site SHA equals the verified SHA
//   4. the latest restore drill in docs/BACKUP-RECOVERY.md passed and is
//      younger than --drill-max-days (default 90)
//   5. docs/RELEASE-BLOCKERS.md lists no open Critical/High item AND
//      all Medium owner blockers are closed or explicitly accepted with evidence
//   6. legal pages published from Admin → Settings with every field filled (ci/check_legal.py --release)
// Read-only: it never deploys anything. Usage:
//   node scripts/release-gate.mjs [--sha <sha>] [--drill-max-days 90] [--skip-legal]
// --skip-legal is diagnostic only and always refuses release.\n// Exit 0 = GO for this SHA, 1 = refused (reasons printed).
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function latestDrill(md) {
  // Use the Result column only. A successful drill must not be inferred from
  // the source/target description, and a later same-day failed drill wins.
  let best = null;
  for (const row of md.split('\n')) {
    const found = row.match(/^\|\s*(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?\s*\|/);
    if (!found) continue;
    const date = found[1];
    const time = found[2] || '00:00';
    const validTime = Number(time.slice(0, 2)) < 24 && Number(time.slice(3)) < 60;
    const cells = row.trim().split('|').slice(1, -1).map((v) => v.trim());
    const result = cells.length >= 5 ? cells[4] : '';
    const pass = /^\*{0,2}Pass\b/i.test(result);
    const key = `${date}T${time}`;
    // Tie-break toward the later row: the log is append-only.
    if (!best || key >= best.key) best = { key, date, pass, validTime };
  }
  if (!best) return null;
  return best.validTime ? { date: best.date, pass: best.pass } : { date: best.date, pass: false, invalidTime: true };
}

export function openBlockers(md) {
  // High and Critical can be closed, but never accepted in lieu of a fix.
  return md.split('\n').filter((line) => {
    if (!/^\s*\|/.test(line)) return false;
    const cells = line.trim().split('|').slice(1, -1).map((cell) => cell.trim());
    const severity = cells[1]?.toLowerCase();
    return (severity === 'critical' || severity === 'high') && cells[2]?.toLowerCase() !== 'closed';
  });
}

/** Medium issues need closure or explicit, dated owner acceptance with an evidence link. */
export function pendingOwnerBlockers(md, nowMs = Date.now()) {
  return md.split('\n').filter((line) => {
    if (!/^\s*\|/.test(line)) return false;
    const cells = line.trim().split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells[1]?.toLowerCase() !== 'medium') return false;
    const status = (cells[2] || '').toLowerCase();
    if (status === 'closed') return false;
    if (status !== 'accepted') return true;
    const evidence = cells.slice(3).join(' | ');
    const signed = evidence.match(/\bowner accepted(?: on)? (20\d{2}-\d{2}-\d{2})\b/i);
    if (!signed || !/(?:https:\/\/\S+|#[1-9]\d*)/.test(evidence) || !Number.isFinite(nowMs)) return true;
    // Invalid or future-dated sign-offs cannot bypass an unresolved blocker.
    const day = new Date(`${signed[1]}T00:00:00Z`);
    const midnightDhaka = Date.parse(`${signed[1]}T00:00:00+06:00`);
    return !Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== signed[1]
      || !Number.isFinite(midnightDhaka) || midnightDhaka > nowMs;
  });
}

export function drillProblem(md, maxDays, nowMs = Date.now()) {
  // Invalid options and evidence must never silently make the release gate pass.
  if (!Number.isInteger(maxDays) || maxDays < 0) return 'invalid restore drill age limit';
  if (!Number.isFinite(nowMs)) return 'invalid current time for restore drill check';
  const d = latestDrill(md);
  if (!d) return 'no restore drill recorded in docs/BACKUP-RECOVERY.md';
  if (d.invalidTime) return `latest restore drill (${d.date}) has invalid time`;
  if (!d.pass) return `latest restore drill (${d.date}) did not pass`;
  const dateUTC = new Date(`${d.date}T00:00:00Z`);
  if (!Number.isFinite(dateUTC.getTime()) || dateUTC.toISOString().slice(0, 10) !== d.date) {
    return `invalid restore drill date (${d.date})`;
  }
  const drillMs = Date.parse(`${d.date}T00:00:00+06:00`);
  if (!Number.isFinite(drillMs)) return `invalid restore drill date (${d.date})`;
  if (drillMs > nowMs) return `restore drill date (${d.date}) is in the future`;
  const age = Math.floor((nowMs - drillMs) / 86400000);
  if (age > maxDays) return `latest restore drill is ${age} days old (max ${maxDays})`;
  return null;
}

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function main(argv) {
  // Check the repository this script lives in (canonical, symlinks resolved),
  // never whatever directory it happens to be launched from.
  const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
  process.chdir(root);
  console.log(`release gate: repository ${root}`);
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const fails = [];
  sh('git', ['fetch', '-q', 'origin', 'main']);
  const main = sh('git', ['rev-parse', 'origin/main']);
  const sha = opt('--sha', sh('git', ['rev-parse', 'HEAD']));
  if (sha !== main) fails.push(`SHA ${sha} is not origin/main (${main})`);
  if (sh('git', ['status', '--porcelain', '--untracked-files=no'])) fails.push('worktree has uncommitted changes');
  const repo = sh('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  const runs = JSON.parse(sh('gh', ['api', `repos/${repo}/actions/runs?head_sha=${sha}&per_page=50`, '--jq', '[.workflow_runs[]|{name,conclusion,status}]']));
  if (!runs.some((r) => r.name === 'Verify' && r.conclusion === 'success')) fails.push(`no successful Verify run for ${sha}`);
  const checks = JSON.parse(sh('gh', ['api', `repos/${repo}/commits/${sha}/check-runs?per_page=100`, '--jq', '[.check_runs[]|{name,conclusion}]']));
  if (!checks.some((c) => c.name === 'Workers Builds: cpay' && c.conclusion === 'success')) fails.push(`site deploy (Workers Builds: cpay) not successful for ${sha}: deployed SHA != verified SHA`);
  const drill = drillProblem(readFileSync('docs/BACKUP-RECOVERY.md', 'utf8'), Number(opt('--drill-max-days', 90)));
  if (drill) fails.push(drill);
  const blockersDoc = readFileSync('docs/RELEASE-BLOCKERS.md', 'utf8');
  const blockers = openBlockers(blockersDoc);
  if (blockers.length) fails.push(`${blockers.length} open Critical/High item(s) in docs/RELEASE-BLOCKERS.md`);
  const ownerBlockers = pendingOwnerBlockers(blockersDoc);
  if (ownerBlockers.length) fails.push(`${ownerBlockers.length} unresolved Medium owner item(s): close or record explicit owner acceptance (date + evidence link) in docs/RELEASE-BLOCKERS.md`);
  if (argv.includes('--skip-legal')) {
    // Diagnostics only: bypassing this check must never yield RELEASE GATE PASSED.
    fails.push('legal publication check skipped (--skip-legal is diagnostics only; production release refused)');
  } else {
    try { sh('python3', ['ci/check_legal.py', '--release']); } catch { fails.push('legal pages not published: fill every legal field and turn on Publish in Admin → Settings (ci/check_legal.py --release)'); }
  }
  console.log(`checked: sha=origin/main, clean worktree, Verify, Workers Builds: cpay, restore drill, blockers${argv.includes('--skip-legal') ? '' : ', legal'}`);
  console.log(fails.length ? `RELEASE REFUSED for ${sha}:\n- ${fails.join('\n- ')}` : `RELEASE GATE PASSED for ${sha}`);
  return fails.length ? 1 : 0;
}

// Any failed command (git, gh, a missing file) refuses the release with a
// reason instead of a bare stack trace; it can never fall through to exit 0.
function run(argv) {
  try { return main(argv); } catch (e) {
    console.log(`RELEASE REFUSED: ${String(e.message || e).split('\n')[0]}`);
    return 1;
  }
}

// Compare real filesystem paths, not a hand-built file:// string: a checkout
// path with a space (URL-encoded in import.meta.url) or a symlink would never
// match, main() would not run, and the gate would exit 0 with no output.
export function isEntrypoint(metaUrl, argv1) {
  if (!argv1) return false;
  const real = (p) => { try { return realpathSync(p); } catch { return p; } };
  return real(fileURLToPath(metaUrl)) === real(argv1);
}

if (isEntrypoint(import.meta.url, process.argv[1])) process.exit(run(process.argv.slice(2)));
