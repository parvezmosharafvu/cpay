# Legal pages: facts, fields and publishing

Notes for the owner on `public/terms.html`, `public/privacy.html`, `public/refund.html` and
`public/contact.html`. Each statement below matches the code on `main`; update this file and the
pages together when the code changes.

## How money moves (what the pages describe)

| | Auto withdraw on | Auto withdraw off | Direct payment (built, switched off) |
|---|---|---|---|
| Setting | `payment_mode = instant_forward`, or the account override `on` | `payment_mode = balance`, or the account override `off` | `payment_mode = direct` or the direct pilot list |
| Who receives the payer's bitcoin | CPAY's platform wallet (one wallet for all users) | CPAY's platform wallet | The user's own wallet provider |
| After the platform fee | Forwarded to the saved Lightning address, or USDT on a supported network | Added to the user's balance | No CPAY fee |
| How the user gets paid | Automatically; held forwards (`owed`) are retried, released to the balance or paid by the admin | The user withdraws from the desk: Lightning (saved address or invoice) or USDT (saved address), after a recent sign-in | Already in the user's wallet |
| Refunds | Merchant refunds from their own wallet; Lightning payments cannot be reversed | Same | Same |

- The global switch is Admin → Settings → Auto withdraw; each profile can be set to Default, On or Off
  in Admin → Manage users (docs/AUTO-WITHDRAW.md). The desk shows the user which applies.
- Turning Auto withdraw off for an account adds its waiting forwards to its balance.
- A forward is held as `owed` when there is no usable address, it is below the minimum, it is above
  `instant_forward_max_usd`, or the send keeps failing (migrations 20261020030000, 20261020080000).
- USDT forwards under the network minimum are grouped until they reach it.
- Only an admin can reverse a settled payment.

## Data the pages list

Account data; sign-in security data; payout addresses (Lightning and USDT, with network); payment and
forward records; approximate payer location (country, region, city from request headers; never GPS or IP);
optional account location; last-seen country; IP address only hashed for rate limits; browser storage
for the session and checkout state. The link owner sees the payer location on their own payments;
admins see all locations.

## Fields the owner fills in (never in the HTML)

The static pages keep bracketed labels by design; `public/legal-fields.js` fills them from settings.
`python3 ci/check_legal.py --release` fails until every one is filled:

| Field | Setting | Pages |
|---|---|---|
| `[Legal entity name]` | `legal_entity_name` | all four |
| `[Registered address]` | `legal_address` | all four |
| `[Effective date]` | `legal_effective_date` | all four |
| `[Governing law jurisdiction]`, `[Courts with jurisdiction]` | `legal_jurisdiction`, `legal_courts` | terms |
| `[Privacy contact email]` | `legal_privacy_email` | privacy |
| `[Support email address]` | `legal_support_email` | contact |

## Publishing (no code change)

Admin → Settings → Legal pages: fill every field, then turn on **Publish legal pages** in Features
(refused until every field is filled; needs two-step sign-in; audited). `public/legal-fields.js` then
fills the fields and removes the note and `noindex`; `public/site-settings.js` adds the footer links.
`ci/check_legal.py --release` (run by `scripts/release-gate.mjs`) reads production's
`get_public_site_settings()` and passes once published.

## Check before publishing

- The live `payment_mode` and any account overrides match what you tell users.
- The hosting region named in the privacy page is the project's real region.
- Retention periods (12 months / 6 years / 90 days) are applied; some are manual, not automatic.
- Exact fee rates are shown in the desk or added to the terms.
- Open decisions for the owner: licensing or registration for receiving and forwarding or holding
  user funds where CPAY and its users are (Bangladesh, the United States and other sign-up countries),
  identity checks and sanctions screening, consumer and data-protection rules, and the domain name.
