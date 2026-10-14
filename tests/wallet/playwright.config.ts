// CPAY Wallet browser tests (the standalone wallet, not the website).
//   cd wallet && npm ci --ignore-scripts && cd ..
//   npx playwright test -c tests/wallet/playwright.config.ts
//
// wallet.spec.ts runs a TEST build (fake engine, no network) against a
// fake CPAY account API. sdk.spec.ts runs a production build with the real
// wallet library under the real CSP.
import { defineConfig, devices } from '@playwright/test';

const exe = process.env.PW_CHROMIUM_PATH;

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    ...devices['Pixel 7'],
    ...(exe ? { launchOptions: { executablePath: exe } } : {}),
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'fake-engine', testMatch: 'wallet.spec.ts', use: { baseURL: 'http://127.0.0.1:8790' } },
    { name: 'real-sdk', testMatch: 'sdk.spec.ts', use: { baseURL: 'http://127.0.0.1:8792' } },
  ],
  webServer: [
    { command: 'node tests/wallet/fake-cpay.mjs 8791', url: 'http://127.0.0.1:8791/__log', reuseExistingServer: false, cwd: '../..' },
    {
      command: 'node wallet/build.mjs && node wallet/serve.mjs 8790',
      url: 'http://127.0.0.1:8790/', reuseExistingServer: false, cwd: '../..',
      env: { WALLET_TEST: '1', WALLET_ENGINE: 'fake', WALLET_NETWORK: 'regtest', CPAY_SUPABASE_URL: 'http://127.0.0.1:8791', CPAY_SUPABASE_ANON_KEY: 'anon-test-key' },
    },
    {
      // Real library, regtest (no API key needed), production build rules.
      // Built into a separate directory so it does not race the test build.
      command: 'node tests/wallet/build-real.mjs 8792',
      url: 'http://127.0.0.1:8792/', reuseExistingServer: false, cwd: '../..',
    },
  ],
});
