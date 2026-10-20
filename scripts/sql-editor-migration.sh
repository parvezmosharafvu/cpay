#!/usr/bin/env bash
# Wrap one migration for the Supabase SQL Editor, the way
# 20261020090000_locations was applied on 2026-10-20 (docs/MANUAL-DEPLOY.md).
#
#   bash scripts/sql-editor-migration.sh supabase/migrations/20261020090000_locations.sql > run.sql
#
# Paste the output into Dashboard → SQL Editor → New query → Run. It is one
# transaction: an error changes nothing. The last statement records the
# migration in supabase_migrations.schema_migrations (as `supabase db push`
# and the MCP apply_migration do), so the history and the drift checks stay
# right. Migrations that manage their own transaction are refused.
set -euo pipefail
file="${1:?usage: sql-editor-migration.sh supabase/migrations/<version>_<name>.sql}"
[ -f "$file" ] || { echo "no such file: $file" >&2; exit 1; }
base="$(basename "$file" .sql)"
version="${base%%_*}"
name="${base#*_}"
[[ "$version" =~ ^[0-9]{14}$ ]] || { echo "refused: $base does not start with a 14-digit version" >&2; exit 1; }
if grep -qiE '^[[:space:]]*(begin|commit|rollback)[[:space:]]*;|concurrently' "$file"; then
  echo "refused: $file manages its own transaction or uses CONCURRENTLY; run it on its own" >&2
  exit 1
fi
echo "-- $base: paste all of this into Supabase SQL Editor and Run."
echo "begin;"
cat "$file"
echo
echo "-- Record it in the migration history."
echo "insert into supabase_migrations.schema_migrations (version, name)"
echo "values ('$version', '$name') on conflict (version) do nothing;"
echo "commit;"
