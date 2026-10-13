#!/usr/bin/env node
// CPAY release gate. Refuses a production release unless:
//   1. the SHA is the current origin/main and the worktree is clean
//   2. the Verify workflow has a successful run for that exact SHA
//   3. "Workers Builds: cpay" (the site deploy) succeeded for that SHA, so
//      the deployed site SHA equals the verified SHA
//   4. the latest restore drill in docs/BACKUP-RECOVERY.md passed and is
//      younger than --drill-max-days (default 90)
//   5. docs/RELEASE-BLOCKERS.md lists no open Critical/High item
//   6. legal pages carry no DRAFT/placeholder text (ci/check_legal.py --release)
// Read-only: it never deploys anything. Usage:
//   node scripts/release-gate.mjs [--sha <sha>] [--drill-max-days 90] [--skip-legal]
// Exit 0 = GO for this SHA, 1 = refused (reasons printed).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export function latestDrill(md) {
  const rows = md.split('\n').filter((l) => /^\|\s*\d{4}-\d{2}-\d{2}/.test(l));
  let best = null;
  for (const r of rows) {
    const date = r.match(/^\|\s*(\d{4}-\d{2}-\d{2})/)[1];
    const pass = /\*\*Pass\.?\*\*|\|\s*Pass\b/i.test(r);
    if (!best || date > best.date) best = { date, pass };
  }
  return best;
}

export function openBlockers(md) {
  return md.split('\n').filter((l) => /^\|/.test(l) && /\|\s*(Critical|High)\s*\|/i.test(l) && /\|\s*open\s*\|/i.test(l));
}

export function drillProblem(md, maxDays, nowMs = Date.now()) {
  const d = latestDrill(md);
  if (!d) return 'no restore drill recorded in docs/BACKUP-RECOVERY.md';
  if (!d.pass) return `latest restore drill (${d.date}) did not pass`;
  const age = Math.floor((nowMs - Date.parse(`${d.date}T00:00:00+06:00`)) / 86400000);
  if (age > maxDays) return `latest restore drill is ${age} days old (max ${maxDays})`;
  return null;
}

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function main(argv) {
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
  const blockers = openBlockers(readFileSync('docs/RELEASE-BLOCKERS.md', 'utf8'));
  if (blockers.length) fails.push(`${blockers.length} open Critical/High item(s) in docs/RELEASE-BLOCKERS.md`);
  if (!argv.includes('--skip-legal')) {
    try { sh('python3', ['ci/check_legal.py', '--release']); } catch { fails.push('legal pages still contain DRAFT/placeholder text'); }
  }
  console.log(fails.length ? `RELEASE REFUSED for ${sha}:\n- ${fails.join('\n- ')}` : `RELEASE GATE PASSED for ${sha}`);
  return fails.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
