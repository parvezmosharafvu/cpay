Byte-for-byte copies of payment-service/*.mjs (the same logic the VM runs).
Do not edit here: change payment-service/ and run `scripts/sync-breez-core.sh`.
The "core/ matches payment-service byte for byte" test in ../runtime_test.ts
fails CI if the copies drift.
