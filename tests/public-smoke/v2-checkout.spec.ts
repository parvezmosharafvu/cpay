import {test,expect} from '@playwright/test';

test('fresh v2 checkout: amount → LND invoice → Cash App link → confirmed success',async({page})=>{
 let creates=0,statusReads=0;
 await page.route('**/config.js',route=>route.fulfill({contentType:'text/javascript',body:
  'window.SUPABASE_URL="https://v2-gateway.example.test";window.CPAY_TURNSTILE_SITE_KEY="test";window.supabaseClient={rpc:async(name)=>name==="v2_public_link"?{data:[{slug:"v2-shop",display_name:"Independent Studio",note:"Service work",min_usd:10,max_usd:1000,quick_amounts:[10,25,50]}],error:null}:{error:{message:"No such RPC"}}};'
 }));
 await page.route('**/turnstile.js',route=>route.fulfill({contentType:'text/javascript',body:
  'window.cpayTurnstileToken=async()=>"mock-human-token";'
 }));
 await page.route('https://v2-gateway.example.test/**',async route=>{
  const url=new URL(route.request().url());
  if(url.searchParams.get('action')==='create'){
   creates++;
   const body=route.request().postDataJSON();
   expect(body).toMatchObject({slug:'v2-shop',amount:'25.00',turnstileToken:'mock-human-token'});
   return route.fulfill({contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},
    body:JSON.stringify({id:'d4400000-0000-4000-8000-000000000001',status:'pending',bolt11:'lnbc100n1fakenoactualpayment',
     amount_usd:25,amount_sats:25000,expires_at:new Date(Date.now()+3600000).toISOString()})});
  }
  if(url.searchParams.get('action')==='status'){
   statusReads++;
   return route.fulfill({contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},
    body:JSON.stringify({status:statusReads>=2?'settled':'pending',amount_usd:25,settled_at:new Date().toISOString()})});
  }
  return route.abort();
 });
 await page.goto('/v2-pay.html?link=v2-shop');
 await expect(page.locator('#entry')).toBeVisible();
 await expect(page.locator('#merchant')).toHaveText('Pay Independent Studio');
 await expect(page.locator('#note')).toHaveText('Service work');
 await page.getByRole('button',{name:'$25.00'}).click();
 await expect(page.locator('#amount')).toHaveValue('25.00');
 await page.locator('#continueBtn').click();
 await expect(page.locator('#invoice')).toBeVisible();
 await expect(page.locator('#cashApp')).toHaveAttribute('href',/^https:\/\/cash\.app\/launch\/lightning\/lnbc/);
 await expect(page.locator('#success')).toBeVisible({timeout:18000});
 await expect(page.locator('#successAmount')).toHaveText('$25.00');
 expect(creates).toBe(1);
 expect(statusReads).toBeGreaterThanOrEqual(2);
});
