# CPAY Owner Guide — new project only

এই গাইডটি নতুন `cpay` project-এর জন্য। পুরনো CPAY production project,
তার Supabase database, payment wallet বা Cloudflare route-এ এই ধাপগুলো চালাবেন না।

## Current boundary

- GitHub: `parvezmosharafvu/cpay`
- Supabase: the new `cpay` project only
- Cloudflare: the separate `cpay` Workers & Pages project
- Old production: unchanged and out of scope
- Public browser configuration: `public/config.js` contains only the Supabase URL
  and anon key. Never add a service-role key, database password, payment provider key,
  webhook secret or GitHub token to this file.

## Phase 1 delivered locally

- CPAY branding and separate site/payment favicons
- Freelancer application at signup (one account type; the reseller role was removed in 20261005020000)
- Pending-account gate until admin approval
- Admin application queue with approve, reject and suspend actions
- Auto-approval switch for freelancer applications in the admin panel
- Role mapping: database `creator` → user-facing **Freelancer**; `admin` is the operator
- Checkout themes for the payment page and the invoice page only. A domain does not pick a theme.
- Payer-facing final-price disclosure for link markup
- Admin 360° profile workspace snapshot with payment, withdrawal, domain and audit timeline
- Admin emergency stops for new customer payments and new withdrawals, enforced server-side
- Per-profile permission matrix with server-side feature flags
- Verification state, verification notes and guarded bulk account actions for admins
- Advanced per-profile invoice and withdrawal limits with Dhaka-day payout thresholds
- Audited profile emergency suspension that hides public payments and stops auto-withdrawals
- Read-only global Audit tab with action, actor, subject and before/after filters

## Apply the database safely

### Option A — Supabase SQL Editor

1. Open the **new CPAY Supabase project**.
2. Take a backup/snapshot if the project already has data.
3. Run the files in `supabase/migrations/` in numeric order.
4. Confirm the objects you need exist before treating the project as ready.

Do not run these migrations against the previous production project.

### Option B — Supabase CLI

From the repository root, link the CLI to the new project and push only after
checking the target project reference:

```bash
supabase link --project-ref riumaeihemgznvgattoc
supabase db push
```

If the CLI asks for a database password, enter it locally in the CLI prompt.
Do not send it in chat or commit it to Git.

## Make the first CPAY admin

Create a test account through the new CPAY site. Because manual approval is the
default, temporarily promote that first owner account in the new Supabase SQL
Editor:

```sql
update public.profiles
set role = 'admin', account_status = 'active'
where email = 'YOUR-CPAY-OWNER-EMAIL';
```

Then log out and back in. The owner should land on `admin.html`.

## First functional test

Use a separate test email, not a real customer:

1. Register as **Freelancer**.
2. Confirm the account is pending.
3. In Admin → Applications, approve it.
4. Log in again and create a payment link.
5. Confirm a pending account cannot create links or request withdrawals.

## Deploy the frontend

The Cloudflare project should point to `parvezmosharafvu/cpay`:

- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`
- Root directory: `/`

Before the first deploy, run:

```bash
python3 ci/check_frontend.py
npm run build
```

## Payments

Payments run on a Lightning/Spark wallet SDK through `payment-service/` (see
`docs/ARCHITECTURE.md` and `docs/SIMPLE-MODEL.md`).

- Receive: a standard Lightning invoice (BOLT11), paid from a wallet that
  supports it. Cash App is tested; not every wallet can pay every invoice. Proven on mainnet
  (a settled `cpay payment` credits the platform wallet and the ledger).
- Payout: USDT to a saved address, quote then confirm. USDC only if that route
  is offered. Sats stay in the wallet until confirm (no Stable Balance).
- Not offered: any payout other than USDT/USDC, including a Lightning payout.
  Do not mark anything else paid by hand; it is not a product path.

Test invoice creation, settlement and a small USDT quote in staging before
larger payouts. Do not run the same seed on two hosts.

## What happens next

1. Apply migrations to the new CPAY Supabase project.
2. Deploy the Edge Functions and configure secrets in Supabase.
3. Push to the GitHub repository and deploy Cloudflare.
4. Run the onboarding, link and invoice checklist.
5. Review Admin → Health and `docs/PRODUCTION-READINESS.md`.
6. Only after a small mainnet receive and USDT send succeed, move real creator balances.
