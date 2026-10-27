# Blink sweep

When BTCPay's Lightning backend is the **Blink plugin (USD wallet)**, a
payer's Lightning payment lands in the owner's **Blink USD wallet**, not in
the CPAY wallet. CPAY still credits the user and Auto withdraw pays from
the CPAY wallet ([BTCPAY.md](BTCPAY.md)), so that float runs down. The
Blink sweep moves the Blink USD balance into the **primary CPAY wallet**
automatically. It is **off by default**.

Each Blink account has its own daily withdrawal limit (for example $999 in
24 hours), so the sweep can use **up to 10 Blink accounts**, one API key
each, and moves each account separately. With **overflow** on, an account
that reaches its limit hands its USD to another of the accounts, so
BTCPay can keep paying into one account.

Migrations: `20261027010000_blink_sweep.sql`,
`20261027020000_blink_sweep_accounts.sql`, `20261027030000_blink_overflow.sql`. Function: `blink-sweep`
(rules in `handler.ts`, tested by `handler_test.ts`). Blink client:
`supabase/functions/_shared/blink.ts`.

## How it works

pg_cron calls `blink-sweep` every 10 minutes (`x-cron-secret`). Each run
goes through every configured account (`BLINK_API_KEY`, then
`BLINK_API_KEY_2` … `_10`) in turn; one account failing never stops the
others. For each account:

1. **A move of that account still in flight** (`sending` or `pending`) is finished first by
   paying its stored invoice again. Blink answers `ALREADY_PAID` for a paid
   invoice, so this can never pay twice. Nothing new starts for that
   account while one is open. A move still pending an hour after its invoice expired is closed
   as `unknown` with a Telegram alert, so check it in Blink.
2. The account is read: USD balance, whether the key can send (Blink's
   `WRITE` scope) and how much Blink still lets it withdraw in its rolling
   24 hours. This is shown in Admin → Settings → Blink sweep, also while the
   sweep is off. Nothing more happens when the sweep is off, the primary
   CPAY wallet has no Lightning address, or the key has no `WRITE`.
3. **Amount** = Blink USD balance − *USD to leave in Blink*, capped at
   *largest move each time* and at Blink's withdrawal limit left for that
   account. Below *smallest move* nothing happens.
4. Blink's own price turns the USD into sats; CPAY asks for **98%** of that
   (room for price moves and Blink's fee).
5. The invoice comes from the **primary CPAY wallet's own Lightning
   address** (for example `cpay@your-wallet-provider`), read from the wallet's data
   in the database. Nobody can type a destination. The invoice is checked
   (Bitcoin network, exact amount, description hash, enough time left),
   recorded in `blink_sweeps`, then paid from the Blink USD wallet with
   `lnInvoicePaymentSend`.
6. Telegram gets an alert for each move that arrives, fails or needs a
   check.

## Overflow (one BTCPay account, several Blink limits)

BTCPay pays into one Blink account only. When that account hits Blink's
withdrawal limit, its balance would wait for the next day. With
`blink_sweep_overflow_enabled` **On** (and two or more keys), each run
after the moves above:

1. Takes every account whose move was stopped by Blink's withdrawal limit
   ("Blink daily limit reached").
2. Picks the account with the most **room**: Blink withdrawal limit left
   minus the USD it already holds (and minus what this run already gave
   it). It must have a Write key and not be limited itself.
3. Sends USD → USD inside Blink (`intraLedgerUsdPaymentSend`): the
   account's balance less *USD to leave*, capped at *largest move*, the
   room, and Blink's own Blink-to-Blink limit (`internalSend`, separate
   from the withdrawal limit). Below *smallest move* nothing is sent.
4. The receiving account moves it to the CPAY wallet on its next run (10
   minutes later), within its own limit.

At most one transfer per account per run, and the database refuses a
second transfer from the same account within 5 minutes, so overlapping
runs cannot both send. Each transfer is recorded in `blink_overflows`
before it is sent. A transfer has no invoice, so a timeout is **never
retried**: it is closed as `unknown` with a Telegram alert, and the next
run reads the balances again. Money only moves between the owner's own
Blink accounts.

Blink sets its limits per account. Using several accounts to get past
them may be against Blink's terms; raising the account level (KYC) is the
first option.

The payment shows up in the CPAY wallet as a receive with no CPAY payment
attached, so the receipt review may list it. Match it by the time and
amount in Admin → Settings → Blink sweep.

## Receive switch (BTCPay pays into the account with limit left)

Overflow moves money after it has landed. The receive switch changes where
it lands: BTCPay's Lightning connection (the store's `BTC-LN` payment
method) is pointed at another Blink account, so new invoices are paid
straight into it. The BTCPay API key needs **Modify store settings** on
the `cpay` store: `BTCPAY_API_KEY` itself, or `BTCPAY_SWITCH_API_KEY` when
set (then `BTCPAY_API_KEY` can stay create + view invoices only). Without
that permission BTCPay answers 403 and Admin shows it.

Each run, after the moves and overflow:

1. Reads BTCPay's Lightning connection string and finds which Blink account
   it pays into: by its `wallet-id` (each account's USD wallet), else by its
   `api-key` (`BLINK_RECEIVE_KEY_N` or `BLINK_API_KEY_N`). A connection
   that is not one of CPAY's Blink accounts is shown and never changed.
2. That account's **room** is its Blink withdrawal limit left minus the
   USD it already holds. At or above *switch below* (default $50) nothing
   happens.
3. Below it, with `blink_receive_switch_enabled` **On** (and the sweep on),
   picks the account that can send (Write key) with the most room, at least
   twice *switch below*. None: nothing happens ("no other account has
   enough limit left").
4. Records the switch in `blink_receive_switches` (the database refuses a
   second switch within 30 minutes, so overlapping runs cannot both switch
   and BTCPay never flips back and forth), then sets the connection to
   `type=blink;server=…;api-key=…;wallet-id=<that account's USD wallet>`
   and keeps Lightning on. It uses the account's `BLINK_RECEIVE_KEY_N`
   (Read + Receive) when set, else its `BLINK_API_KEY_N`, which can also
   spend: Admin then says so.
5. Reads the connection back. Only a confirmed switch is `done`; otherwise
   `unknown` with a Telegram alert to check BTCPay.

### Invoices open on the old account

BTCPay checks open Lightning invoices against the store's **current**
connection (BTCPay `LightningListener`), so after a switch it can miss a
payment to an invoice that was made on the old account: the payer pays,
the money lands in the old Blink account, and BTCPay never marks the
invoice paid. So every run (switch on or off), for two days after a switch:

- `system_blink_rescue_candidates()` lists open BTCPay payments (`new`,
  `pending` or `expired`) made before a switch, each with the account
  BTCPay paid into at that time.
- The edge function asks that Blink account, with its own key, whether
  the invoice's payment hash was received (`transactionsByPaymentHash`, a
  successful RECEIVE).
- Paid: `system_blink_rescue_settle` records it with the BTCPay webhook's
  own `system_settle_gateway_invoice` (same dedupe per invoice, platform
  fee and auto withdraw) for the amount asked, logs it in `blink_rescues`
  and sends a Telegram alert. If BTCPay also sees it later, the webhook
  answers `already_settled`. BTCPay itself may still show such an invoice
  as expired.

## Settings (Admin → Settings → Blink sweep)

| Setting | Default | |
|---|---|---|
| `blink_sweep_enabled` | Off | ⚠ asks to confirm, audited |
| `blink_sweep_keep_usd` | 0 | USD left in Blink |
| `blink_sweep_min_usd` | 5 | smaller balances wait |
| `blink_sweep_max_usd` | 200 | ⚠ the most moved in one run |
| `blink_sweep_overflow_enabled` | Off | ⚠ overflow between Blink accounts, audited |
| `blink_receive_switch_enabled` | Off | ⚠ point BTCPay at another Blink account, audited |
| `blink_receive_switch_below_usd` | 50 | switch when the receiving account's room is below this |

*USD to leave*, *smallest* and *largest move* apply to each account.

The same page shows where the next move goes, each Blink account (USD
balance, can send, Blink limit left, moved in the last 24 hours, last
result), the last 20 moves, the last 20 overflow transfers, which account
BTCPay pays into, the last 20 BTCPay switches and the payments recorded
after a switch (`admin_blink_sweeps`, admins only). Keys,
invoices and Blink wallet ids are never sent to the page.

## Secrets (names only)

| Name | What |
|---|---|
| `BLINK_API_KEY` | Blink API key with **Read** and **Write** (dashboard.blink.sv → API Keys). Make a separate key for this; keep the BTCPay plugin's own key as it is. A Read + Receive key cannot send: the account shows "Key cannot send: needs Write". |
| `BLINK_API_KEY_2` … `BLINK_API_KEY_10` | optional, one more Blink account each, same permissions |
| `BLINK_RECEIVE_KEY`, `BLINK_RECEIVE_KEY_2` … `_10` | optional, a **Read + Receive** key of the same account; what BTCPay gets on a receive switch (else the Write key) |
| `BTCPAY_SWITCH_API_KEY` | optional, receive switch: a separate BTCPay API key with **Modify store settings** on the `cpay` store; otherwise `BTCPAY_API_KEY` is used and needs that permission |
| `BLINK_SWEEP_CRON_SECRET` | optional; otherwise `CRON_SECRET`, which pg_cron sends from Vault (`cpay_cron_secret`) |
| `BLINK_API_URL` | optional, only `https://api.blink.sv/graphql` or `https://api.staging.blink.sv/graphql` |

The keys can be set from Admin → Secrets & keys. A Write key can
spend the Blink balance, but this function only pays invoices from the
CPAY wallet's own address.

## Turn it on

1. Merge, then apply the migration and deploy `blink-sweep`
   (`supabase functions deploy blink-sweep`). The migration schedules the
   `blink-sweep` cron job when pg_cron and the Vault secrets exist.
2. Set `BLINK_API_KEY` (and `BLINK_API_KEY_2` … for more accounts).
3. Within 10 minutes, Admin → Settings → Blink sweep lists each account.
   Check *Can send* says Yes and the destination is the primary CPAY
   wallet's Lightning address.
4. Set *smallest move* low (for example 1) and turn the sweep **On**. After
   the next run, check the move in the log, in Blink, and in the CPAY
   wallet balance. Then set the limits you want.

For the receive switch: add a Read + Receive key for each account as
`BLINK_RECEIVE_KEY` / `_2` …, make sure the BTCPay API key has Modify
store settings, check the
*BTCPay receiving account* line shows the account BTCPay uses now, then
turn the switch **On**.

Turning it **Off** stops new moves. A move already in flight is left as
it is until it is turned back on.

## Not covered

- **On-chain BTCPay payments** stay in BTCPay's on-chain wallet. Move them
  yourself.
- The Blink **BTC** wallet is not swept, only the USD wallet.
- The sweep only adds to the CPAY wallet; it never sends from it.
