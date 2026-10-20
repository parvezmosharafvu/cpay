# CPAY সিস্টেম গাইড (বাংলা)

এই গাইডে সহজ ভাষায় লেখা আছে CPAY চালাতে কোন কোন account লাগে, শুরু থেকে কীভাবে setup করবেন, Admin Settings-এর প্রতিটা জিনিস কী করে, কোন secret কোথায় থাকে, কোন API বা Edge Function কী করে, deploy-এর ক্রম, প্রতিদিন কী দেখবেন, আর সাধারণ সমস্যার সমাধান।

এখানে কোনো secret-এর মান (value) নেই, শুধু নাম আছে। মান কখনো repo, chat বা ticket-এ রাখবেন না।

Admin panel-এ **সিস্টেম গাইড** বাটনে এই একই লেখা দেখা যায়, কিন্তু **শুধু owner** (Edge secret `CPAY_OWNER_USER_ID`-এর account), passkey দিয়ে sign in করা থাকলে। অন্য admin বাটনই দেখে না। লেখাটা `owner-guide` Edge Function-এর ভেতরে থাকে, সাইটের কোনো public file-এ নয়। এই file বদলালে চালান: `node scripts/build-admin-guide.mjs`, তারপর `owner-guide` আবার deploy করুন।

## সূচিপত্র

1. [কোন কোন account লাগে](#accounts)
2. [শুরু থেকে setup](#setup)
3. [Admin Settings](#settings)
4. [Secret আর env var](#secrets)
5. [API আর Edge Function](#apis)
6. [Deploy-এর ক্রম আর প্রতিদিনের check](#deploy)
7. [সাধারণ সমস্যা আর সমাধান](#problems)
8. [সাম্প্রতিক আপডেট](#updates)
9. [এখন কী কী setting করতে হবে](#todo)

<a id="accounts"></a>
## ১. কোন কোন account লাগে

| Account | CPAY-তে কী কাজ | না থাকলে কী হয় | খরচ |
|---|---|---|---|
| GitHub (`parvezmosharafvu/cpay`) | Code রাখা, Pull Request, CI (`.github/workflows/verify.yml`), wallet deploy-এর আগে "Verify" সবুজ কিনা দেখা | Code বদলানো বা deploy করা যায় না; wallet deploy script নিজেই থেমে যায় | Private repo-তে Actions-এর মাসিক ফ্রি মিনিট আছে |
| GitHub ledger backup repo (private, আলাদা) | `ledger-backup` প্রতি রাতে হিসাবের snapshot এখানে commit করে | Backup হয় না, alert যায় | ফ্রি |
| Supabase (project `riumaeihemgznvgattoc`) | Database (Postgres), Auth (login), Edge Functions, secrets, Vault, pg_cron | পুরো সাইট বন্ধ: login, payment, withdraw কিছুই চলে না | ফ্রি plan আছে; production-এ Pro plan রাখাই নিরাপদ (backup, pause হয় না) |
| Cloudflare | Worker `cpay` (সাইট, `public/` folder, `wrangler.jsonc`), Worker `cpay-og-preview` (link preview আর invoice rate limit, `worker/wrangler.jsonc`), Workers Builds (main থেকে auto deploy), DNS, Turnstile (bot check) | সাইট খোলে না; Turnstile না থাকলে নতুন invoice আটকে যেতে পারে | Workers আর Turnstile-এর ফ্রি plan যথেষ্ট |
| Domain registrar (`pay-cashapp.buzz`) | Domain-এর মালিকানা; nameserver Cloudflare-এ দেওয়া | Domain মেয়াদ শেষ হলে সাইট আর email দুটোই বন্ধ | বছরে একবার renew |
| Wallet provider (API key) | Lightning invoice বানানো, payment পাওয়া, forward আর withdraw পাঠানো, USDT swap | কোনো payment আসে না, কিছু পাঠানো যায় না | Provider-এর নিজের শর্ত |
| Resend (email sender) | Supabase Auth-এর email (verification, password reset) `no-reply@pay-cashapp.buzz` থেকে SMTP দিয়ে পাঠায় (`docs/CPAY_AUTH_AND_EMAIL.md`) | নতুন user email verify করতে পারে না, password reset যায় না | ফ্রি plan-এ দৈনিক সীমা আছে |
| Telegram bot (@BotFather) | Settled payment-এর বার্তা আর ops alert admin group-এ (`telegram-notify`) | বার্তা queue-তে জমে থাকে, payment-এ কোনো সমস্যা হয় না | ফ্রি |
| Alert webhook (ঐচ্ছিক) | `ALERT_WEBHOOK_URL`: health fail, backup fail হলে বার্তা | Alert চুপচাপ বাদ যায় | ফ্রি |

আলাদা কোনো USDT/Tron server নেই। USDT পাঠানো wallet provider-এর swap দিয়েই হয়।

`payment-service/` folder-এর Node service এখন deploy করা নেই। এটা শুধু CI-তে test হয়, backup হিসেবে রাখা।

<a id="setup"></a>
## ২. শুরু থেকে setup (ক্রম মেনে)

### ২.১ Account খোলা

1. GitHub account আর repo। আলাদা একটা private repo ledger backup-এর জন্য।
2. Supabase account, একটা project (region কাছাকাছি)।
3. Cloudflare account, domain-কে Cloudflare-এ যোগ করুন, registrar-এ Cloudflare-এর nameserver দিন।
4. Wallet provider-এর কাছ থেকে API key নিন। Wallet-এর ১২/২৪ শব্দ (mnemonic) offline-এ লিখে রাখুন।
5. Resend-এ domain verify করুন (DNS record Cloudflare-এ)।
6. Telegram-এ @BotFather দিয়ে bot বানান, admin group-এ যোগ করুন।

### ২.২ Repo আর database

1. Repo clone করুন। `public/config.example.js` দেখে `public/config.js`-এ `SUPABASE_URL` আর anon key দিন (এগুলো public, লুকানোর দরকার নেই)।
2. Supabase CLI দিয়ে link: `supabase link --project-ref <ref>`।
3. Migration চালান: `supabase db push`। Migration সবসময় ক্রম অনুযায়ী চলে। পুরনো migration file কখনো বদলাবেন না।

### ২.৩ Secret বসানো

Supabase → Edge Functions → Secrets-এ [৪ নম্বর অংশের](#secrets) list অনুযায়ী secret দিন। `CRON_SECRET`-এর একই মান Vault-এও `cpay_cron_secret` নামে রাখুন।

### ২.৪ Edge Function deploy

1. সাধারণ function: `supabase functions deploy <name>`। `supabase/config.toml`-এ প্রতিটার `verify_jwt` ঠিক করা আছে, ওটা বদলাবেন না।
2. Wallet function: শুধু `scripts/` folder-এর wallet deploy script দিয়ে (`scripts/deploy-…-wallet.sh <project-ref>`)। Script দেখে নেয় HEAD = `origin/main` আর ওই commit-এ "Verify" সবুজ কিনা। এটা single instance (lease) চালায়।

### ২.৫ সাইট

Cloudflare → Workers → `cpay` → Workers Builds-এ GitHub repo যোগ করুন, branch `main`। এরপর main-এ merge হলেই সাইট নিজে থেকে deploy হয়। `worker/` folder-এর `cpay-og-preview` আলাদাভাবে `wrangler deploy` দিয়ে।

### ২.৬ Login (Auth) setting

Supabase → Authentication-এ:

- **Email confirm চালু** (Confirm email)। Admin → Settings থেকেও বদলানো যায় (`auth-settings`)।
- **Passkeys চালু।** কখনো বন্ধ করবেন না, admin-এর কাজ passkey ছাড়া হয় না।
- **Google provider বন্ধ।**
- **TOTP (authenticator app):** নতুন করে যোগ বন্ধ। পুরনো code আপাতত চলে, যাতে কেউ আটকে না যায়।
- SMTP: Resend-এর তথ্য, sender `no-reply@pay-cashapp.buzz`।
- Site URL আর Redirect URLs-এ নিজের domain আর `/reset.html`।

### ২.৭ প্রথম admin

নিজের account বানিয়ে email verify করুন, database-এ admin role দিন, তারপর **দুটো passkey** যোগ করুন (ফোন আর password manager)।

<a id="settings"></a>
## ৩. Admin Settings — প্রতিটা জিনিস সহজ ভাষায়

Admin → Settings-এ যা আছে (`public/admin-platform-settings.js`, `public/admin-owner-settings.js`)। বদলাতে passkey sign-in লাগে, আর প্রতিটা বদল audit-এ লেখা থাকে।

### Auto withdraw (সবার জন্য)

- **Turn on:** fee কাটার পর প্রতিটা payment নিজে থেকেই user-এর save করা Lightning বা USDT address-এ চলে যায় (instant forward)।
- **Turn off:** টাকা user-এর balance-এ জমা থাকে। User নিজে Withdraw page থেকে তোলে।
- ভেতরে এটা `payment_mode` setting (`instant_forward` বা `balance`)। `direct` mode-এ payer সরাসরি user-এর wallet-এ দেয়, CPAY টাকা পায় না, fee নেয় না।

### Auto withdraw (প্রতিটা profile)

Admin → Manage users → প্রতিটা row-এ: **Default** (উপরের global setting মানবে), **On**, বা **Off**। কাউকে Off করলে তার আটকে থাকা forward balance-এ চলে যায়।

### Platform fee

প্রতিটা payment-এ CPAY-এর fee (%), Balance আর Instant forward mode-এ। Manage users-এ কারো নিজস্ব fee দিলে সেটাই খাটে।

### Legal pages

`legal_entity_name`, `legal_address`, `legal_effective_date` (YYYY-MM-DD), `legal_jurisdiction`, `legal_courts`, `legal_privacy_email`, `legal_support_email`। এগুলো Terms, Privacy আর Refund page-এ বসে।

**Features → Publish the legal pages (`legal_published`):** সব legal field পূরণ না হলে চালু হয় না। বন্ধ থাকলে ওই page-গুলো খালি দেখায়।

### Domains

সাইটের domain list (`site_domains`)। এখানে domain যোগ করলে ৫ মিনিটের মধ্যে function-গুলো ওই domain থেকে call নেয় (CORS)।

### Secrets & keys

Supabase আর Cloudflare Worker-এর secret-এর **শুধু নাম** দেখায়। মান একবার দেওয়া যায়, আর কখনো দেখানো হয় না। `SUPABASE_` দিয়ে শুরু নামগুলো সুরক্ষিত। এটা কাজ করতে `CPAY_SUPABASE_ACCESS_TOKEN` আর Cloudflare-এর `CPAY_CLOUDFLARE_*` লাগে।

### Cloudflare → Always Use HTTPS

সব http request-কে https-এ পাঠায়। চালু রাখুন।

### Advanced (লুকানো, সাধারণত বদলানোর দরকার নেই)

- **Instant forward:** `instant_forward_no_address` (address না থাকলে: balance-এ রাখা, নাকি payment নেওয়া বন্ধ), `instant_forward_min_sat`, `instant_forward_max_usd`, `instant_forward_max_fee_pct`, `instant_forward_max_attempts`।
- **পুরনো switch:** `custodial_receive_enabled`, `custodial_new_links_enabled`, `custodial_withdraw_enabled`, `fee_billing_enabled` — এখন Auto withdraw-ই এগুলো ঠিক করে।
- **Direct payments:** `direct_pilot_user_ids`, `direct_provider_hosts`।
- **Subscription fees:** `fee_pilot_no_fee`, `fee_subscription_price_usd`, `fee_free_tier_usd`, `fee_grace_days`।
- **Admin wallet limits:** `admin_send_daily_cap_usd` (admin দিনে কত পাঠাতে পারে), `admin_send_allowed_destinations`।

### Turnstile (bot check)

এটা Admin Settings-এ নয়, secret দিয়ে চলে: `TURNSTILE_SECRET_KEY` + `TURNSTILE_MODE` (`monitor` = শুধু log, `enforce` = token ছাড়া invoice হবে না)। Site key `public/config.js`-এ (public)। `direct-invoice` নতুন invoice বানায় শুধু `enforce` হলে।

<a id="secrets"></a>
## ৪. Secret আর env var (শুধু নাম)

বেশিরভাগ secret থাকে **Supabase → Edge Functions → Secrets**-এ (পুরো project-এর জন্য এক জায়গা)। Admin → Settings → Secrets & keys থেকেও বদলানো যায়। পরিবর্তন করতে পারেন শুধু Supabase project-এর owner/admin, বা passkey-সহ CPAY admin।

| নাম | কোথায় | কে ব্যবহার করে | না থাকলে |
|---|---|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase নিজেই দেয় | সব function | — |
| `BREEZ_MNEMONIC` | Edge secret (wallet function) | Wallet | Wallet চালু হয় না |
| `BREEZ_API_KEY` | Edge secret | Wallet (wallet provider key) | Mainnet-এ wallet চলে না |
| `BREEZ_NETWORK` | Edge secret | Wallet (`mainnet`) | Wallet চালু হয় না |
| `BREEZ_DB_URL` | Edge secret | Wallet-এর নিজের schema | Wallet চালু হয় না |
| `PAYMENT_SERVICE_URL` | Edge secret | `create-invoice`, `user-withdraw`, `admin-actions`, `health` | Invoice আর withdraw বন্ধ |
| `PAYMENT_SERVICE_SECRET` | Edge secret (দুই পাশে একই) | Function ↔ wallet | Invoice বন্ধ |
| `PAYMENT_SERVICE_AUTH_MODE` | Edge secret (ঐচ্ছিক) | `bearer` বা `signed` | Default `bearer` |
| `ADMIN_JWT_MODE` | Edge secret (ঐচ্ছিক) | Wallet-এর admin route | Default |
| `CRON_SECRET` | Edge secret + Vault `cpay_cron_secret` | cron job, `health`, `daily-report`, `ledger-backup`, `telegram-notify`, wallet sync | Scheduled কাজ সব বন্ধ |
| `STEP_UP_MAX_AGE_SECONDS` | Edge secret (ঐচ্ছিক, 600) | Withdraw/admin confirm | Default |
| `ADMIN_MFA_EXPECTED` | Edge secret (ঐচ্ছিক) | `health` | Alert হয় না |
| `TURNSTILE_SECRET_KEY`, `TURNSTILE_MODE` | Edge secret | `create-invoice`, `direct-invoice` | Bot check বন্ধ; direct invoice বন্ধ |
| `ALLOWED_ORIGINS` | Edge secret (ঐচ্ছিক) | CORS | Domains list-ই যথেষ্ট |
| `ALERT_TELEGRAM_BOT_TOKEN`, `ALERT_TELEGRAM_CHAT_ID`, `ALERT_ON_SETTLED` | Edge secret | `telegram-notify`, alert | বার্তা queue-তে জমে |
| `ALERT_WEBHOOK_URL` | Edge secret (ঐচ্ছিক) | Alert | Alert বাদ যায় |
| `CPAY_OWNER_USER_ID` | Edge secret | `owner-guide` (owner-এর Supabase Auth user id) | System guide কেউ দেখতে পায় না |
| `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO` | Edge secret | `ledger-backup` | Backup হয় না |
| `CPAY_SUPABASE_ACCESS_TOKEN`, `CPAY_PROJECT_REF` | Edge secret | `auth-settings`, `owner-config` | Settings-এ "Not set up" |
| `CPAY_CLOUDFLARE_API_TOKEN`, `CPAY_CLOUDFLARE_ACCOUNT_ID`, `CPAY_CLOUDFLARE_ZONE_ID`, `CPAY_CLOUDFLARE_WORKER` | Edge secret | `owner-config` (Worker secret, HTTPS) | Cloudflare অংশ "Not set up" |
| `DIRECT_RECONCILE_SECRET`, `DIRECT_SETTLEMENT_NETWORK`, `DIRECT_PROVIDER_HOSTS` | Edge secret (ঐচ্ছিক) | `direct-invoice`, `settlement-destination` | Direct-এর sweep বন্ধ |
| `CPAY_BASE_URL`, `CPAY_ADMIN_EMAIL`, `CPAY_ADMIN_PASSWORD` | GitHub → Settings → Secrets → Actions | `e2e.yml` (live admin smoke test) | ওই test skip/fail |
| `CPAY_TURNSTILE_SITE_KEY`, Supabase URL, anon key | `public/config.js` (public) | Browser | Login/invoice কাজ করে না |

খুব শক্তিশালী token: `CPAY_SUPABASE_ACCESS_TOKEN` (পুরো Supabase account-এ কাজ করে) আর `BREEZ_MNEMONIC` (wallet-এর সব টাকা)। এগুলো শুধু Edge secret-এ রাখুন।

### কীভাবে rotate করবেন

1. নতুন মান বানান (যেমন `openssl rand -hex 32`), বা provider-এর dashboard থেকে নতুন key নিন।
2. Supabase → Edge Functions → Secrets-এ (বা Admin → Settings → Secrets & keys → Replace) নতুন মান দিন। Function নিজে থেকেই নতুন মান নেয়।
3. `CRON_SECRET` বদলালে SQL editor-এ Vault-এও একই মান দিন: `select vault.create_secret('<নতুন মান>', 'cpay_cron_secret');`
4. `PAYMENT_SERVICE_SECRET` দুই পাশে একসাথে বদলান।
5. পুরনো key provider-এর dashboard থেকে revoke করুন।
6. Admin → Health দেখে নিন সব সবুজ।
7. `BREEZ_MNEMONIC` "rotate" করা যায় না, এটা wallet নিজেই; বদলানো মানে নতুন wallet আর টাকা সরানো — আগে পরিকল্পনা করুন।

<a id="apis"></a>
## ৫. API আর Edge Function

| Function | কী করে | কে call করে |
|---|---|---|
| `create-invoice` | Payment link থেকে USD amount নিয়ে Lightning invoice বানায় | Payer-এর browser (checkout), Worker-এর `/api/create-invoice` |
| `direct-invoice` | Direct mode-এ user-এর নিজের wallet থেকে invoice | Payer-এর browser; reconcile sweep |
| `user-withdraw` | Manual withdraw (passkey confirm) | Signed-in user (Withdraw page) |
| `settlement-destination` | User-এর payout address save/check | Signed-in user |
| `admin-actions` | Admin-এর wallet আর payout কাজ | Admin panel |
| `auth-settings` | Email confirm চালু/বন্ধ | Admin panel |
| `owner-config` | Secret-এর নাম দেখা/বসানো, Cloudflare HTTPS | Admin panel |
| Wallet function | Wallet চালায়: receive, forward, withdraw, sync | অন্য function আর cron (`PAYMENT_SERVICE_SECRET` দিয়ে) |
| `health` | সিস্টেম ঠিক আছে কিনা দেখে, alert দেয় | cron, Admin → Health |
| `daily-report` | দৈনিক হিসাব বন্ধ করা | cron |
| `ledger-backup` | রাতের backup GitHub-এ | cron |
| `telegram-notify` | Queue থেকে Telegram বার্তা পাঠায় | cron |
| `og-image` | Link preview-এর ছবি | `cpay-og-preview` Worker |
| `owner-guide` | এই গাইড শুধু owner-কে দেয় (passkey session লাগে) | Admin → System guide |

এছাড়া database-এর RPC (যেমন `admin_platform_settings`, `admin_set_platform_setting`, `admin_set_auto_withdraw_global`, `admin_locations`) admin panel সরাসরি call করে। সব admin RPC active admin আর passkey session চায়।

Cron job (`pg_cron`): wallet sync, `cpay-daily-close`, `cpay-telegram-send`, `prune-webhook-events`, `receipt-review-sweep`।

<a id="deploy"></a>
## ৬. Deploy-এর ক্রম আর প্রতিদিনের check

### Deploy-এর ক্রম

1. Migration (নতুন file, main-এর সব migration-এর পরে sort হয়)।
2. Edge Function: `supabase functions deploy <name>`; wallet শুধু wallet deploy script দিয়ে। গাইড বদলালে `supabase functions deploy owner-guide` (প্রথমবার আগে `CPAY_OWNER_USER_ID` secret দিন)।
3. সাইট: main-এ merge হলে Cloudflare Workers Builds নিজে deploy করে।

উল্টো ক্রমে করলে নতুন code পুরনো database খুঁজে না পেয়ে fail করতে পারে।

### প্রতিদিন যা দেখবেন

- Admin → Health: সব সবুজ কিনা, wallet lease চলছে কিনা।
- Admin → Instant forwards: আটকে থাকা (held/owed) forward আছে কিনা।
- Admin → Payouts: failed withdraw।
- Telegram group-এ alert এসেছে কিনা।
- GitHub-এ main-এর check সবুজ কিনা।
- সপ্তাহে একবার: ledger backup repo-তে নতুন commit, Resend-এ bounce।
- মাসে একবার: domain আর token-এর মেয়াদ।

<a id="problems"></a>
## ৭. সাধারণ সমস্যা আর সমাধান

| সমস্যা | সম্ভাব্য কারণ | কী করবেন |
|---|---|---|
| Invoice বানাতে 503 | Wallet বন্ধ, বা `PAYMENT_SERVICE_*` ভুল | Admin → Health দেখুন; secret মিলিয়ে দেখুন; wallet আবার deploy |
| Invoice-এ "captcha" error | Turnstile site key আর secret মেলে না | `TURNSTILE_MODE=monitor` করে দেখুন, key মিলিয়ে নিন |
| Forward আটকে আছে | User-এর address কাজ করছে না | User-কে address ঠিক করতে বলুন; বা ওই profile-এ Auto withdraw Off করুন (টাকা balance-এ যাবে) |
| Withdraw "reauth_required" | Passkey sign-in পুরনো | আবার passkey দিয়ে sign in |
| Verification email আসে না | Resend/SMTP ভুল বা দৈনিক সীমা শেষ | Resend log আর Supabase Auth → SMTP দেখুন |
| Cron চলছে না | `CRON_SECRET` আর Vault-এর মান আলাদা | দুটো একই মান দিন |
| Telegram বার্তা নেই | Bot token নেই বা bot group-এ নেই | `ALERT_TELEGRAM_*` দেখুন |
| Settings-এ "Not set up" | `CPAY_SUPABASE_ACCESS_TOKEN` বা `CPAY_CLOUDFLARE_*` নেই | Supabase-এ secret দিন |
| Legal page খালি | `legal_published` বন্ধ | Legal field পূরণ করে চালু করুন |
| "Supabase Preview" check লাল | DB-এর migration history আর repo-র file মেলে না | Read-only ভাবে `supabase_migrations.schema_migrations` আর `supabase/migrations/` মিলিয়ে দেখুন; history হাতে বদলাবেন না |
| Admin-এ ঢুকতে পারছেন না | Passkey হারিয়েছে | দ্বিতীয় passkey ব্যবহার করুন; তাই সবসময় দুটো রাখুন |

<a id="updates"></a>
## ৮. সাম্প্রতিক আপডেট

Merge commit `git log` থেকে মিলিয়ে লেখা।

| তারিখ | কী এসেছে | PR / merge commit |
|---|---|---|
| ২০ অক্টোবর ২০২৬ | **Instant forward:** fee কাটার পর টাকা সরাসরি user-এর নিজের Lightning বা USDT address-এ যায়; না গেলে held/owed হয়ে আবার চেষ্টা হয় | #132–#136 (`473043a`, `f564af9`, `59b51aa`, `8193733`), USDT forward #139/#140 (`e0b12f1`, `47460e2`), safety fix #142 (`078fa7d`), শুধু instant mode #147 (`be4661e`) |
| ২০ অক্টোবর ২০২৬ | **একটাই "You receive" amount:** user শুধু একটা সংখ্যা দেখে, কত পাবে | #141 (`6017ad5`) |
| ২০ অক্টোবর ২০২৬ | **Address সাথে সাথে বদলায়** (২৪ ঘণ্টার অপেক্ষা নেই) | #137 (`be72627`), #138 (`4be21d6`) |
| ২০ অক্টোবর ২০২৬ | **নতুন এক-page checkout, নতুন dashboard আর location** (payer-এর দেশ/অঞ্চল/শহর, শুধু দেখার জন্য) | #143 (`fd92d6a`), bangla #144/#145 (`4037045`, `0fee063`), theme preview #149 (`e77d788`) |
| ২০ অক্টোবর ২০২৬ | Legal page-এর লেখা code-এর সাথে মেলানো | #146 (`4250afd`) |
| ২১ অক্টোবর ২০২৬ | **Auto withdraw** global switch + প্রতিটা profile-এ Default/On/Off, আর আলাদা **manual Withdraw** page; legal লেখা থেকে reviewer-এর কথা বাদ | #151 (`885dff9`) |
| ২১ অক্টোবর ২০২৬ | **Login শুধু passkey + email verification:** Google বন্ধ, নতুন authenticator (TOTP) যোগ বন্ধ, admin কাজে passkey লাগে | #152 (`0d634e5`) |
| ২১ অক্টোবর ২০২৬ | Repo পরিষ্কার, `AGENTS.md` আর `docs/SYSTEM-OVERVIEW.md` | #153 (`ce32488`) |
| ২১ অক্টোবর ২০২৬ | **এই System guide**, শুধু owner দেখতে পারেন (`owner-guide` function) | #154 |
| ২১ অক্টোবর ২০২৬ | **Google পুরোপুরি সরানো:** repo থেকে Google login-এর বাকি code, test mock আর লেখা বাদ; Supabase-এ Google provider বন্ধ। Client id/secret মোছা আর admin account থেকে Google identity আলাদা করা dashboard-এ বাকি (৯.৫ দেখুন) | #155 |

<a id="todo"></a>
## ৯. এখন কী কী setting করতে হবে

২১ অক্টোবর ২০২৬, ভোর ৪টা (ঢাকা) পর্যন্ত live অবস্থা শুধু পড়ে দেখা হয়েছে (কিছু বদলানো হয়নি)। ✅ = হয়ে গেছে, ⬜ = বাকি, ❔ = repo থেকে দেখা যায় না, আপনি dashboard-এ দেখে নিন।

### ৯.১ Auto withdraw

- ✅ **সবার জন্য On** (এখন `payment_mode = instant_forward`)। বদলাতে: Admin → Settings → Auto withdraw → **Turn on** / **Turn off** → confirm।
- ⬜ **কোনো একজনের জন্য আলাদা** (ঐচ্ছিক): Admin → Manage users → ওই user-এর row → Auto withdraw → **Default / On / Off**। Off করলে তার টাকা balance-এ জমবে, সে Withdraw page থেকে তুলবে।
- ✅ **Address না থাকলে:** এখন `refuse` — যার address নেই সে payment নিতে পারে না। বদলাতে: Settings → Advanced → Instant forward → `instant_forward_no_address`।

### ৯.২ Fee আর limit

- ✅ **Platform fee 5%।** বদলাতে: Settings → Platform fee → নতুন % → **Save fee**। কারো আলাদা fee: Manage users → ওই row।
- ✅ Forward limit (`instant_forward_min_sat`, `instant_forward_max_usd`, `instant_forward_max_fee_pct`, `instant_forward_max_attempts`) — default মান চলছে। দরকার হলে Settings → Advanced → Instant forward।
- ⬜ **Hot-wallet cap:** `admin_send_daily_cap_usd` এখনো দেওয়া নেই। Settings → Advanced → Admin wallet limits → একটা দৈনিক সীমা (USD) দিন, আর `admin_send_allowed_destinations`-এ নিজের address দিন।

### ৯.৩ Legal

- ⬜ **Legal field:** সব খালি। Settings → Legal pages → entity name, address, effective date (YYYY-MM-DD), jurisdiction, courts, privacy email, support email → প্রতিটা **Save**।
- ⬜ **Publish:** তারপর Settings → Features → **Publish the legal pages** চালু (`legal_published`)।

### ৯.৪ Secret

- ❔ **`TURNSTILE_MODE=enforce`:** secret আছে (শেষ বদল ১৫ অক্টোবর), কিন্তু মান পড়া যায় না। Supabase → Edge Functions → Secrets বা Admin → Settings → Secrets & keys → `TURNSTILE_MODE` → Replace → `enforce`। আগে দেখুন checkout-এ Turnstile ঠিক চলছে।
- ⬜ **`DIRECT_RECONCILE_SECRET`:** দেওয়া নেই। Direct payment চালু করলে লাগবে: `openssl rand -hex 32` দিয়ে বানিয়ে Secrets-এ দিন।
- ⬜ **Wallet provider key rotate (`BREEZ_API_KEY`):** শেষ বদল ১২ অক্টোবর। Provider-এর dashboard থেকে নতুন key নিন → Supabase dashboard → Edge Functions → Secrets → `BREEZ_API_KEY` বদলান (Admin panel থেকে বদলানো যায় না, এটা সুরক্ষিত) → wallet function আবার deploy (wallet deploy script) → Admin → Health সবুজ কিনা দেখুন → পুরনো key revoke।
- ⬜ **পুরনো Telegram bot revoke:** @BotFather → `/mybots` → পুরনো bot → API Token → **Revoke**। নতুন token `ALERT_TELEGRAM_BOT_TOKEN`-এ আছে (শেষ বদল ৭ অক্টোবর); revoke-এর পর একটা test বার্তা আসে কিনা দেখুন।
- ✅ **`CPAY_OWNER_USER_ID`:** owner-এর account-এর id দেওয়া হয়েছে (System guide-এর জন্য)।

### ৯.৫ Backup আর login

- ❔ **Supabase PITR (Point-in-time recovery):** Supabase → Project Settings → Add-ons → Point in time recovery চালু আছে কিনা দেখুন (paid add-on)।
- ⬜ **পুরনো authenticator code বন্ধ:** আপনি passkey দিয়ে admin-এ ঢুকে একটা setting বদলে দেখুন। ঠিক থাকলে Supabase → Authentication → Multi-Factor → TOTP **Verify** বন্ধ।
- ✅ Google login বন্ধ (provider off), repo থেকে সব Google code সরানো।
- ⬜ **Google client id/secret মোছা:** Supabase → Authentication → Sign In / Providers → Google → **Client IDs** আর **Client Secret** খালি করুন → Save (provider off-ই থাকবে)। CLI এই দুটো field push করে না, তাই হাতে করতে হবে। তারপর Google Cloud Console → APIs & Services → Credentials → CPAY-এর OAuth client → **Delete**।
- ⬜ **Admin account থেকে Google identity আলাদা করা:** account-এ এখনো `email` আর `google` দুটো identity আছে (password আর passkey আছে, তাই আটকে যাওয়ার ভয় নেই)। Supabase-এ অন্য user-এর identity মোছার কোনো admin API বা dashboard বাটন নেই। আপনি অনুমতি দিলে SQL editor-এ একটাই লাইন: `delete from auth.identities where provider = 'google' and user_id = '<আপনার user id>';` (Authentication → Users → আপনার account থেকে user id দেখে নিন)।

### ৯.৬ Real টাকা দিয়ে test (আপনি করবেন)

- ⬜ Auto withdraw On profile-এ ছোট payment ($1–2): fee কেটে বাকিটা save করা address-এ যায় কিনা।
- ⬜ একটা profile Off করে payment: টাকা balance-এ জমে কিনা।
- ⬜ Off profile থেকে Withdraw: Lightning আর USDT, passkey দিয়ে confirm; History আর Admin → Payouts-এ দেখা যায় কিনা।
- ⬜ ইচ্ছে করে ভুল invoice দিয়ে withdraw: fail হলে টাকা balance-এ ফেরত আসে কিনা।
- ⬜ Address বদলানো (passkey দিয়ে): সাথে সাথে নতুন address-এ forward যায় কিনা।
