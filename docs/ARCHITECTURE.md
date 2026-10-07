# cpay architecture

Internal document. The payment processor is a Lightning/Spark wallet SDK;
no user-facing page names it (see "What users see").

Product payout is USDT to a saved address (USDC only if a route exists).
No other payout method, including Lightning payouts, is offered.
`request_withdrawal` is closed. See `docs/SIMPLE-MODEL.md`.

Themes apply to the payment page and the invoice page only. A domain does
not pick a theme.

## Pieces

```
browser ──► public/ (static, Cloudflare Workers assets)
   │           │  supabase-js (anon key + user JWT, RLS applies)
   │           ▼
   │        Supabase ── Postgres: the ledger (payments, withdrawals, profiles …)
   │           │         RLS, SECURITY DEFINER functions, pg_cron jobs
   │           ▼
   │        Edge functions (Deno): create-invoice, user-withdraw, admin-actions,
   │           │                    health, daily-report, ledger-backup, og-image,
   │           │                    telegram-notify, auth-settings
   │           ▼  Bearer PAYMENT_SERVICE_SECRET
   └──────► payment-service/ (Node 22, one long-running process)
               holds the one platform wallet (Lightning/Spark SDK)
               writes the ledger through DATABASE_URL (service role)
```

- **payment-service** is the only process that holds the wallet mnemonic.
  Routes: `POST /invoices`, `GET /health`, `GET /ready` (startup catch-up gate),
  `GET /metrics` (bearer; process counters only), `/withdraw/{routes,quote,confirm}`,
  `/admin/wallet/*`.
- **Supabase Postgres** is the ledger. Every balance rule lives in SQL.

## Data shape

| Thing | Where | Key columns |
|---|---|---|
| Payment link | `payment_links` | `slug`, `user_id`, `cost_percent`, `wallet_mode`, `invoice_theme` |
| Invoice / payment | `payments` | Lightning receive: `invoice_ref` (payment hash), `lightning_invoice`, `amount_sat`, `status` `new` → `settled` / `expired` / `invalid` |
| Balance | computed | `get_balance_for(user)`: settled earnings minus fees, minus withdrawals not `rejected`/`failed` |
| Withdrawal | `withdrawals` | `method` is `stablecoin` in the product (USDT/USDC to a saved address). Status `sending` → `paid` or `failed` |
| Address book | `usdt_wallets` | one USDT address per network per account |

Old manual method names may still appear in historical migrations. They are
not a current payout path.

## Receive

1. Payer opens `https://<site>/<slug>`, types an amount.
2. `create-invoice` inserts the row and asks the payment service for a bolt11.
3. The invoice page shows the QR and Open Cash App.
4. The service settles the payment. The page sees `settled` over Realtime.

## Withdraw

1. Account saves a USDT address.
2. Desk quotes (`user-withdraw` → `/withdraw/quote`) then confirms.
3. Or a threshold plus auto-withdraw files the payout via `system_queue_withdrawal`.
4. Confirm reserves under a profile lock and sends once. `failed` refunds once.

Spendable is wallet balance minus what creators are owed. Do not send the
creator portion from the admin wallet form.
