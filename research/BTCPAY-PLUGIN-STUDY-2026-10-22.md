# BTCPay plugin source study — 2026-10-22

**Purpose:** repeatable engineering research for CPAY. These are external projects
at their specified source revisions, **not components installed by this PR**.
No proprietary credentials, production integrations, live payments, app installs
or permission upgrades were performed. A repository, demo or plugin listing is
not a security audit or a recommendation to activate a payment rail.

## How the layers fit

BTCPay has *two* extensibility patterns that must not be confused:

1. **Greenfield REST integration:** CPAY creates/reads invoices through a
   store-scoped, invoice-only key. BTCPay receives and normalizes payment
   methods supplied by its installed plugins. CPAY verifies the HMAC on the
   raw webhook payload, fetches the *actual* invoice and payment methods from
   the configured store, validates CPAY metadata and uses a unique ledger
   settlement id. CPAY does **not** need a plugin copied into its own Deno
   backend for this architecture.
2. **In-process BTCPay plugin:** a separately installed .NET component
   registers a Lightning backend, payment method handler, controllers,
   background listeners, reconciliation tasks and sometimes its own DB
   migrations. Installation changes the attack surface and often the
   destination of the real funds. Version compatibility is per BTCPay
   instance; the official per-instance `/docs` and plugin manager win
   over assumptions about the latest GitHub branch.

### Confirmed sources and engineering takeaways

| External project | Exact source reviewed / evidence | What it implements | CPAY disposition |
|---|---|---|---|
| Blink BTCPay plugin (Kukks) | [Blink plugin source](https://github.com/Kukks/BTCPayServerPlugins/tree/master/Plugins/BTCPayServer.Plugins.Blink), [official Blink guide](https://dev.blink.sv/examples/btcpayserver-plugin) | Custodial API-key path and non-custodial **Spark** Lightning-address receive-only path. The latter creates invoices via LNURL and follows LUD-21 verify; it cannot spend, report balances or manage channels and polls for receipts. | Learn capability separation, polling and authoritative proof. Do not present Spark addresses as CPAY-managed spendable reserves. |
| SamRock Protocol | [pinned source](https://github.com/rockstardev/samrockprotocol/tree/99a82e72ad24c459a4989173a89c4dc14d23bcb8/Plugins/SamRockProtocol), [README](https://github.com/rockstardev/samrockprotocol/blob/99a82e72ad24c459a4989173a89c4dc14d23bcb8/README.md) | OTP-limited wallet-to-store setup via QR, watch-only BTC/Liquid descriptors, optional Boltz-mediated Lightning setup. Controller/API is store-scoped and rate-limited. | Consider separately reviewed merchant-owned receive setup only after direct-settlement approval. Do not reuse its storeId-derived pseudo-secret example for credential protection. |
| MakePay | [pinned plugin](https://github.com/makepay-apps/btcpayserver-makepay/tree/c2a8145071a273eba8300a97746b3ffa8d27a7f7/BTCPayServer.Plugins.MakePay), particularly `MakePayWebhookVerifier.cs`, `MakePayPaymentRecorder.cs` and `MakePayInvoiceListener.cs` | Multiple external swap/payment routes; timestamped HMAC webhook, duplicate-by-session payment recording, background recheck and distinction between received deposit and final merchant settlement. | Adapt **state-machine and reconciliation** lessons, not swapping code or third-party checkout. Currency conversion has counterparty, rate, compliance and reserve risks; do not count deposits as spendable settlement. |
| CLINK (WoompaLoompa) | [source](https://github.com/WoompaLoompa/btcpay-clink), [README](https://github.com/WoompaLoompa/btcpay-clink/blob/main/README.md) | A Nostr-relay Lightning protocol using encrypted invoice requests, signed/protocol receipts, status polling and per-store state. Supports subscription use cases in its own BTCPay plugin. | Learn receipt-proof boundaries, timeouts and per-store isolation. Do not call a relay event alone a confirmed invoice settlement. |
| Strike Lightning backend | [pinned plugin](https://github.com/Marfusios/strike-btcpayserver-plugin/tree/bb21b84defad4c48ab970a5ce78d4a4ca3e29fdc/plugin), including `StrikeLightningClient.Listening.cs` | Provider-specific Lightning `ILightningClient`, receive requests persisted and a listener polling for newly completed invoices. Provider API scopes and version matter. | Reusable ideas: persistent receive request IDs, bounded polling, resume/recovery. Not integrated in CPAY, no provider token stored. |
| DePix | [pinned payment handler](https://github.com/thgO-O/btcpayserver-plugin-depix/tree/ac8216374f22ba6e630ecb67e96b103ef07194d/BTCPayServer.Plugins.Depix) | Region-specific payment method into a Liquid-based asset, webhook and partner API. Its checkout requires compliant payer identifiers and has local compliance-specific validation. | Do not import regional payment rails or collect additional payer identity data as a side effect of research. Reuse only the lessons on validated fields, webhook authentication and encrypted provider secrets. |
| OpenReceive | [pinned receive-only NWC plugin](https://github.com/OpenReceive/openreceive/tree/374fc54fa9558a7a3cdd258ad81491866453420d/packages/dotnet/BTCPayServer.Plugins.OpenReceive), `Nwc/WalletPreflight.cs`, `Nwc/ReceiveOnlyNwcClient.cs`, `PAYMENT-SAFETY-UPGRADE.md` | Receive-only Nostr Wallet Connect; fails preflight when required receive methods/encryption are missing, rejects spend-capable connections by default; supports independent historical receipt and swap recovery. Some advanced provider routes require additional separate reconciliation. | High-value study for future merchant-wallet onboarding: enforce spend-disabled capabilities, idempotent historical recovery, versioned migration/lease behavior. Do not enable external wallet or swap paths now. |
| Arkade | [pinned source](https://github.com/ArkLabsHQ/btcpay-arkade/tree/ecdcb2b20cfc2a81bbc018f78e8a40abe84541a1/BTCPayServer.Plugins.ArkPayServer), `ArkContractInvoiceListener.cs`, `RecoveryStatusTracker.cs` | Ark/VTXO wallet, settlement listeners, optional Lightning conversion and backup/recovery paths; includes a real sending service and stateful wallet lifecycle. README labels technology alpha. | Not a simple receive-only provider. Treat signing keys, operator availability, unilateral-exit paths and wallet recoverability as new independent security reviews, not ready-to-enable features. |
| Beldex | [pinned plugin](https://github.com/Beldex-Coin/btcpayserver-beldex-plugin/tree/a83cb630c86e065551c98c9e9f3dc3d8c71b1f0d/Plugins/Beldex) | Altcoin daemon/wallet-RPC checkout backend; its README explicitly warns that a **single wallet is shared across all BTCPay stores**. | Strong negative example for CPAY: multi-tenant funds and reserve attribution need isolation, not shared wallets with ambiguous ownership. Do not enable. |
| Trocador checkout plugin | [public registry entry](https://plugin-builder.btcpayserver.org/public/plugins/trocador-app), [public source](https://github.com/rafael-xmr/trocador-plugin) | An external conversion widget/plugin permitting alternative-asset checkout. Registry lists version compatibility and user-reported breakage on a 2026 review. | **Research/listing only.** User-provided instance URL `https://btcpay805858.lndyn.com/server/plugins/directory?selectedSlug=trocador-app` could not be inspected here; no assumption that it is installed, works or can settle CPAY invoices. Not enabled. |
| Developer references | [Kukks](https://github.com/Kukks), [WoompaLoompa](https://github.com/WoompaLoompa), [BTCPay plugin docs](https://docs.btcpayserver.org/Developers/) | Profiles are discovery/maintainer links, not stable specifications. Code, tests, pinned tags, API permissions, dependency versions and actual BTCPay instance docs determine behavior. | Do not treat a developer profile or GitHub popularity as an integration guarantee. |

## Security requirements derived from the comparisons

- **Capability is explicit:** `receive_invoice` and `observe_settlement`
  never imply `read_balance`, `spend`, `refund` or `swap`.
  An invoice-only API key must not allow payouts or wallet administration.
- **Proof is source-specific:** a provider quote, receiving address, swap
  deposit, unsigned callback or Lightning invoice *creation* does not prove
  final settlement. For CPAY gateway invoices require authentic `BTCPay-Sig`
  over the raw body, re-fetched store invoice status, method lookup and
  ledger idempotency. For merchant-direct receiving, require the protocol's
  payment-hash/preimage proof.
- **Custody and solvency stay separate:** plugin-settled value can land in
  the merchant wallet, the store's on-chain wallet, a plugin custody account,
  an off-chain wallet or an intermediate swap. A BTCPay `Settled` invoice
  cannot by itself prove the pooled CPAY payout wallet can cover USD claims.
- **Reconciliation must survive restarts:** pending/expired/late payments,
  duplicate callbacks, missing notifications and replays need bounded
  retry, persisted identifiers, audit trails and separate operator review
  for failures. Do not backfill by inventing settlements.
- **Tenant isolation:** every credential, listener, wallet mapping and
  callback must be store-scoped. Shared-wallet plugins require an explicit
  reserve/isolation design before adoption.
- **Migration safety:** additive migrations, rollback evidence, immutable
  historical receipts and compatible old/new worker behavior are release
  requirements. Do not run two competing workers or bypass release gates.
- **Operational data minimization:** do not accept extra payment-rail
  personal-data fields or spending credentials just because a plugin
  requests them. Do not introduce third-party rails before a legal,
  operations and security review.

## CPAY: what was implemented in this PR

- **Existing, not new:** `supabase/functions/_shared/btcpay.ts` uses a
  store-scoped Greenfield invoice-only key; `btcpay-webhook/handler.ts`
  checks HMAC, re-fetches the invoice/payment methods, compares CPAY metadata
  and settles through `system_settle_gateway_invoice` with duplicate
  suppression. `btcpay_lightning_only` defaults to true.
- **This source hardening:** BTCPay settled-figure classification distinguishes
  `lightning`, `onchain`, `plugin` and `unreported`. Alerts no longer
  label unknown plugin settlements as Lightning or assume the pooled wallet
  received the funds. No financial event, fee calculation, balance,
  permissions or settlement transition is changed.
- **Tests:** synthetic unknown-plugin and missing-method cases ensure the
  classification and alert are honest while preserving the same
  `system_settle_gateway_invoice` interface and existing duplicate rules.
- **Not implemented / not authorized:** installing external plugins, adding
  custodial provider tokens, enabling swap/on-ramp methods, reconfiguring
  BTCPay, sending funds, changing production database, turning on direct
  settlement, or merging into `main`.

## How CPAY will work (operator mental model)

```text
Merchant creates a payment link (CPAY)
  ├─ Current custodial path: payer → platform wallet → verified receipt
  │       → idempotent ledger → fee → member balance / eligible withdrawal
  ├─ Optional BTCPay gateway [OFF until owner enables]:
  │       payer → BTCPay invoice (BTC-LN only by default)
  │       → BTCPay confirms its actual configured backend/plugin
  │       → signed webhook → CPAY re-fetches store+invoice+method
  │       → idempotent ledger → same accounting as above
  │       [Different actual asset destination => reserve reconciliation]
  └─ Merchant-direct path [OFF until approved]:
          payer → merchant wallet directly
          → invoice hash/preimage verification → receipt record ONLY
          → NO credit to the pooled CPAY balance, NO platform wallet custody
```

Before a production launch, the owner must verify release blockers:
legal/contact publication, passkey recovery, backup restore/PITR decision,
independent pooled solvency, actual receipt-to-withdraw reconciliation,
Turnstile and signed proxy-IP rollout, scoped cron secret rotation, and
an approved limited operational pilot. These are *not* solved by plugin study
or source-level CI.

## Reproducibility and source limitations

The project references above were inspected using GitHub read-only access,
with SHA-pinned directories where provided. The Blink documentation,
BTCPay developer/API documentation and public plugin registry were also
reviewed on 2026-10-22. **Do not assume a pinned commit equals the latest
release**, a GitHub README proves software quality, or a public plugin
listing proves the user's instance has the plugin installed. The custom
BTCPay directory page could not be opened; the public registry is
separate evidence only.

Primary cross-cutting reading:
- https://docs.btcpayserver.org/Developers/api/
- https://docs.btcpayserver.org/Developers/api/authentication/
- https://docs.btcpayserver.org/Developers/
- https://dev.blink.sv/examples/btcpayserver-plugin
- https://openreceive.org/guides/payment-safety-upgrade
