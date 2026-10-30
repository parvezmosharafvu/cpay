import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const load = p => readFileSync(new URL('../../'+p,import.meta.url),'utf8');

test('fresh rebuild checkout has standalone original pages and all required states',()=>{
 const html=load('public/v2-pay.html');
 for(const id of ['loading','entry','invoice','success','expired','unavailable','chips','qr','cashApp','wallet','countdown','bolt11'])
   assert.match(html,new RegExp('id="'+id+'"'));
 assert.match(html,/v2-pay\.css/);
 assert.match(html,/v2-pay\.js/);
 assert.match(html,/qrcode\.min\.js" integrity="sha384-/);
});
test('fresh frontend uses v2-only RPC and LND-only Edge function, not legacy invoice engines',()=>{
 const js=load('public/v2-pay.js'),edge=load('supabase/functions/v2-payments/index.ts');
 assert.match(js,/v2_public_link/);
 assert.match(js,/v2-payments/);
 assert.match(js,/cash\.app\/launch\/lightning\//);
 assert.match(js,/encodeURIComponent\(invoice\.bolt11\)/);
 assert.match(js,/LIGHTNING:.*invoice\.bolt11\.toUpperCase\(\)/);
 assert.match(js,/document\.hidden\?10000:3000/);
 assert.match(js,/cashApp.*href/);
 assert.match(js,/textContent=link\.note/);
 assert.doesNotMatch(edge,/btcpay|blink|breez/i);
 assert.doesNotMatch(js,/create-invoice|direct-invoice|btcpay|blink|breez/i);
});
test('server enforces two separate launch gates and LND confirmed settlement',()=>{
 const edge=load('supabase/functions/v2-payments/index.ts');
 const sql=load('supabase/migrations/20261030040000_v2_lnd_only_foundation.sql');
 assert.match(edge,/PAYLINK_V2_ENABLED/);
 assert.match(edge,/v2_settings/);
 assert.match(edge,/checkout_enabled/);
 assert.match(edge,/verifyHuman/);
 assert.match(edge,/v2_claim_rate/);
 assert.match(edge,/v2_reconcile_invoice/);
 assert.match(sql,/p_paid_sats<v\.amount_sats/);
 assert.match(sql,/v\.status<>'pending'/);
 assert.match(sql,/v2_invoice_request_unique/);
 assert.doesNotMatch(sql,/drop table.*payments\b/i);
});
test('LND has only invoices create and read endpoints, with no unsafe macaroon',()=>{
 const lnd=load('supabase/functions/_shared/lnd-v2.ts');
 assert.match(lnd,/\/v1\/invoices/);
 assert.match(lnd,/\/v1\/invoice\//);
 assert.match(lnd,/private:false/);
 assert.match(lnd,/expiry:"3600"/);
 assert.match(lnd,/CF-Access-Client-Secret/);
 assert.match(lnd,/Grpc-Metadata-macaroon/);
 assert.doesNotMatch(lnd,/\/v1\/payments|\/v1\/channels|SendPayment|SendCoins/);
});
