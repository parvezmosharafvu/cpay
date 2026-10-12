#!/usr/bin/env bash
# Deploy breez-wallet by hand. config.toml has enabled=false so the GitHub
# integration / Preview skip it (413: bundle too large for that path); the CLI
# skips disabled functions too, so deploy from a temp copy with it enabled.
set -euo pipefail
ref="${1:?usage: deploy-breez-wallet.sh <project-ref>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/supabase/functions"
cp -r "$root/supabase/functions/breez-wallet" "$tmp/supabase/functions/"
printf 'project_id = "%s"\n[functions.breez-wallet]\nverify_jwt = false\n' "$ref" > "$tmp/supabase/config.toml"
cd "$tmp" && supabase functions deploy breez-wallet --no-verify-jwt --project-ref "$ref"
