# CPAY: controlled live test runbook

For the owner. Everything is done in a browser and in the Telegram alert
chat; no terminal is needed. Steps marked **REAL MONEY** move real funds
and are done only if the owner decides to, at the time, after the earlier
steps passed. Use the smallest amounts the screens allow.

## Before you start (all must be true)

1. The admin desk opens and Health shows **healthy**, with no open alert
   in Telegram from the last hour.
2. In the admin desk settings, both "Emergency: stop new customer payments"
   and "Emergency: stop withdrawals" are **off**, and you know where they are.
3. The last nightly ledger backup in Telegram/daily report says it succeeded.
4. You have a test member account that is not a real customer, with a
   public page, and a separate payer wallet with a few dollars of Lightning
   funds that you own.
5. For the payout step: a USDT address you own, saved on the test account
   **more than 24 hours earlier** (newer addresses are refused on purpose).

## Stop immediately if any of this happens

- Health turns unhealthy, or Telegram shows a wallet, settlement or
  ledger alert.
- A balance changes by an amount you did not expect, or changes twice.
- A payment shows "paid" in the payer wallet but stays unpaid on CPAY for
  more than 10 minutes.
- A payout is shown as sent but no transaction reaches your address within
  an hour, or a failed payout is not refunded to the balance.

To stop: turn on the matching emergency switch in the admin desk, write
down the time and the invoice or payout reference shown on screen, and do
nothing else to the wallet. Do not retry the same step.

## Steps

### 1. Invoice only (no money)
Open the test member's public page, enter $1 and create an invoice.
- Expected: a QR code and an invoice text starting with `lnbc` appear; the
  dashboard lists a new unpaid payment.
- Failure: an error message, or no new row on the dashboard. Stop.
- Let it expire without paying. Expected: it shows expired; balance unchanged.

### 2. Small payment — **REAL MONEY** (owner decides now)
Create a $1 invoice and pay it from your own payer wallet.
- Expected within about a minute: the invoice page shows paid; the
  dashboard shows the payment settled; the balance rises by $1 minus the
  platform fee, once; one Telegram message names the account (never an
  email address).
- Failure: any stop condition above.
- Refresh the dashboard twice more. The balance must not change again.

### 3. Payout quote (no money)
In the test dashboard, open Withdraw, choose the saved address and the
smallest amount, and stop at the quote screen.
- Expected: a quote with the fee and the amount to be received. Nothing is
  deducted until you confirm.
- Failure: the saved address is missing or refused although it is older
  than 24 hours. Stop.

### 4. Small payout — **REAL MONEY** (owner decides now)
Confirm the quote. You may be asked to sign in again.
- Expected: the balance drops once by the quoted amount; the payout shows
  as processing then sent; the transaction reaches your address.
- Failure: any stop condition above. A failure must show the amount
  refunded once.

### 5. Emergency switches (no money)
Turn on "stop new customer payments", try to create an invoice (it must be
refused), then turn it off. Do the same with "stop withdrawals" at the
quote screen.

### 6. Record the result
Write down the date, the amounts, and pass or fail for each step. Keep
references private. Do not post balances, invoice text or wallet details
in GitHub.

## Not covered here

The standalone phone wallet is not deployed. Its test plan is in
[WALLET-TESTING.md](WALLET-TESTING.md) and starts after the steps in
[CPAY_CLOUDFLARE_DEPLOYMENT.md](CPAY_CLOUDFLARE_DEPLOYMENT.md).
