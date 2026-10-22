import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {mockDesk} from './desk-fixture';
for(const role of ['creator','admin'] as const)for(const width of [390,1440])test(`accessibility ${role} ${width}px overview`,async({browser})=>{
 const context=await browser.newContext({viewport:{width,height:900}});const page=await context.newPage();await mockDesk(page,role,'en');await page.goto(role==='admin'?'/admin.html':'/dashboard.html');await expect(page.locator('#home .card').first()).toBeVisible();await expect(page.locator('#home .desk-skel')).toHaveCount(0);
 const results=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
 expect(results.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}))).toEqual([]);await context.close();
});
for(const path of ['/login.html','/register.html'])test(`accessibility authentication ${path}`,async({browser})=>{
 const context=await browser.newContext();const page=await context.newPage();await context.route('**/*',route=>{const u=new URL(route.request().url());if(u.hostname!=='127.0.0.1')return route.abort();if(u.pathname==='/config.js')return route.fulfill({contentType:'text/javascript',body:'window.supabaseClient={auth:{getSession:async()=>({data:{session:null}})}};'});return route.continue()});await page.goto(path);await expect(page.locator('main.auth-card')).toHaveCSS('opacity','1');
 const results=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(results.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}))).toEqual([]);await context.close();
});
for(const role of ['creator','admin'] as const)for(const width of [390,1440])for(const lang of ['en','bn'])test(`accessibility ${role} ${lang} ${width}px section forms and lists`,async({browser})=>{
 test.setTimeout(120_000);
 const context=await browser.newContext({viewport:{width,height:900}});const page=await context.newPage();await mockDesk(page,role,lang,false,true);await page.goto(role==='admin'?'/admin.html':'/dashboard.html');await expect(page.locator('#home .card').first()).toBeVisible();
 await expect(page.locator('html')).toHaveAttribute('lang',lang);
 const tabs=role==='admin'?['people','apps','payouts','health','system','audit','receipts','settings']:['links','pay','cash','chat','profile','security'];
 const violations:any[]=[];
 for(const tab of tabs){
  if(width<=900&&!await page.locator('.shell').evaluate(el=>el.classList.contains('nav-open')))await page.locator('[data-nav-open]:visible').first().click();
  await page.locator(`.side .navi[data-tab="${tab}"]`).click();await expect(page.locator('main > section:visible')).toHaveAttribute('id',tab);await page.evaluate(()=>document.fonts.ready);
  const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  violations.push(...result.violations.map(v=>({tab,id:v.id,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))})));
 }
 expect(violations).toEqual([]);await context.close();
});
test('admin wide table scrolls with keyboard and leaves tab order when it fits',async({page})=>{
 await page.setViewportSize({width:390,height:900});await mockDesk(page,'admin','en');await page.goto('/admin.html#health');
 const region=page.locator('#health > .card.flush').first();await expect(region).toHaveAttribute('tabindex','0');await expect(region).toHaveAttribute('role','region');
 await region.focus();await expect(region).toBeFocused();await page.keyboard.press('ArrowRight');await expect.poll(()=>region.evaluate(el=>el.scrollLeft)).toBeGreaterThan(0);
 await page.setViewportSize({width:1440,height:900});await expect(region).not.toHaveAttribute('tabindex','0');
});
