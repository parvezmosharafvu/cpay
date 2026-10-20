# Owner settings (Admin → Settings) / মালিকের সেটিংস

Everything the owner changes day to day is on one page: **Admin → Settings**.
The language switch (বাংলা / English) is in the top bar of both dashboards and
is remembered in the browser.

| Section | What it changes | Protection |
|---|---|---|
| Features (on/off) | Wallet download link, legal pages published, fee pilot, subscription billing | Admin at aal2, audited |
| Payment & fees | Payment mode, platform fee %, legal details, wallet address | Admin at aal2, audited |
| Domains | Sites that may use CPAY (payment links, sign-in, CORS) | `admin_save_domain` / `admin_remove_domain`: aal2, audited; the main site domain cannot be turned off or removed |
| Secrets & keys | Supabase Edge Function secrets, Cloudflare Worker secrets | `owner-config`: aal2 always, a fresh sign-in for every change, **write-only**, audited, every admin gets a notice |
| Cloudflare | "Always Use HTTPS" | Same as secrets |

## Write-only secrets / সিক্রেট শুধু লেখা যায়

A value is sent once and is never shown, logged or returned again, not even to
the owner. The page lists names only. So a stolen admin session can replace a
key (and every admin is told at once) but can never read one.

Protected names cannot be set or deleted from the website, only in the
Supabase dashboard: the wallet's recovery words and storage (`BREEZ_*`), the
access tokens this page runs on (`CPAY_SUPABASE_ACCESS_TOKEN`,
`CPAY_CLOUDFLARE_*`, `CPAY_PROJECT_REF`) and `STEP_UP_MAX_AGE_SECONDS`.

## One-time setup / একবারের সেটআপ

Add these in the **Supabase dashboard → Edge Functions → Secrets** (one time):

1. `CPAY_SUPABASE_ACCESS_TOKEN`: Supabase → Account → Access Tokens → Generate
   new token. (Also used by the email-confirmation switch.)
2. `CPAY_CLOUDFLARE_API_TOKEN`: Cloudflare → My Profile → API Tokens → Create
   Token → Custom: *Account · Workers Scripts · Edit* and *Zone · Zone Settings
   · Edit* for the site's zone only.
3. `CPAY_CLOUDFLARE_ACCOUNT_ID` and `CPAY_CLOUDFLARE_ZONE_ID`: Cloudflare →
   the domain's Overview page, right column.
4. Optional `CPAY_CLOUDFLARE_WORKER` when the Worker is not named `cpay`.

বাংলায়: Supabase ড্যাশবোর্ড → Edge Functions → Secrets-এ উপরের চারটি একবার যোগ
করুন। এরপর বাকি সব (নতুন সিক্রেট, ডোমেইন, ফিচার চালু/বন্ধ, HTTPS) Admin →
Settings থেকেই করা যাবে।

## Language / ভাষা

`public/i18n.js` keeps a phrase list (English → Bangla). Menus, the top bar and
Settings are translated; other screens show Bangla where a phrase is listed and
English otherwise. To translate more, add the exact English text and its Bangla
to the list; `tests/frontend/i18n.test.mjs` checks every menu label has one.
