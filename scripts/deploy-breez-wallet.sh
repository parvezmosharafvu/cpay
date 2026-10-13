#!/usr/bin/env bash
# Deploy breez-wallet by hand. config.toml has enabled=false so the GitHub
# integration / Preview skip it (413: bundle too large for that path); the CLI
# skips disabled functions too, so deploy from a temp copy with it enabled.
set -euo pipefail
ref="${1:?usage: deploy-breez-wallet.sh <project-ref>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
# Deployed SHA must equal a verified SHA: clean worktree at origin/main with a
# successful Verify run. CPAY_DEPLOY_OVERRIDE=1 is for a documented rollback only.
if [ "${CPAY_DEPLOY_OVERRIDE:-}" != "1" ]; then
  git -C "$root" fetch -q origin main
  sha="$(git -C "$root" rev-parse HEAD)"
  [ "$sha" = "$(git -C "$root" rev-parse origin/main)" ] || { echo "refused: HEAD $sha is not origin/main" >&2; exit 1; }
  [ -z "$(git -C "$root" status --porcelain --untracked-files=no -- supabase/functions/breez-wallet)" ] || { echo "refused: uncommitted changes in breez-wallet" >&2; exit 1; }
  ok="$(cd "$root" && gh api "repos/{owner}/{repo}/actions/runs?head_sha=$sha" --jq '[.workflow_runs[]|select(.name=="Verify" and .conclusion=="success")]|length')"
  [ "${ok:-0}" -gt 0 ] || { echo "refused: no successful Verify run for $sha" >&2; exit 1; }
  echo "deploying breez-wallet at verified SHA $sha"
else
  echo "WARNING: CPAY_DEPLOY_OVERRIDE=1, deploying $(git -C "$root" rev-parse HEAD) without the verified-SHA check" >&2
fi
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/supabase/functions"
cp -r "$root/supabase/functions/breez-wallet" "$tmp/supabase/functions/"
printf 'project_id = "%s"\n[functions.breez-wallet]\nverify_jwt = false\n' "$ref" > "$tmp/supabase/config.toml"
cd "$tmp" && supabase functions deploy breez-wallet --no-verify-jwt --project-ref "$ref"
