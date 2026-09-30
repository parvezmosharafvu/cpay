import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.CPAY_BASE_URL || 'https://pay-cashapp.buzz';

export default defineConfig({
  testDir: 'tests',
  timeout: 45_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL,
    ...devices['Pixel 7'],
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
