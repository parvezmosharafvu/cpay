# CPAY production-readiness checklist

CPAY is a separate system. Completing this checklist must not require a
change to the previous production project.

## Repository and database

- [ ] `python3 ci/check_frontend.py` passes.
- [ ] `npm run build` passes.
- [ ] A backup or snapshot exists for the new CPAY Supabase project.
- [ ] Migrations `0001` through `0100` apply in order on staging.
- [ ] Migration history and the live schema agree.
- [ ] RLS and security-definer search-path checks pass.
- [ ] The owner has recorded the rollback or restore plan.

## Identity and admin control

- [ ] An admin can approve and suspend test Freelancers and Resellers.
- [ ] Pending, rejected and suspended profiles cannot create public payment
  links or request payouts.
- [ ] Profile controls, domains, themes, limits, feature flags and audit
  entries have been exercised.
- [ ] Emergency suspension hides public payment pages and stops auto-queue
  behavior.

## Payment provider and events

- [ ] CPAY has its own mainnet Breez wallet (mnemonic stored offline) and
  API key, and the custody decision is made.
- [ ] Invoice creation, settlement, expiry and duplicate event delivery
  passed in staging.
- [ ] Public payment and QR invoice controls pass keyboard/screen-reader
  checks; `python3 ci/check_frontend.py` reports payment accessibility and
  QR ownership guards as green.
- [ ] Payment event signature validation is enabled.
- [ ] The live health function reports the payment provider correctly.
- [ ] The operator knows where to inspect an ambiguous `processing` payout.

## Withdrawals

- [ ] Lightning Address resolution, timeout, retry and idempotency passed.
- [ ] Manual and automatic withdrawal freezes were tested.
- [ ] Per-profile invoice, single-withdrawal and daily limits were tested.
- [ ] On-chain withdrawals remain disabled unless separately approved with
  evidence for address validation, fees, confirmations, retries and rollback.
- [ ] Instant stablecoin withdrawal passed a small mainnet send on each coin
  and network offered (see `payment-service/README.md`): quote shown, row
  `sending` then `paid` with `amount_out` matching what arrived, and a
  deliberately failed or refunded send leaves the balance restored once.
- [ ] Single and daily withdrawal limits are set for accounts that may use
  instant withdrawals, since nothing waits for an admin.
- [ ] Withdrawal platform fee: new accounts get 0% (0100). Accounts created
  before 0100 keep the fee they had; set each to the intended value in the
  admin panel.

## Cloudflare and public site

- [ ] Cloudflare points to the new `parvez-mosharaf/cpay` repository.
- [ ] Build command is `npm run build`; deploy command is
  `npx wrangler deploy`.
- [ ] Separate site and payment favicons render on the intended domains.
- [ ] Headers, HTTPS, custom domains, OG preview routing and CORS were
  checked.
- [ ] No old CPAY URL, Supabase project reference, wallet mnemonic or secret is
  present in the CPAY deployment.

## Operational sign-off

- [ ] Admin → Health preflight is reviewed.
- [ ] Admin → Health → Staging sign-off ledger is complete with evidence for
  every required gate.
- [ ] The scheduled health endpoint runs with a rotated cron secret.
- [ ] Daily reconciliation, ledger backup and alert delivery were observed.
- [ ] The owner has the payment staging runbook and emergency-stop procedure.
- [ ] A small, controlled production rollout is planned.

Do not call CPAY production-ready until every unchecked item has a named
owner, documented exception or completed test result.