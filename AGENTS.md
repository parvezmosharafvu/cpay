# AGENTS.md — onboarding for AI agents and new contributors

Read [docs/SYSTEM-OVERVIEW.md](docs/SYSTEM-OVERVIEW.md) first. It is the
current truth; documents marked "Historical document" are not.
Owner's Bangla guide (accounts, setup, settings, secrets, APIs):
[docs/SYSTEM-GUIDE-BN.md](docs/SYSTEM-GUIDE-BN.md), shown in Admin → System guide to the
owner only (`owner-guide` function, `CPAY_OWNER_USER_ID`, passkey session). After editing
it run `node scripts/build-admin-guide.mjs` (CI checks the generated
`supabase/functions/owner-guide/guide.ts` is in sync) and redeploy `owner-guide`.

## Map

- `public/` static site (vanilla JS + Supabase JS, no build). Checkout:
  `404.html` + `invoice-view.js`. Desk: `dashboard.html` + `freelancer-desk.js`.
  Admin: `admin.html` + `admin-*.js`. Strings: `i18n.js` (English + Bangla).
- `supabase/migrations/` schema, RLS, RPCs (append-only).
- `supabase/functions/` Deno Edge Functions; `_shared/` common code.
  Wallets: `wallet-registry` (owner) + `admin-wallets.js` (Admin → Wallet).
- `worker/` Cloudflare link-preview Worker. `wallet/` CPay Wallet PWA.
- `payment-service/` self-hosted Node fallback (not deployed, tested in CI).
- `ci/` SQL suites and Python checks; `tests/` node/Playwright tests;
  `scripts/` deploy and release tools.

## Key flows (details in SYSTEM-OVERVIEW)

Pay link (USD) → BOLT11 → settle → platform fee first →
`payment_mode_for(user)`: Auto withdraw ON = instant forward to saved
Lightning/USDT address (held/owed retried); OFF = custodial balance + manual
Withdraw page (passkey confirm). One "You receive X" figure.

## Invariants — never break these

- No change to fees, `platform_fee_amount`, forwarding or settlement without
  an explicit owner request. Amounts are computed server-side.
- Only an admin may reverse a settled payment.
- Admin/settings/withdraw/address change require `strong_session()` (passkey).
- Auth = email+password (verified) + passkeys. No Google, no new TOTP.
- Locations: headers only, display-only, no GPS/IP; visible to link owner
  (own payments) and admins only.
- Wallet function: single instance PER WALLET (advisory lease keyed by
  wallet id; wallet #1 keeps the original key); deploy only via the wallet
  deploy script in `scripts/`; never edit its lease logic casually.
  `RECEIPT_RECORDING` stays off. Only the primary wallet sends; other
  wallets are receive-only ([docs/MULTI-WALLET.md](docs/MULTI-WALLET.md)).
- Wallet seeds: wallet #1 in the Edge secret, all others in Supabase Vault
  (registry keeps only the secret id). Never return, log, echo or audit a
  seed; wallet registry RPCs are service_role only, called by the
  owner-only `wallet-registry` function.
- Every new `SECURITY DEFINER` function: `set search_path`, explicit
  revoke/grant, and an entry in `ci/authenticated_rpc_allowlist.sql` /
  `ci/anon_rpc_allowlist.sql` if callable.
- Public pages and `docs/` must not name traditional payment methods or the
  wallet provider brand; say "the wallet" / "our payment provider"
  (`ci/check_public_copy.py`).
- No reseller/commission features. Never commit secrets, keys or tokens.

## Deploy order

1. Migration (new file, sorts after every migration on main; never edit old ones).
2. Edge Functions (`supabase functions deploy <name>`; wallet via the script).
3. Site (Cloudflare Workers Builds from `main`).

## Tests and checks (all run in `.github/workflows/verify.yml`)

```
python3 ci/check_public_copy.py
python3 ci/check_legal.py            # --release also requires filled legal fields
python3 ci/check_frontend.py
python3 ci/check_workflows.py
python3 ci/check_md_links.py
node --test tests/frontend/*.test.mjs
deno test supabase/functions/_shared/ supabase/functions/create-invoice/
(cd payment-service && npm ci && npm test)
```
SQL suites in `ci/*.sql` run against a fresh Postgres after all migrations.

## PR workflow

- One topic per PR, from a new branch; CI must be green; merge commit (no
  squash of history needed); never force-push or push to `main` directly.
- Do not merge or deploy without the owner's go.

## Do / Don't

- Do update `docs/SYSTEM-OVERVIEW.md` and this file when behaviour changes.
- Do add Bangla for every new UI string in `public/i18n.js`.
- Don't edit files in `supabase/migrations/` that are already on main.
- Don't change production settings, data or Supabase/Cloudflare config from a PR.
