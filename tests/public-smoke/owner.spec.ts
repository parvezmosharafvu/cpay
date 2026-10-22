import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {mockDesk} from './desk-fixture';
const guide=JSON.parse(readFileSync('supabase/functions/owner-guide/guide.ts','utf8').split('export const GUIDE_HTML: string = ')[1].trim().replace(/;$/,''));
const ready={protected:['SUPABASE_SERVICE_ROLE_KEY'],supabase:{ready:true,secrets:['SUPABASE_SERVICE_ROLE_KEY','CRON_SECRET','LONG_FIXTURE_SECRET_'+'X'.repeat(70)]},cloudflare:{ready:true,secrets:[]},always_https:{ready:true,on:true}};
for(const width of [390,1440])for(const lang of ['en','bn'])for(const state of ['ready','setup','denied','stepup']){
 test(`owner settings ${state} ${lang} ${width}px`,async({browser})=>{
  const context=await browser.newContext({viewport:{width,height:900}});const page=await context.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  const response=state==='ready'?{data:ready,error:null}:state==='setup'?{data:{supabase:{ready:false,missing:['CPAY_SUPABASE_ACCESS_TOKEN']},cloudflare:{ready:false,missing:['CPAY_CLOUDFLARE_API_TOKEN']},always_https:{ready:false,missing:['CPAY_CLOUDFLARE_ZONE_ID']}},error:null}:{data:null,error:{message:'Fixture owner access denied',code:state==='stepup'?'aal2_required':'owner_only'}};
  await mockDesk(page,'admin',lang,false,false,{'owner-config':response});await page.goto('/admin.html#settings');
  const host=page.locator('#ownerSecrets');await expect(host.locator('.card').first()).toBeVisible();
  if(state==='ready'){
   await expect(host).toContainText('LONG_FIXTURE_SECRET_');await expect(host.locator('input[type=password]')).toHaveCount(2);
   for(const input of await host.locator('input[type=password]').all())await expect(input).toHaveValue('');
   await expect(host).toContainText(lang==='en'?'Protected':'সুরক্ষিত');
   await expect(page.locator('#ownerCloudflare input[role=switch]')).toBeChecked();
  }else if(state==='setup')await expect(host).toContainText('CPAY_SUPABASE_ACCESS_TOKEN');
  else if(state==='stepup')await expect(host).toContainText(lang==='en'?'passkey':'পাসকি');
  else await expect(host).toContainText('Fixture owner access denied');
  await page.evaluate(()=>document.fonts.ready);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);expect(errors).toEqual([]);await context.close();
 });
}
for(const width of [390,1440])test(`owner generated Bangla guide ${width}px keyboard jump and refresh`,async({browser})=>{
 const context=await browser.newContext({viewport:{width,height:900}});const page=await context.newPage();
 await mockDesk(page,'admin','bn',false,false,{'owner-config':{data:ready,error:null},'owner-guide':{data:{html:guide},error:null}});
 await page.goto('/admin.html#guide');await expect(page.locator('#guideJump')).toBeVisible();
 expect(await page.locator('#guideJump option').count()).toBeGreaterThan(5);await page.locator('#guideJump').selectOption({index:2});await expect(page.locator('#guide-section-1')).toBeFocused();
 await page.getByRole('button',{name:'গাইড রিফ্রেশ করুন',exact:true}).click();await expect(page.locator('#guideJump')).toBeVisible();await expect(page.locator('.guide-badges')).toContainText('CRON_SECRET');
 await page.evaluate(()=>document.fonts.ready);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);await context.close();
});
test('non-owner guide stays hidden',async({page})=>{await mockDesk(page,'admin','en');await page.goto('/admin.html#guide');await expect(page.locator('.navi[data-tab=guide]')).toBeHidden();await expect(page).toHaveURL(/#home$/)});
