import { test as base, expect, type BrowserContext, type Route } from '@playwright/test';

// The pages load two pinned scripts from public CDNs (supabase-js from
// jsdelivr, qrcodejs from cdnjs). A CDN that answers slowly in CI held the
// page's load event past the 60 s test timeout (2026-10-28, invoice-lifecycle
// "refresh resumes the same invoice"). Every context here fetches each CDN
// file once per worker, with a short timeout and retries, and then serves the
// same bytes from memory, so the page still checks the real file against its
// SRI hash but no test waits on the network twice.
const CDN = /^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)\//;
const cache = new Map<string, Promise<{ status: number; headers: Record<string, string>; body: Buffer }>>();

async function fetchOnce(route: Route) {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await route.fetch({ timeout: 15_000 });
      if (res.ok()) return { status: res.status(), headers: res.headers(), body: await res.body() };
      last = new Error(`HTTP ${res.status()}`);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

async function serveCdn(route: Route) {
  const url = route.request().url();
  let hit = cache.get(url);
  if (!hit) {
    hit = fetchOnce(route);
    cache.set(url, hit);
    hit.catch(() => cache.delete(url));
  }
  try {
    await route.fulfill(await hit);
  } catch {
    await route.abort('failed');
  }
}

export async function cacheCdn(context: BrowserContext) {
  await context.route(CDN, serveCdn);
}

export const test = base.extend<{}, {}>({
  context: async ({ context }, use) => {
    await cacheCdn(context);
    await use(context);
  },
  // Contexts a test opens itself (a second device, a payer) get it too.
  browser: [async ({ browser }, use) => {
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (...args: Parameters<typeof newContext>) => {
      const ctx = await newContext(...args);
      await cacheCdn(ctx);
      return ctx;
    };
    await use(browser);
  }, { scope: 'worker' }],
});

export { expect };
export type { Page, CDPSession } from '@playwright/test';
