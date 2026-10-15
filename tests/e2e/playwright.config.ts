import { defineConfig, devices } from '@playwright/test';

// Audit P2: end-to-end suites against the disposable local stack in
// e2e/stack.mjs (fresh Postgres, PostgREST with real RLS, the real
// create-invoice and user-withdraw Edge Functions, the real payment service
// with a fake wallet SDK). Never points at production.
const PORT = Number(process.env.E2E_PORT || 54321);
export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  // Pages load from localhost; the API (SUPABASE_URL) is 127.0.0.1, a
  // different origin, as pay-cashapp.buzz and supabase.co are in production.
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node e2e/stack.mjs',
    cwd: '../..',
    url: `http://127.0.0.1:${PORT}/__e2e/health`,
    timeout: 240_000,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
