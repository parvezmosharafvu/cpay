import { test, expect, type Page } from '@playwright/test';
import { makeUser, makeLink, login, readyAddress } from './helpers';

async function noHorizontalOverflow(page: Page, label: string) {
  const over = await page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const wide = [...document.querySelectorAll('body *')].filter((e) => {
      const r = (e as HTMLElement).getBoundingClientRect();
      const st = getComputedStyle(e as HTMLElement);
      if (r.width === 0 || st.visibility === 'hidden' || st.display === 'none') return false;
      // inside a horizontal scroller is fine (tables)
      for (let p = e.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') return false; }
      return r.right > w + 1;
    }).slice(0, 5).map((e) => `${e.tagName.toLowerCase()}#${e.id}.${(e as HTMLElement).className}`);
    return { scroll: document.documentElement.scrollWidth - w, wide };
  });
  expect(over.scroll, `${label} scrolls sideways: ${over.wide.join(', ')}`).toBeLessThanOrEqual(1);
}

test.describe('320px wide phone', () => {
  test.use({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true });

  test('public pages fit without sideways scrolling', async ({ page }) => {
    const u = await makeUser();
    const slug = await makeLink(u.id, { name: 'A Very Long Studio Name For Small Screens' });
    for (const p of ['/', '/login.html', '/register.html', '/reset.html', `/${slug}`, '/no-such-link']) {
      await page.goto(p);
      await page.waitForLoadState('networkidle');
      await noHorizontalOverflow(page, p);
    }
    await page.goto(`/${slug}`);
    await page.keyboard.type('12');
    await page.click('#payBtn');
    await page.waitForURL(/invoice-cpay-v2/);
    await expect(page.locator('#step2')).toBeVisible();
    await noHorizontalOverflow(page, 'invoice');
  });

  test('the Freelancer desk and withdraw review fit', async ({ page }) => {
    const u = await makeUser({ earned: 30 });
    await readyAddress(u.id);
    await login(page, u);
    await page.waitForURL(/dashboard\.html/);
    for (const tab of ['home', 'links', 'pay', 'cash', 'profile']) {
      await page.evaluate((t) => (document.querySelector(`.navi[data-tab="${t}"]`) as HTMLElement).click(), tab);
      await page.waitForLoadState('networkidle');
      await noHorizontalOverflow(page, `desk ${tab}`);
    }
  });
});

test('keyboard only: type an amount and pay from the payment page', async ({ page }) => {
  const u = await makeUser();
  const slug = await makeLink(u.id);
  await page.goto(`/${slug}`);
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip-link')).toBeFocused();
  await page.keyboard.type('9');
  await page.keyboard.press('Enter');
  await page.waitForURL(/invoice-cpay-v2/);
});

test('wallet dialog: focus moves in, Escape closes it, focus returns to the opener', async ({ page }) => {
  const u = await makeUser();
  const slug = await makeLink(u.id);
  await page.goto(`/${slug}`);
  await page.keyboard.type('9');
  await page.click('#payBtn');
  await page.waitForURL(/invoice-cpay-v2/);
  await page.locator('#otherWalletsBtn').focus();
  await page.keyboard.press('Enter');
  const dialog = page.locator('#walletSheet [role="dialog"]');
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => !!document.activeElement?.closest('#walletSheet'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('#walletSheet')).toBeHidden();
  await expect(page.locator('#otherWalletsBtn')).toBeFocused();
});

test('reduced motion: spinners and sheets do not animate', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const u = await makeUser();
  const slug = await makeLink(u.id);
  await page.goto(`/${slug}`);
  const animated = await page.evaluate(() => [...document.querySelectorAll('*')].filter((e) => {
    const s = getComputedStyle(e);
    return s.animationName !== 'none' && parseFloat(s.animationDuration) > 0.01 && s.animationIterationCount === 'infinite';
  }).map((e) => e.className));
  expect(animated).toEqual([]);
});

test('every form control on login, register and the payment page has an accessible name', async ({ page }) => {
  const u = await makeUser();
  const slug = await makeLink(u.id);
  for (const p of ['/login.html', '/register.html', `/${slug}`]) {
    await page.goto(p);
    const unnamed = await page.evaluate(() => [...document.querySelectorAll('input:not([type=hidden]), select, textarea, button')]
      .filter((e) => (e as HTMLElement).offsetParent !== null)
      .filter((e) => {
        const el = e as HTMLInputElement;
        const label = el.labels?.length || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || (el.tagName === 'BUTTON' && el.textContent?.trim()) || el.title;
        return !label;
      }).map((e) => `${e.tagName}#${e.id}`));
    expect(unnamed, p).toEqual([]);
  }
});
