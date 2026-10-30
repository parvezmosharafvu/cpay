import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const file=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');

test('checkout renders server-approved link amounts and note with DOM text only',()=>{
 const src=file('public/404.html');
 assert.match(src,/get_link_amount_options/);
 assert.match(src,/updateLinkAmountOptions\(opts\)/);
 assert.match(src,/linkMinAmount/);
 assert.match(src,/linkMaxAmount/);
 assert.match(src,/el\('linkNote'\)\.textContent = note/);
 assert.match(src,/elHost\.replaceChildren\(\)/);
 assert.match(src,/btn\.textContent = '\$'/);
 assert.match(src,/amount < linkMinAmount \|\| amount > linkMaxAmount/);
});
test('dashboard can create and edit guarded link options',()=>{
 const src=file('public/freelancer-desk.js');
 assert.match(src,/data-edit-amounts/);
 assert.match(src,/amountOptionsFields\('new'\)/);
 assert.match(src,/amountOptionsFields\('edit'\)/);
 assert.match(src,/saveLinkAmountOptions\(link\.id, options\)/);
 assert.match(src,/set_link_amount_options/);
 assert.match(src,/new Set\(chips\)\.size/);
});
test('both receiving routes guard the amount before provider creation',()=>{
 const platform=file('supabase/functions/create-invoice/index.ts');
 const direct=file('supabase/functions/direct-invoice/handler.ts');
 const lookup=file('supabase/functions/direct-invoice/index.ts');
 assert.match(platform,/checkLinkAmountCents\(amountCents, modeRow\)/);
 assert.match(platform,/select\("settlement_mode,min_usd,max_usd"\)/);
 assert.match(direct,/checkLinkAmountCents\(amountCents, link\)/);
 assert.match(lookup,/select\("settlement_mode,min_usd,max_usd"\)/);
});
