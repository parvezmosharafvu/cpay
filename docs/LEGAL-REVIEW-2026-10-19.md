# Legal pages review, 2026-10-19 (non-custodial rewrite)

Supersedes the text of draft PR #97 for `public/terms.html`, `privacy.html`, `refund.html`,
`contact.html`. Written for CPAY as a **non-custodial** Bitcoin/Lightning payment-software provider
(target model in `docs/NON-CUSTODIAL-PLAN.md`, PR #126). Reviewed by CPAY's assigned reviewer; this is
not advice from a licensed lawyer in any jurisdiction.

## Covered
No-custody statement; user responsibility for keys and wallet provider; payments final and
irreversible; refunds are merchant-to-payer; prohibited use; suspension with review; no warranty;
limitation of liability (12-month fees or USD 100) and indemnity; fee disclosure with 30-day notice;
privacy purposes, processors, retention, rights; complaints procedure with timelines; a transition
clause for remaining pre-non-custodial CPAY balances.

## Owner must supply (the only `[brackets]` left; `ci/check_legal.py --release` fails until filled)
| Field | Pages |
|---|---|
| `[Legal entity name]` | all four |
| `[Registered address]` | all four |
| `[Effective date]` | all four |
| `[Governing law jurisdiction]`, `[Courts with jurisdiction]` | terms |
| `[Privacy contact email]` | privacy |
| `[Support email address]` | contact |

Then: remove the "Not yet published" note and the `noindex` meta, link the pages from the footer.

## Publish only when true
- Publish **after** custodial receive is frozen (plan phase P3). Until then production is still custodial
  and section 2 of the Terms would be inaccurate.
- If a CPAY fee is introduced, add the exact rates to the Terms or link a fee page.
- Retention periods (12 months / 6 years / 90 days) are proposed defaults; confirm against local
  record-keeping law.
- Counsel should still confirm that the non-custodial model needs no licence where CPAY and its users
  are, and the trademark risk of the current domain name.
