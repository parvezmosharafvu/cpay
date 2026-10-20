#!/usr/bin/env bash
# Deploy breez-wallet from Termux (or any shell) without the Supabase CLI, the
# way v29 was deployed on 2026-10-20 (docs/MANUAL-DEPLOY.md). It is too large
# for the Git integration (enabled = false in config.toml) and is deployed
# with its own folder as the root and entrypoint index.ts. With the CLI use
# scripts/deploy-breez-wallet.sh instead.
#
#   bash scripts/termux-deploy-wallet.sh <commit>
set -euo pipefail
PROJECT_REF="${CPAY_PROJECT_REF:-riumaeihemgznvgattoc}"
commit="${1:?usage: termux-deploy-wallet.sh <commit>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "refused: uncommitted changes in $root" >&2; exit 1; }
git fetch -q origin
git checkout -q --detach "$commit"
trap 'git -C "$root" checkout -q main 2>/dev/null || true' EXIT
echo "commit $(git rev-parse --short HEAD): $(git log -1 --format=%s)"
cd supabase/functions/breez-wallet

read -r -p "Supabase token (sbp_...): " T
clear || true
case "$T" in sbp_*) ;; *) echo "The token must start with sbp_. Copy it again with the Copy button." >&2; exit 1 ;; esac
[ "${#T}" -ge 44 ] || { echo "Token too short (${#T} characters). Copy it again with the Copy button." >&2; unset T; exit 1; }

args=()
while IFS= read -r f; do args+=(-F "file=@$f;filename=$f"); done < <(find . -type f \( -name '*.ts' -o -name '*.mjs' \) ! -name '*_test.ts' ! -name '*.test.*' | sed 's|^\./||' | sort)
n=$(( ${#args[@]} / 2 ))  # two array entries (-F and its value) per file
echo "$n files"
[ "$n" -ge 15 ] && [ "$n" -le 40 ] || { echo "refused: unexpected file count, stopping" >&2; unset T; exit 1; }
curl -sS --fail-with-body -X POST "https://api.supabase.com/v1/projects/$PROJECT_REF/functions/deploy?slug=breez-wallet" \
  -H "Authorization: Bearer $T" \
  -F 'metadata={"name":"breez-wallet","entrypoint_path":"index.ts","verify_jwt":false};type=application/json' \
  "${args[@]}"
echo
unset T
echo "Done. The reply should show \"status\":\"ACTIVE\" and a new \"version\"."
