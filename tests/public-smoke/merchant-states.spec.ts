import {test,expect} from '@playwright/test';
import {merchant} from './merchant-fixture';
for(const width of [390,1440])for(const theme of ['keypad','classic','tile','focus','receipt','pulse','ledger','studio','boulevard','aurora'])test(`merchant ${theme} ${width}px amount and invoice fallback`,async({browser})=>{
 const context=await browser.newContext({viewport:{width,height:900}});const page=await context.newPage();await merchant(page,theme);
 await page.goto('/fixture-design?amount=25');await expect(page.locator('#paymentCard')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
 await page.goto(`/invoice-cpay-v2.html?id=fixture-invoice&theme=${theme}`);await expect(page.locator('#step2')).toBeVisible();await expect(page.locator('#amountDue')).toHaveText('$25.00');await expect(page.locator('#qrcode .qr-fallback')).toContainText('lnbc1fixtureonlynotpayable');await expect(page.locator('.qr-logo')).toBeHidden();const notice=await page.locator('#toast').boundingBox();expect(notice!.height).toBeLessThanOrEqual(120);expect(notice!.width).toBeLessThanOrEqual(width-16);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
 if(theme==='ledger'||theme==='focus')await page.screenshot({path:test.info().outputPath('invoice.png'),fullPage:true});await context.close();
});
for(const status of ['pending','settled','expired','invalid'])test(`invoice ${status} uses server state`,async({page})=>{
 await merchant(page,'keypad',status);await page.goto('/invoice-cpay-v2.html?id=fixture-invoice');
 if(status==='pending'){await expect(page.locator('#statusChip')).toHaveAttribute('data-state','detected');await expect(page.locator('#payBtn')).toBeDisabled()}
 else if(status==='settled'){await expect(page.locator('#step3')).toBeVisible();await expect(page.locator('#successAmount')).toHaveText('$25.00')}
 else await expect(page.locator('#stateTitle')).toContainText(status==='expired'?'expired':'could not be completed');
});
test('store success searches escaped payment options without creating an invoice',async({page})=>{await merchant(page,'aurora');await page.goto('/store.html?u=fixture');await expect(page.locator('#grid article')).toHaveCount(2);await expect(page.locator('#grid img')).toHaveCount(0);await page.locator('#store-search').fill('consult');await expect(page.locator('#grid article')).toHaveCount(1);await page.locator('#store-search').fill('missing');await expect(page.locator('#state')).toContainText('No matching');});
test('store read failure offers retry',async({page})=>{await merchant(page,'focus','new',true);await page.goto('/store.html?u=fixture');await expect(page.locator('#store-retry')).toBeVisible();await expect(page.locator('#state')).toContainText('Could not load');});
