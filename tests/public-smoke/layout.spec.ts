import {test, expect} from '@playwright/test';
for (const width of [390,1440]) {
  for (const path of ['/', '/login.html', '/register.html', '/store.html']) {
    test(`layout ${width}px ${path}`,async({browser})=>{
      const context=await browser.newContext({viewport:{width,height:900}});
      // Source/layout check in isolation: no production API or third-party font requests.
      await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
      const page=await context.newPage();await page.goto(path,{waitUntil:'load'});
      await expect(page.locator('body')).toBeVisible();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.keyboard.press('Tab');await expect(page.locator('.skip-link')).toBeFocused();
      const outline=await page.locator('.skip-link').evaluate(el=>getComputedStyle(el).outlineStyle);
      expect(outline).not.toBe('none');
      if (path.includes('login') || path.includes('register')) await expect(page.locator('main.auth-card')).toHaveCSS('opacity','1');
      await page.screenshot({path:test.info().outputPath('layout.png'),fullPage:true});
      await context.close();
    });
  }
}
