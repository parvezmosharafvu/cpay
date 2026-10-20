import { test, expect } from '@playwright/test';
import { makeUser, makeLink, expectCleanCopy, db } from './helpers';

test('an active slug opens the payment card with the link name', async ({ page }) => {
  const u = await makeUser();
  const slug = await makeLink(u.id, { name: 'Lake Studio' });
  await page.goto(`/${slug}`);
  await expect(page.locator('#paymentCard')).toBeVisible();
  await expect(page.locator('#merchantName')).toHaveText('Lake Studio');
  await expect(page).toHaveTitle(/Pay Lake Studio/);
  await expectCleanCopy(page);
});

test('a trailing slash resolves to the same link', async ({ page }) => {
  const u = await makeUser();
  const slug = await makeLink(u.id, { name: 'Slash Ok' });
  await page.goto(`/${slug}/`);
  await expect(page.locator('#merchantName')).toHaveText('Slash Ok');
});

for (const path of ['/no-such-link-xyz', '/admin-not-a-page', '/moderator', '/reseller', '/store.x']) {
  test(`unknown or reserved path ${path} shows not found`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator('#notFoundCard')).toBeVisible();
    await expect(page.locator('#paymentCard')).toBeHidden();
  });
}

test('a disabled link shows not found', async ({ page }) => {
  const u = await makeUser();
  const slug = await makeLink(u.id, { active: false });
  await page.goto(`/${slug}`);
  await expect(page.locator('#notFoundCard')).toBeVisible();
});

test('a link of a suspended Freelancer does not take payments', async ({ page }) => {
  const u = await makeUser();
  const slug = await makeLink(u.id);
  await db.query(`update profiles set account_status = 'suspended' where id = $1`, [u.id]);
  await page.goto(`/${slug}`);
  // Either not found, or the server refuses the invoice; never a payment request.
  if (await page.locator('#paymentCard').isVisible()) {
    await expect(page.locator('#payBtn')).toBeEnabled();
    await page.keyboard.type('5');
    await page.click('#payBtn');
    await expect(page.locator('#statusMsg')).toBeVisible();
    await expect(page).not.toHaveURL(/[?&]id=/);
  } else {
    await expect(page.locator('#notFoundCard')).toBeVisible();
  }
});

test('a lookup outage offers retry instead of not found', async ({ page }) => {
  const u = await makeUser();
  const slug = await makeLink(u.id);
  await page.route('**/rest/v1/rpc/get_link_preview', (r) => r.abort('failed'));
  await page.goto(`/${slug}`);
  await expect(page.locator('#loadErrorCard')).toBeVisible();
  await expect(page.locator('#loadRetryBtn')).toBeVisible();
});
