# Manual deploys (SQL Editor and Termux)

How to put a reviewed commit into production by hand, without the Supabase
CLI: migrations in the Supabase SQL Editor, Edge Functions from a phone with
Termux (or any shell with `bash`, `git` and `curl`). Use this when the
automated paths are not available. The log at the end records every deploy
done this way.

**বাংলায় সংক্ষেপে:** আগে migration (SQL Editor), তারপর function (Termux),
তারপর PR merge। প্রতিটি ধাপের পরে যাচাই করুন। Token কখনো chat, file বা
screenshot-এ রাখবেন না।

## Order

1. **Migration first.** Functions in a commit may write columns the
   migration adds (create-invoice writes `customer_region` since
   20261020090000); deployed first, every new invoice would fail.
2. **Functions next**, from the same commit.
3. **Merge the PR last.** Merging deploys the site and the Worker
   (Cloudflare Workers Builds), and the new pages may call the new RPCs.
4. **Verify** after each step (below).

## 1. Migration in the SQL Editor

Build the paste-ready SQL from the migration file:

```bash
bash scripts/sql-editor-migration.sh supabase/migrations/<version>_<name>.sql > run.sql
```

Open Supabase Dashboard → SQL Editor → New query, paste all of `run.sql`,
press **Run**. It is wrapped in `begin; … commit;`, so an error changes
nothing and the migration can be run again. The last statement records the
migration in `supabase_migrations.schema_migrations`, which the SQL Editor
does not do by itself; without it the history (and `list_migrations`, the
drift checks) would miss the migration.

The script refuses a migration that manages its own transaction or uses
`CONCURRENTLY`; run such a file on its own and record it by hand.

Check afterwards:

```sql
select version, name from supabase_migrations.schema_migrations
 order by version desc limit 3;
```

and the objects the migration creates (columns, tables, RLS, grants), e.g.
for 20261020090000:

```sql
select has_function_privilege('anon', 'public.admin_locations(text,text,integer,integer)', 'execute');  -- false
select relrowsecurity from pg_class where oid = 'public.profile_locations'::regclass;              -- true
```

## 2. Edge Functions from Termux

One-time setup in Termux:

```bash
pkg install -y git curl coreutils
git clone https://github.com/parvezmosharafvu/cpay ~/cpay   # sign in to GitHub if asked
```

Each deploy:

```bash
cd ~/cpay && git checkout -q main && git pull -q
bash scripts/termux-deploy-function.sh <commit> <function> [function...]
# e.g. bash scripts/termux-deploy-function.sh 99903b5 create-invoice direct-invoice
```

What the script does (`scripts/termux-deploy-function.sh`):

- refuses a dirty clone, checks out `<commit>` detached, and returns to
  `main` at the end;
- sends the function's `index.ts` plus every file it imports by relative path
  (`../_shared/...` included), named `functions/<path>`, entrypoint
  `functions/<name>/index.ts`: the same layout `supabase functions deploy`
  uses, so downloads and drift checks compare like for like;
- takes `verify_jwt` from `supabase/config.toml` and refuses a function that
  is not listed there (the default `true` would break the public endpoints);
- asks for the token on the keyboard (Supabase → Account → Access Tokens,
  **Copy** button, starts with `sbp_`), clears the screen, and unsets it.

Each reply must show `"status":"ACTIVE"` and a version one higher than
before. Then compare the deployed files with the commit (Supabase MCP
`get_edge_function`, or Dashboard → Edge Functions → the function → Code).

### The wallet function

The wallet Edge Function is too large for the Git integration (`enabled =
false` in `config.toml`) and is deployed with its own folder as the root and
entrypoint `index.ts`, so it has its own script:

```bash
bash scripts/termux-deploy-wallet.sh <commit>
```

With the Supabase CLI, use the CLI deploy script for the wallet function in
`scripts/` instead. `termux-deploy-function.sh` refuses the wallet function.

## Token safety

- A token pasted into a chat, issue, file or screenshot is exposed: revoke it
  (Supabase → Account → Access Tokens) and make a new one.
- Use the **Copy** button. A truncated token (fewer than 44 characters) is
  refused by the script.
- Prefer a token you revoke after the deploy.

## Log

| Date (UTC) | What | How | Result |
|---|---|---|---|
| 2026-10-20 | wallet function | Termux, the request `scripts/termux-deploy-wallet.sh` now makes (folder root, entrypoint `index.ts`) | v29 ACTIVE, files verified against main |
| 2026-10-20 | migration 20261020080000_auto_receive (PR #147) | Supabase MCP `apply_migration` | recorded in schema_migrations |
| 2026-10-20 | migration 20261020090000_locations (PR #143, commit 99903b5) | SQL Editor, `scripts/sql-editor-migration.sh` output (one transaction + history row) | recorded; columns, RLS, grants and functions verified |
| 2026-10-20 | create-invoice | Termux, same request as `scripts/termux-deploy-function.sh` (6 files, verify_jwt false) | v58 ACTIVE |
| 2026-10-20 | direct-invoice | Termux, same request (12 files, verify_jwt false) | v7 ACTIVE, all 12 files byte-identical to 99903b5 |
| 2026-10-20 | PR #143 merged after the steps above | GitHub | site and Worker deployed by Cloudflare Workers Builds |
