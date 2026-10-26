# Multiple platform wallets

Status: in PR (feature/multi-wallet). Migration `20261021040000_multi_wallet.sql`.

## Model

- Registry: table `wallets` in the wallet schema (id, label, network,
  status `active|standby|disabled|removed`, is_primary, is_legacy,
  seed_secret_id, fingerprint, node_pubkey, created_at, created_by).
  RLS on, no policies, no privileges for anon/authenticated; the schema is
  not exposed to the API.
- **Wallet #1 (legacy)**: fixed id `00000000-0000-0000-0000-000000000001`,
  seed still in the Edge secret `BREEZ_MNEMONIC`, SDK storage in the
  original wallet schema, original advisory-lock key. It is primary after
  the migration, so nothing changes until the owner adds a wallet.
- **Other wallets**: seed in Supabase Vault (`vault.create_secret`); the
  registry stores only the Vault secret id. SDK storage in its own schema
  (`<wallet schema>_w_<id hex>`), created at add time with no
  anon/authenticated privileges.
- `wallet_status` (balance, last sync, last error) is written by the wallet
  function after each sync; `wallet_audit` records every change (label,
  status, fingerprint, counts; never a seed).

## Routing rule

1. Every signed request to the wallet function (`/invoices`, `/withdraw/*`,
   `/admin/wallet/*`) is served by the **primary** wallet. New invoices,
   forwards and withdrawals therefore all use the primary.
2. The one-minute cron syncs the primary in full (catch-up, expiry,
   withdrawal reconcile, forwards), then each other **active** wallet
   **receive-only**: payments to invoices it made while it was primary
   settle (matched by payment hash, idempotent), and its balance is
   recorded. A receive-only wallet never sends.
3. `standby` and `disabled` wallets are never opened.
4. If the primary cannot pay (for example its balance is low), forwards stay
   held/owed and retry as before; the owner moves funds or changes the
   primary. Funds on a non-primary wallet are moved with its **Withdraw**
   button (Admin → Wallet → Wallets): it becomes primary while the owner
   uses Send / Withdraw stablecoin, and "Switch back" restores the previous
   primary (remembered while the page stays open). Or with the wallet's own app.
5. Admin sends keep money owed to creators: the reserve is what is owed
   minus the last synced balance of every other active wallet (synced in
   the last 15 minutes), so a small wallet can be emptied while the others
   still cover what is owed (`otherWalletsSat` in `core/wallet.mjs`).

`wallet_id` is recorded on `payments` (when the invoice is attached),
`payment_forwards` and `withdrawals` (when they start sending), by a
trigger reading the per-connection setting `cpay.wallet_id` that each
wallet's database pool sets. NULL on older rows means wallet #1.

## Single instance per wallet

The lease (session advisory lock), the "want" signal and the `lease_log`
row include the wallet id; wallet #1 keeps the original key so an old and a
new deploy still exclude each other. Two different wallets may be open at
once; the same wallet never is. Each SDK build runs in its own pool scope
so closing one wallet never ends another wallet's database pool.

## Owner operations (`wallet-registry` Edge Function)

Owner only (`CPAY_OWNER_USER_ID`), active admin, passkey session; add and
remove also need a passkey sign-in in the last 10 minutes. Actions: list,
add, rename, set_primary, set_status, remove. The database functions
(`public.wallet_registry_*`) are executable by service_role only.

Add: the seed is checked in the browser and again on the server (12 BIP39
English words, checksum), fingerprinted (BIP32 master fingerprint), and
passed once to `wallet_registry_add`, which stores it in Vault. Adds are
limited to 5 attempts per hour per owner (failures count). Duplicate
fingerprints are refused; a duplicate node key found at first sync
disables the newer entry.

Remove: typed label + passkey. Refused for the primary, wallet #1, an
unknown or stale (over 15 minutes) or non-zero balance, open invoices,
forwards or withdrawals in progress. The Vault secret is deleted and the
row kept as `removed`.

## Security notes

- The seed is never in a plain column, a response, an error, a log line or
  the audit. Database errors are mapped to fixed codes. The browser clears
  the field on submit and never stores it.
- Only the wallet function's own database role can execute the seed reader
  (`wallet_seed(id)` in the unexposed wallet schema); anon, authenticated
  and service_role cannot.
- The wallet function adds each loaded seed to its log redactor.
- Anyone with database owner or project management access can read Vault
  secrets, the same trust level as the Edge secret used for wallet #1.
- All wallets share `BREEZ_API_KEY`.

## Deploy order

1. Migration `20261021040000_multi_wallet.sql`.
2. `supabase functions deploy wallet-registry`.
3. Wallet function, only with the wallet deploy script in `scripts/`.
4. Site (Cloudflare Workers Builds from `main`).

The new wallet function works before the migration (it falls back to the
single wallet), and the migration alone changes no behaviour.
