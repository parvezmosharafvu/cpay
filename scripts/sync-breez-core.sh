#!/usr/bin/env bash
# Copy the payment-service logic the breez-wallet Edge Function reuses.
set -euo pipefail
cd "$(dirname "$0")/.."
for m in app ledger receipts withdraw wallet forward auth money fake-breez; do
  cp "payment-service/$m.mjs" "supabase/functions/breez-wallet/core/$m.mjs"
done
