import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {PNG} from 'pngjs';
import jsQR from 'jsqr';
import {merchant} from './merchant-fixture';
const qrLibrary=readFileSync('node_modules/qrcodejs/qrcode.min.js');
const integrity='sha384-'+createHash('sha384').update(qrLibrary).digest('base64');
const invoice='lnbc250u1'+'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(7); // Encoding fixture, not payable.
for(const width of [390,1440])for(const theme of ['keypad','classic','tile','focus','receipt','pulse','ledger','studio','boulevard','aurora'])test(`rendered QR roundtrip ${theme} ${width}px`,async({browser})=>{
 const context=await browser.newContext({viewport:{width,height:900},deviceScaleFactor:1});const page=await context.newPage();
 await merchant(page,theme,'new',false,invoice);
 await page.route('https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',route=>route.fulfill({contentType:'application/javascript',headers:{'access-control-allow-origin':'*'},body:qrLibrary}));
 await page.goto(`/invoice-cpay-v2.html?id=fixture-invoice&theme=${theme}`);
 await expect(page.locator('script[src*=qrcodejs]')).toHaveAttribute('integrity',integrity);
 await expect(page.locator('#qrcode')).toHaveAttribute('data-rendered','1');await expect(page.locator('.qr-fallback')).toHaveCount(0);await expect(page.locator('.qr-logo')).toBeVisible();
 await expect(page.locator('#invoiceText')).toHaveText(invoice);
 // Decode what is visibly rendered, including the central brand overlay and CSS scale.
 const image=PNG.sync.read(await page.locator('#qrcode').locator('..').screenshot());
 const decoded=jsQR(new Uint8ClampedArray(image.data),image.width,image.height);
 expect(decoded?.data).toBe(invoice);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);await context.close();
});
