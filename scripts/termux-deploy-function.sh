#!/usr/bin/env bash
# Deploy Edge Functions from a phone (Termux) or any shell without the
# Supabase CLI: plain curl to the Management API, the way create-invoice v58
# and direct-invoice v7 were deployed on 2026-10-20 (docs/MANUAL-DEPLOY.md).
#
#   bash scripts/termux-deploy-function.sh <commit> <function> [function...]
#   e.g. bash scripts/termux-deploy-function.sh 99903b5 create-invoice direct-invoice
#
# - Checks out <commit> (detached) in a clean clone, so what is deployed is
#   exactly a reviewed commit. Goes back to main at the end.
# - Uploads the function's index.ts and every file it imports by relative
#   path (../_shared/... included), named "functions/<path>" with entrypoint
#   "functions/<name>/index.ts": the same layout `supabase functions deploy`
#   produces, so `supabase functions download` and the drift checks compare.
# - verify_jwt comes from supabase/config.toml; a function missing there is
#   refused (the default would be true and break public endpoints).
# - The token (Supabase → Account → Access Tokens, starts with sbp_) is read
#   from the keyboard, never from an argument or a file, and unset at the end.
#
# Order: apply the commit's migrations first (docs/MANUAL-DEPLOY.md, part 1)
# whenever the functions write new columns.
set -euo pipefail

PROJECT_REF="${CPAY_PROJECT_REF:-riumaeihemgznvgattoc}"
commit="${1:?usage: termux-deploy-function.sh <commit> <function> [function...]}"
shift
[ "$#" -gt 0 ] || { echo "usage: termux-deploy-function.sh <commit> <function> [function...]" >&2; exit 2; }

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "refused: uncommitted changes in $root" >&2; exit 1; }
git fetch -q origin
git checkout -q --detach "$commit"
trap 'git -C "$root" checkout -q main 2>/dev/null || true' EXIT
echo "commit $(git rev-parse --short HEAD): $(git log -1 --format=%s)"

# verify_jwt for one function from supabase/config.toml, or empty.
verify_jwt() {
  awk -v want="[functions.$1]" '
    $0 == want { inside = 1; next }
    /^\[/ { inside = 0 }
    inside && $1 == "verify_jwt" { gsub(/[ "]/, "", $3); print $3; exit }
  ' supabase/config.toml
}

# index.ts plus everything it imports by a relative path, as paths under supabase/.
closure() {
  local queue=("functions/$1/index.ts") seen="" f dir dep
  while [ "${#queue[@]}" -gt 0 ]; do
    f="${queue[0]}"; queue=("${queue[@]:1}")
    case " $seen " in *" $f "*) continue ;; esac
    [ -f "supabase/$f" ] || { echo "missing supabase/$f" >&2; return 1; }
    seen="$seen $f"
    dir="$(dirname "$f")"
    while IFS= read -r dep; do
      [ -n "$dep" ] || continue
      queue+=("$(realpath -m --relative-to=supabase "supabase/$dir/$dep")")
    done < <(grep -oE "(from|import)[[:space:]]*[\"']\.\.?/[^\"']+[\"']" "supabase/$f" | sed -E "s/^(from|import)[[:space:]]*[\"']//; s/[\"']$//")
  done
  printf '%s\n' $seen
}

for name in "$@"; do
  # breez-wallet is deployed with its own folder as the root (entrypoint
  # index.ts); see docs/MANUAL-DEPLOY.md and scripts/deploy-breez-wallet.sh.
  [ "$name" != "breez-wallet" ] || { echo "refused: breez-wallet has its own procedure (docs/MANUAL-DEPLOY.md)" >&2; exit 1; }
  [ -f "supabase/functions/$name/index.ts" ] || { echo "refused: no supabase/functions/$name/index.ts" >&2; exit 1; }
  jwt="$(verify_jwt "$name")"
  [ "$jwt" = "true" ] || [ "$jwt" = "false" ] || { echo "refused: no verify_jwt for $name in supabase/config.toml" >&2; exit 1; }
done

read -r -p "Supabase token (sbp_...): " T
clear || true
case "$T" in sbp_*) ;; *) echo "The token must start with sbp_. Copy it again with the Copy button." >&2; exit 1 ;; esac
[ "${#T}" -ge 44 ] || { echo "Token too short (${#T} characters). Copy it again with the Copy button." >&2; unset T; exit 1; }

cd supabase
for name in "$@"; do
  jwt="$(verify_jwt "$name")"
  mapfile -t files < <(closure "$name")
  args=()
  for f in "${files[@]}"; do args+=(-F "file=@$f;filename=$f"); done
  echo "== $name: ${#files[@]} files, verify_jwt=$jwt"
  printf '   %s\n' "${files[@]}"
  curl -sS --fail-with-body -X POST "https://api.supabase.com/v1/projects/$PROJECT_REF/functions/deploy?slug=$name" \
    -H "Authorization: Bearer $T" \
    -F "metadata={\"name\":\"$name\",\"entrypoint_path\":\"functions/$name/index.ts\",\"verify_jwt\":$jwt};type=application/json" \
    "${args[@]}"
  echo
done
unset T
echo "Done. Each reply should show \"status\":\"ACTIVE\" and a new \"version\"."
