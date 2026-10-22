import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  fullyParallel: false,
  reporter: 'list',
  webServer: process.env.CPAY_BASE_URL ? undefined : {
    command: 'python3 -m http.server 8765 --bind 127.0.0.1 --directory public',
    url: 'http://127.0.0.1:8765',
    cwd: '../..',
    reuseExistingServer: true,
  },
  use: {
    baseURL: process.env.CPAY_BASE_URL || 'http://127.0.0.1:8765',
    headless: true,
  },
});
