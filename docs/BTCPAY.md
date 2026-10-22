# BTCPay Server checkout

CPAY can make payer invoices on the owner's own BTCPay Server instead of
the CPAY wallet. It is **off by default**; the owner turns it on in
Admin → Settings → **BTCPay Server** (`btcpay_enabled`, passkey, audited).

Migration: `20261021050000_gateway_checkout.sql`. Functions:
`create-invoice` (makes the BTCPay invoice) and `btcpay-webhook` (records it).
Shared client: `supabase/functions/_shared/btcpay.ts`.

## What it does

1. A payer opens a CPAY payment link and enters an amount, exactly as today.
2. `create-invoice` inserts the `payments` row first, then calls the
   Greenfield API `POST /api/v1/stores/{BTCPAY_STORE_ID}/invoices` with the
   USD amount and metadata `orderId = cpay:<payment id>`, `cpayPaymentId`,
   `cpayLinkId`. By default `btcpay_lightning_only=true` requests the
   **BTC-LN method only**. Only if the owner explicitly turns that setting
   off does the request omit the payment-method restriction and allow all
   checkout methods configured on the BTCPay store.
3. The pay page displays BTCPay's Lightning invoice when available. When
   the owner has separately enabled unrestricted methods, the BTCPay
   checkout may also show on-chain and plugin payment options. A store
   without Lightning uses BTCPay's checkout page.
4. BTCPay calls `btcpay-webhook`. The function checks the `BTCPay-Sig`
   HMAC against every configured secret, ignores other stores, **re-fetches
   the invoice and its payment methods from BTCPay** (the body is never
   trusted), and on `InvoiceSettled` records the payment with
   `system_settle_gateway_invoice` (one record per invoice; replays are
   ignored).
5. The payment is then exactly like any other settled CPAY payment: the
   platform fee from Admin settings is taken first, then **Auto withdraw**
   (global switch + per-profile override) forwards the rest to the user's
   saved address, or it stays in the user's CPAY balance for a manual
   withdraw. A Telegram alert goes to the admin chat.
6. `InvoiceExpired` / `InvoiceInvalid` close an open row. A settled row is
   never changed by them. A late payment on an expired invoice still settles.

## Receive only

BTCPay only receives. CPAY never asks BTCPay to send: no payouts, pull
payments, refunds or wallet sends exist in this code (a test fails if one is
added). Every send (forwards, withdrawals, the USDT send) stays in the CPAY
wallet and payment service.

## On-chain payments

**On-chain bitcoin paid to a BTCPay invoice lands in BTCPay's on-chain
wallet (the `cpay` store's BIP84 wallet), not in the CPAY Lightning
balance.** CPAY still credits the user when BTCPay marks the invoice
settled, and Auto withdraw sends from the CPAY wallet, so keep enough float
in the CPAY wallet and move on-chain funds over yourself until an automatic
sweep is built. Lightning payments land wherever the store's Lightning
backend is connected.

## External BTCPay plugin methods (not automatically enabled)

A BTCPay plugin can add checkout methods that settle to a different
wallet, asset, network or conversion provider. CPAY's Greenfield/webhook
integration consumes BTCPay's normalized `Settled` invoice status; it
does not install, configure, authenticate to or custody a plugin's assets.
The webhook now reports four operator-facing method categories:
`lightning`, `onchain`, `plugin`, and `unreported`. For unknown plugin
methods it explicitly calls for independent reserve reconciliation
instead of labeling the receipt a CPAY Lightning balance. This change
**only affects alert text**: it does not change settled USD, fees,
wallet balances, forward behavior or payout approvals.

Before an owner ever enables more payment methods, review the target
BTCPay version/plugin compatibility, provider webhooks and settlement
proof, custody and asset destination, expiry/late-payment states, fees,
reconciliation and rollback. The default Lightning-only mode stays on.
The source-specific comparative review is in
[research/BTCPay plugin study](../research/BTCPAY-PLUGIN-STUDY-2026-10-22.md).
Do not treat a successful third-party exchange deposit as proof the
CPAY payout wallet has matching liquid reserves.

## Secrets (names only)

Set as Supabase Edge Function secrets, never in chat or the repo:

| Name | What |
|---|---|
| `BTCPAY_URL` | Your BTCPay address, `https://…` (no path after it) |
| `BTCPAY_STORE_ID` | The `cpay` store's id (Store → Settings → General) |
| `BTCPAY_API_KEY` | Greenfield API key, permissions below |
| `BTCPAY_WEBHOOK_SECRET` | The webhook's secret (`_2` … `_5` also accepted while rotating) |

Optional, already used by other functions: `ALERT_TELEGRAM_BOT_TOKEN`,
`ALERT_TELEGRAM_CHAT_ID`, `SITE_URL` (the return link on the BTCPay page).

## Setup on BTCPay (no other store is touched)

1. **API key:** Account → Manage account → API Keys → Generate key.
   Tick only **Create an invoice** (`btcpay.store.cancreateinvoice`) and
   **View invoices** (`btcpay.store.canviewinvoices`), and choose **only the
   `cpay` store** for both. Nothing else: no payouts, pull payments,
   wallet, or store-settings permissions.
2. **Webhook:** `cpay` store → Settings → Webhooks → Create webhook.
   - Payload URL: `https://riumaeihemgznvgattoc.supabase.co/functions/v1/btcpay-webhook`
   - Events: **An invoice has been settled**, **An invoice has expired**,
     **An invoice became invalid** (`InvoiceSettled`, `InvoiceExpired`,
     `InvoiceInvalid`).
   - Automatic redelivery on, enabled. Copy the secret it shows.
3. **Rates:** `cpay` store → Settings → Rates: spread 0%.
4. Put the four secrets in Supabase.
5. Deploy: migration, then `supabase functions deploy btcpay-webhook` and
   `create-invoice`, then the site.
6. Admin → Settings → **BTCPay Server** → On. Make a small Lightning and a
   small on-chain test payment, and check Admin → Payments and Telegram.
   Turning it Off sends new invoices back to the CPAY wallet; open BTCPay
   invoices still settle.
