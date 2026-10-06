import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: process.env.CPAY_BASE_URL || 'http://127.0.0.1:8765',
    headless: true,
  },
});
