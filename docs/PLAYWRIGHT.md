# Playwright smoke tests

Admin login, tab restore, Settings controls, Wallet transport errors.

Playwright is **not** in root `package.json`. Cloudflare Workers runs `npm ci`
from that lockfile; putting `@playwright/test` there broke both `cpay` and
`cpay-og-preview` deploys.

Install it only when you run the tests.

## Local

```bash
npm install
npm install --no-save @playwright/test@1.55.0
npx playwright install chromium
export CPAY_BASE_URL=https://pay-cashapp.buzz
export CPAY_ADMIN_EMAIL='you@example.com'
export CPAY_ADMIN_PASSWORD='...'
npx playwright test
```

Do not put the password in the repo. Use a staging admin if you have one.

## CI

Workflow `.github/workflows/e2e.yml` is manual + nightly. Add repository secrets:

- `CPAY_ADMIN_EMAIL`
- `CPAY_ADMIN_PASSWORD`
- optional `CPAY_BASE_URL`

Without those secrets the `adminPage` fixture skips the tests.

## Public journey smoke (no secrets)

Static pages only. Does not hit Supabase.

```bash
npm install --no-save @playwright/test@1.55.0
npx playwright install chromium
python3 -m http.server 8765 --directory public &
CPAY_BASE_URL=http://127.0.0.1:8765 npx playwright test -c tests/public-smoke/playwright.config.ts
```
