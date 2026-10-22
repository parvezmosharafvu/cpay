import {test,expect} from '@playwright/test';
import {mockDesk} from './desk-fixture';
for(const role of ['creator','admin'] as const)for(const width of [390,1440])for(const lang of ['en','bn']){
 test(`${role} ${lang} ${width}px navigation and section layout`,async({browser})=>{
  const context=await browser.newContext({viewport:{width,height:900}});const page=await context.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await mockDesk(page,role,lang);
  await page.goto(role==='admin'?'/admin.html':'/dashboard.html',{waitUntil:'load'});
  await expect(page.locator('#home .card').first()).toBeVisible();
  if(lang==='bn') expect(await page.evaluate(async()=> (await document.fonts.load('400 16px "Noto Sans Bengali"','বাংলা')).length)).toBeGreaterThan(0);
  await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:test.info().outputPath('home.png'),fullPage:true});
  const tabs=role==='admin'?['home','people','apps','payouts','health','system','audit','receipts','settings']:['home','links','pay','cash','chat','profile','security'];
  for(const tab of tabs){
   const nav=page.locator(`.side .navi[data-tab="${tab}"]`);
   if(width<=900 && !await page.locator('.shell').evaluate(el=>el.classList.contains('nav-open'))) await page.locator('[data-nav-open]:visible').first().click();
   await nav.click();await expect(page.locator('main > section:visible')).toHaveAttribute('id',tab);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth),tab).toBeLessThanOrEqual(width);
  }
  if(role==='admin'){const save=await page.locator('[data-ps-key="legal_entity_name"]').boundingBox();const card=await page.locator('[data-ps-key="legal_entity_name"]').evaluate(el=>{const r=el.closest('.card')!.getBoundingClientRect();return {left:r.left,right:r.right}});expect(save!.x).toBeGreaterThanOrEqual(card.left);expect(save!.x+save!.width).toBeLessThanOrEqual(card.right);}
  await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:test.info().outputPath('desk.png'),fullPage:true});
  if(lang==='bn')await expect(page.locator('html')).toHaveAttribute('lang','bn');
  expect(errors).toEqual([]);
  await context.close();
 });
}
for(const role of ['creator','admin'] as const)test(`${role} failed read retains section and retry`,async({page})=>{
 await mockDesk(page,role,'en',true);await page.goto(role==='admin'?'/admin.html':'/dashboard.html');
 if(role==='creator'){await expect(page.locator('#home')).toContainText('Fixture read unavailable');await expect(page.locator('#home [data-read-retry]')).toBeVisible()}
 else {await page.locator('.navi[data-tab="system"]').click();await expect(page.locator('#system')).toContainText('Alerts unavailable');await expect(page.locator('#systemRefresh')).toBeVisible()}
});
