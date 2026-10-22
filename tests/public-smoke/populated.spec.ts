import {test,expect} from '@playwright/test';import {mockDesk} from './desk-fixture';
for(const role of ['creator','admin'] as const)for(const width of [390,1440])test(`populated ${role} ${width}px long references`,async({browser})=>{
 const context=await browser.newContext({viewport:{width,height:900}});const page=await context.newPage();await mockDesk(page,role,'en',false,true);await page.goto(role==='admin'?'/admin.html':'/dashboard.html');await expect(page.locator('#home .card').first()).toBeVisible();
 const tab=role==='admin'?'payouts':'links';if(width<=900)await page.locator('[data-nav-open]:visible').first().click();await page.locator(`.side .navi[data-tab="${tab}"]`).click();await expect(page.locator('#'+tab+' table tbody tr').first()).toContainText(role==='admin'?'42':'Long project');
 if(role==='admin'){await page.locator('#payouts summary').first().click();await expect(page.locator('#payouts')).toContainText('full-provider-reference-');await expect(page.locator('#payouts img')).toHaveCount(0);if(width<=900)expect(await page.locator('#payouts .scroll').evaluate(el=>el.scrollWidth-el.clientWidth)).toBeLessThanOrEqual(1)}
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);await page.screenshot({path:test.info().outputPath('populated.png'),fullPage:true});await context.close();
});
