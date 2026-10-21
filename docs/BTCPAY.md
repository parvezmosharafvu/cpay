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
   `cpayLinkId`. No payment-method list is sent, so **every method the
   `cpay` store has on is offered (Lightning and on-chain bitcoin)**.
3. The pay page shows the Lightning QR from BTCPay and a
   **Pay with on-chain bitcoin** link to the BTCPay checkout page. A store
   without Lightning sends the payer straight to the BTCPay checkout.
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
