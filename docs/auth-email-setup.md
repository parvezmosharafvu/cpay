# cpay auth email setup (Resend + Supabase)

cpay er signup, confirm ar password reset email gula Supabase Auth pathay. Supabase er nijer email service shudhu testing er jonno: ghontay 2 ta email, ar shudhu project team member der kache jay. Tai amra Resend er SMTP diye pathai. SMTP mane email pathanor standard system.

Resend free plan e mashe 3,000 ta email jay, kintu dine maximum 100 ta. Dine er beshi lagle Brevo (dine 300) bhalo free option.

> Kono key, password ba token chat e paste korba na. Shob secret shudhu secure input diye dibe.

## 1. Resend account ar API key

1. https://resend.com/signup e account khulo.
2. Dashboard e **API Keys** e jao, tarpor **Create API Key** chapo.
3. Permission: `Sending access` dilei hobe. Shudhu nijer domain e limit korte parle aro bhalo.
4. Key ta (`re_...` diye shuru) ekbari dekhay, tai sathe sathe secure input e diye dao.

## 2. Key ta Supabase secret e rakho

- Secret er naam `RESEND_API_KEY`. Live project `riumaeihemgznvgattoc` e rakhbe.
- Key ashbe shudhu secure input diye: hidden terminal ba secret request. Chat e kokhono na.
- CLI diye (key ta file theke porbe, screen e dekhabe na):
  ```bash
  supabase secrets set --project-ref riumaeihemgznvgattoc RESEND_API_KEY="$(cat /workspace/cpay/secrets/resend_api_key)"
  ```
- Kheyal rakho: Supabase Auth ei secret ta nije theke pore na. SMTP password field e (step 5) key ta abar boshate hoy. Secret ta rakha hoy jate edge function gula (jemon report email) porer bar key ta use korte pare.

## 3. Domain verify (Resend + Cloudflare)

1. Resend dashboard e **Domains** e jao, tarpor **Add Domain** chapo. Jemon `cpay.app`, ba alada subdomain `mail.cpay.app`.
2. Resend kichu DNS record dibe:
   - `resend._domainkey` e DKIM (`TXT`).
   - `send` subdomain e SPF (`MX` ar `TXT`).
   - Optional DMARC (`_dmarc` e `TXT`).
3. Cloudflare e **DNS**, tarpor **Records** e jao. Protita record hubohu copy koro: type, name, value, ar `MX` er priority.
4. Proxy **OFF** rakho (grey cloud, "DNS only").
5. Resend e **Verify** chapo. Kichu minute theke kichu ghonta lagte pare. Status `Verified` na howa porjonto porer step e jaba na.
6. Verify na hole Resend shudhu tomar account er email e pathabe, onno user er kache na.

## 4. Site URL thik koro

- Supabase dashboard e jao: **Authentication**, tarpor **URL Configuration**, tarpor **Site URL**. Ekhane live site address boshao (jemon `https://cpay.app`).
- Live e ekhon `http://localhost:3000` set kora ache. Er fole email er link kaj kore na.
- **Redirect URLs** e login, signup ba reset page thakle add koro. Jemon:
  - `https://cpay.app/*`
  - `https://cpay.app/reset.html`
- Management API diye korle field er naam `site_url` ar `uri_allow_list`.

## 5. Custom SMTP on koro

Supabase dashboard e jao: **Project Settings**, tarpor **Auth**, tarpor **SMTP Settings**. Notun dashboard e eta **Authentication**, tarpor **Emails**, tarpor **SMTP Settings** e thakte pare. Tarpor **Enable custom SMTP** on koro.

| field | value |
|---|---|
| Sender email | `no-reply@<verified-domain>` (verified domain er address hotei hobe) |
| Sender name | `cpay` |
| Host | `smtp.resend.com` |
| Port | `465` (na chole `587`) |
| Username | `resend` |
| Password | Resend API key |

Management API diye (`PATCH /v1/projects/riumaeihemgznvgattoc/config/auth`) field gula holo `smtp_admin_email`, `smtp_sender_name`, `smtp_host`, `smtp_port` (string e, jemon `"465"`), `smtp_user` ar `smtp_pass`. Save korar por config abar pore check koro. Password kokhono print korba na.

## 6. Email rate limit barao

- Custom SMTP chara default limit ghontay 2 ta email. SMTP on korle Supabase shuru te 30 kore dey.
- Dashboard e jao: **Authentication**, tarpor **Rate Limits**. Management API te field er naam `rate_limit_email_sent`.
- Resend free plan e dine 100 ta. Tai ghontay 30 theke 100 er moddhe rakha thik. Ghontay 100 dileo dine 100 er beshi jabe na.

## 7. Confirm email on/off

- Admin panel er Settings tab e "Confirm email" switch ache. Eta `auth-settings` edge function diye `mailer_autoconfirm` badlay.
  - Switch kaj korar jonno live e `CPAY_SUPABASE_ACCESS_TOKEN` secret thaka lagbe.
  - Admin panel er ei UI live e ashbe frontend deploy er por.
- Na hole Supabase dashboard e jao: **Authentication**, tarpor **Email** (ba **Sign In / Providers**, tarpor **Email**), tarpor **Confirm email**.
- Ekhon live e Confirm email **OFF**. Tai signup e confirm email jabe na.

## 8. Test

1. Confirm email off thakle password reset diye test koro. Na hole kichukkhoner jonno Confirm email on koro.
2. Nijer ekta email diye notun user signup koro, ba "forgot password" chapo.
3. Check koro:
   - email inbox e aseche kina, spam e na
   - sender tomar verified domain kina
   - link ta Site URL e niye jay kina
4. Resend dashboard er **Emails** e delivery status dekho.
5. Supabase er **Logs**, tarpor **Auth** e error ache kina dekho.
6. Test er por Confirm email jeta chaiso shei obosthay firiye dao.
