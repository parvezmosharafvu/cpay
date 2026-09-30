# Playwright smoke tests

Admin login, tab restore, Settings save, Wallet transport errors.

## Local

```bash
npm install
npm run test:e2e:install
export CPAY_BASE_URL=https://pay-cashapp.buzz
export CPAY_ADMIN_EMAIL='you@example.com'
export CPAY_ADMIN_PASSWORD='...'
npm run test:e2e
```

Do not put the password in the repo. Use a staging admin if you have one.

## CI

Workflow `.github/workflows/e2e.yml` is manual + nightly. Add repository secrets:

- `CPAY_ADMIN_EMAIL`
- `CPAY_ADMIN_PASSWORD`
- optional `CPAY_BASE_URL` (defaults to https://pay-cashapp.buzz)

Without those secrets the tests skip.
