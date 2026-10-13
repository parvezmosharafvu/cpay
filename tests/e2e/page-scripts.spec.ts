import { test, expect } from '@playwright/test';

// Classic <script> files share one global scope: a top-level const/let/class
// declared in two files is a SyntaxError that stops the second file entirely
// (PR #83 put ROUTE_RETRY_DELAYS in app.js and admin-wallet.js, so $w was never
// defined and Admin -> Wallet failed). Load every app page and fail on any
// uncaught script error.
for (const path of ['/admin.html', '/dashboard.html']) {
  test(`${path} loads its scripts without errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(path, { waitUntil: 'load' });
    await page.waitForTimeout(500);
    expect(errors).toEqual([]);
  });
}

