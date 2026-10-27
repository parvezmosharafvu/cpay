# Blink sweep

When BTCPay's Lightning backend is the **Blink plugin (USD wallet)**, a
payer's Lightning payment lands in the owner's **Blink USD wallet**, not in
the CPAY wallet. CPAY still credits the user and Auto withdraw pays from
the CPAY wallet ([BTCPAY.md](BTCPAY.md)), so that float runs down. The
Blink sweep moves the Blink USD balance into the **primary CPAY wallet**
automatically. It is **off by default**.

Migration: `20261027010000_blink_sweep.sql`. Function: `blink-sweep`
(rules in `handler.ts`, tested by `handler_test.ts`). Blink client:
`supabase/functions/_shared/blink.ts`.

## How it works

pg_cron calls `blink-sweep` every 10 minutes (`x-cron-secret`). Each run:

1. **A move still in flight** (`sending` or `pending`) is finished first by
   paying its stored invoice again. Blink answers `ALREADY_PAID` for a paid
   invoice, so this can never pay twice. Nothing new starts while one is
   open. A move still pending an hour after its invoice expired is closed
   as `unknown` with a Telegram alert, so check it in Blink.
2. Nothing happens when the sweep is off, `BLINK_API_KEY` is not set, or
   the primary CPAY wallet has no Lightning address.
3. **Amount** = Blink USD balance − *USD to leave in Blink*, capped at
   *largest move each time*. Below *smallest move* nothing happens.
4. Blink's own price turns the USD into sats; CPAY asks for **98%** of that
   (room for price moves and Blink's fee).
5. The invoice comes from the **primary CPAY wallet's own Lightning
   address** (for example `cpay@breez.tips`), read from the wallet's data
   in the database. Nobody can type a destination. The invoice is checked
   (Bitcoin network, exact amount, description hash, enough time left),
   recorded in `blink_sweeps`, then paid from the Blink USD wallet with
   `lnInvoicePaymentSend`.
6. Telegram gets an alert for each move that arrives, fails or needs a
   check.

The payment shows up in the CPAY wallet as a receive with no CPAY payment
attached, so the receipt review may list it. Match it by the time and
amount in Admin → Settings → Blink sweep.

## Settings (Admin → Settings → Blink sweep)

| Setting | Default | |
|---|---|---|
| `blink_sweep_enabled` | Off | ⚠ asks to confirm, audited |
| `blink_sweep_keep_usd` | 0 | USD left in Blink |
| `blink_sweep_min_usd` | 5 | smaller balances wait |
| `blink_sweep_max_usd` | 200 | ⚠ the most moved in one run |

The same page shows where the next move goes and the last 20 moves
(`admin_blink_sweeps`, admins only). Invoices and Blink wallet ids are
never sent to the page.

## Secrets (names only)

| Name | What |
|---|---|
| `BLINK_API_KEY` | Blink API key with **Read** and **Write** (dashboard.blink.sv → API Keys). Make a separate key for this; keep the BTCPay plugin's own key as it is. |
| `BLINK_SWEEP_CRON_SECRET` | optional; otherwise `CRON_SECRET`, which pg_cron sends from Vault (`cpay_cron_secret`) |
| `BLINK_API_URL` | optional, only `https://api.blink.sv/graphql` or `https://api.staging.blink.sv/graphql` |

`BLINK_API_KEY` can be set from Admin → Secrets & keys. A Write key can
spend the Blink balance, but this function only pays invoices from the
CPAY wallet's own address.

## Turn it on

1. Merge, then apply the migration and deploy `blink-sweep`
   (`supabase functions deploy blink-sweep`). The migration schedules the
   `blink-sweep` cron job when pg_cron and the Vault secrets exist.
2. Set `BLINK_API_KEY`.
3. Check Admin → Settings → Blink sweep shows the destination (the primary
   CPAY wallet's Lightning address).
4. Set *smallest move* low (for example 1) and turn the sweep **On**. After
   the next run, check the move in the log, in Blink, and in the CPAY
   wallet balance. Then set the limits you want.

Turning it **Off** stops new moves. A move already in flight is left as
it is until it is turned back on.

## Not covered

- **On-chain BTCPay payments** stay in BTCPay's on-chain wallet. Move them
  yourself.
- The Blink **BTC** wallet is not swept, only the USD wallet.
- The sweep only adds to the CPAY wallet; it never sends from it.
