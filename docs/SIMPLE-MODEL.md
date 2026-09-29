# Simple CPAY model

Receive stays Lightning (payer scans a QR).
Payout is USDT on any supported network, plus optional manual bKash / Nagad / Binance / bank.

## One payout book

Each account saves one USDT address per network in `usdt_wallets`.
Preferred network + optional dollar threshold live on `profiles`.

- Save address → withdraw uses it.
- Set a threshold and turn auto-withdraw on → `system_queue_withdrawal` files a payout when available balance reaches the threshold.
- Or press Withdraw on the desk → instant USDT quote/confirm (existing payment-service path) or a manual request for local rails.

Lightning is not a payout method. `request_withdrawal` rejects `lightning` and `usdt_bep20`.

## Themes

Themes exist only for:

- the payment-link page (`payment_links.theme`)
- the invoice page (`payment_links.invoice_theme`)

`site_domains.theme` is not used. `applyDomainTheme()` is a no-op kept for old pages.

## Duplicates left on purpose (do not recreate)

| Thing | Keep | Ignore / later delete |
|---|---|---|
| Admin UI | `admin.html` + `admin-classic.html` (classic is the working panel) | Do not add a third admin page |
| Wallet columns on `profiles` (`wallet_bkash` …) | Local-rail fallback | New USDT addresses go only in `usdt_wallets` |
| `onchain_addresses` | Legacy | `usdt_wallets` is the book the desk uses |
| `invoice-cpay-v2.html` | Invoice page | Payment page is `404.html` |

## What this change does not rewrite

The 100+ migrations, Breez receive path, fee hierarchy, reseller self-withdraw switch, daily 5pm Dhaka cycle, and Telegram outbox stay as they are. Complexity there is ledger safety, not UI.
