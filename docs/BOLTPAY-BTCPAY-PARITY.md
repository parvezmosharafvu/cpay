# Boltpay → CPAY BTCPay compatibility (review before deployment)

Boltpay (private reference repository) and CPAY both create **USD-priced BTC-LN**
invoices through BTCPay Greenfield and receive the signed `InvoiceSettled`
webhook. Blink GraphQL and the USD `wallet-id` are configured **inside the
BTCPay Blink Lightning plugin**. Neither project's `create-invoice` Edge
Function needs a new direct Blink invoice-creation GraphQL call.

## This branch (isolated, not deployed)

- Port Boltpay's **three payment-method GET attempts**, separated by
  **800 ms**. CPAY previously performed only one GET immediately after
  creating a BTCPay invoice, when Blink's BOLT11 may not yet be ready.
- Preserve CPAY's single BTCPay invoice, create-ledger-row-first order,
  idempotency, settled-payment verification, USD amounts, and webhook RPC.
- Preserve the current short Blink invoice expiration for now. **Do not copy
  Boltpay's 60-minute checkout setting** without verifying the underlying
  BOLT11 `x` expiry: observed CPAY Blink invoices were often valid for
  only 240 seconds. The visible 5-minute checkout timer still needs a
  separately tested clamp to the actual BOLT11 expiration.
- **No connection string, API key, seed, wallet ID or store configuration
  is changed or disclosed.** No transaction is generated.

## Required operator checks before approving any deployment

1. Read the BTCPay `cpay` store's BTC-LN connection *locally* and confirm
   `type=blink`, expected GraphQL endpoint, `api-key` presence and the
   **USD wallet ID**. Do not copy credentials into a PR or issue.
2. Compare one previous sender-side successful/failed payment against
   BTCPay invoice state and Blink's received transaction records.
3. Confirm checkout's **true BOLT11 expiry** is used for payer-facing
   timing; do not imply 60 minutes when Blink expires in 4–5 minutes.
4. A failed `blink-sweep` (e.g. 119 cents attempted with 118-cent balance)
   is separate from incoming BTC-LN settlement and needs its own fee-buffer fix.
5. Run Verify/CI and review before merging. Main branch and production must
   be separately authorized; no deployment is performed by this PR.

Boltpay's webhook is not copied byte-for-byte because Boltpay and CPAY
have different payment schemas; CPAY's verified `system_settle_gateway_invoice`
RPC, signature/store/metadata checks and rescue/idempotency safeguards must
remain intact.
