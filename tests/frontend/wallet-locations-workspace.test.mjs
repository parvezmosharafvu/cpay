import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const read=n=>readFileSync(new URL('../../public/'+n,import.meta.url),'utf8');
const tick=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
function fixture(){
 const nodes=new Map();
 function node(){return {value:'',innerHTML:'',textContent:'',disabled:false,dataset:{},children:[],style:{},setAttribute(k,v){this[k]=v},append(...kids){this.children.push(...kids)},replaceChildren(...kids){this.children=kids},querySelector(){return null},querySelectorAll(){return []},addEventListener(){}}}
 const get=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id)};
 const document={readyState:'loading',getElementById:get,createElement:node,createTextNode:text=>({textContent:text}),addEventListener(){}};
 const context=vm.createContext({window:{},document,setTimeout,clearTimeout,location:{hash:''},Intl,MutationObserver:class{}});
 vm.runInContext(read('app.js'),context);context.toast=()=>{};return {get,context};
}
test('wallet failed refresh clears old balances and does not present unknown owed as zero',async()=>{
 const f=fixture();vm.runInContext(read('admin-wallet.js'),f.context);
 f.context.walletCall=async()=>({balanceSats:300,owedToCreatorsUsd:null,spendableSat:200});await f.context.loadInfo();assert.equal(f.get('wbOwed').textContent,'—');
 f.context.walletCall=async()=>{throw Error('offline')};await f.context.loadInfo();assert.equal(f.get('wbSats').textContent,'—');assert.equal(f.get('wbSpend').textContent,'—');assert.match(f.get('walletReadStatus').textContent,/unavailable/);
});
test('wallet ignores old balance responses',async()=>{
 const f=fixture();vm.runInContext(read('admin-wallet.js'),f.context);const old=deferred();let n=0;f.context.walletCall=()=>++n===1?old.promise:Promise.resolve({balanceSats:222});
 const first=f.context.loadInfo();await f.context.loadInfo();old.resolve({balanceSats:111});await first;assert.match(f.get('wbSats').textContent,/222/);
});
test('wallet history rejects stale pagination results',async()=>{
 const f=fixture();vm.runInContext(read('admin-wallet.js'),f.context);const old=deferred();let n=0;f.context.walletCall=()=>++n===1?old.promise:Promise.resolve({payments:[],hasMore:false});
 const first=f.context.loadHistory();await f.context.loadHistory();old.resolve({payments:[{amountSat:12345,type:'send',status:'complete'}],hasMore:true});await first;
 assert.match(f.get('whRows').innerHTML,/No payments yet/);assert.equal(f.get('whNext').disabled,true);
});
function locations(rpc){const f=fixture();f.context.window.supabaseClient={rpc};vm.runInContext(read('admin-locations.js').replace(/\}\)\(\);\s*$/,'window.locationTest={render,state,draft};})();'),f.context);f.api=f.context.window.locationTest;return f}
test('location filters validate country, normalize inputs and retain drafts after read errors',async()=>{
 const calls=[];const f=locations(async(name,params)=>{calls.push(params);return {error:{message:'offline'}}});await f.api.render();
 f.get('locFCountry').value='1';f.get('locFArea').value=' Dhaka ';f.get('locFDays').value='90';f.get('locFApply').onclick();assert.equal(calls.length,1);assert.match(f.get('locFStatus').textContent,/two-letter/);
 f.get('locFCountry').value='bd';f.get('locFApply').onclick();await tick();assert.equal(calls[1].p_country,'BD');assert.equal(calls[1].p_area,'Dhaka');assert.equal(calls[1].p_days,90);assert.match(f.get('adminLocations').innerHTML,/value="BD"/);
});
test('location stale reads cannot replace newer results and clear resets scope',async()=>{
 const old=deferred();let n=0;const f=locations(async()=>++n===1?old.promise:{data:{users:[{display_name:'New result'}]}});const first=f.api.render();await f.api.render();old.resolve({data:{users:[{display_name:'Old result'}]}});await first;assert.match(f.get('adminLocations').innerHTML,/New result/);assert.doesNotMatch(f.get('adminLocations').innerHTML,/Old result/);
 f.get('locFClear').onclick();await tick();assert.equal(f.api.state.days,30);assert.equal(f.api.state.country,'');
});
function registry(invoke,withHost=false){const f=fixture();f.context.document.getElementById=id=>id==='walletRegistry'&&!withHost?null:f.get(id);f.context.window.supabaseClient={functions:{invoke}};vm.runInContext(read('admin-wallets.js').replace(/\}\)\(\);\s*$/,'window.registryTest={act1,remove,load,state};})();'),f.context);return f}
test('wallet registry serializes uncertain mutations without retry',async()=>{
 const pending=deferred();let calls=0;const f=registry(()=>{calls++;return pending.promise});const messages=[];f.context.window.toast=text=>messages.push(text);const api=f.context.window.registryTest;
 const first=api.act1({action:'rename',id:'a',label:'New'});await api.act1({action:'set_primary',id:'b'});assert.equal(calls,1);pending.resolve({error:{}});await first;assert.equal(calls,1);
 await api.act1({action:'rename',id:'a',label:'Again'});assert.equal(calls,2);
});
test('wallet registry removal retains exact-name and passkey cancellation guards',async()=>{
 let calls=0;const f=registry(async()=>{calls++;return {data:{}}});f.context.window.prompt=()=> 'Wallet';f.context.window.cpayMfa={promptPasskey:async()=>false};await f.context.window.registryTest.remove({id:'a',label:'Wallet'});assert.equal(calls,0);
});
test('registry ignores old list responses and reports failed refresh',async()=>{
 const old=deferred();let n=0;const f=registry(async()=>++n===1?old.promise:{data:{wallets:[],total_balance_sat:222}},true);const api=f.context.window.registryTest;
 const first=api.load();await api.load();old.resolve({data:{wallets:[],total_balance_sat:111}});await first;assert.equal(api.state.data.total_balance_sat,222);
 f.context.window.supabaseClient.functions.invoke=async()=>{throw Error('offline')};await api.load();assert.equal(api.state.data,null);const strings=n=>[n.textContent,...(n.children||[]).flatMap(strings)].join(' ');assert.match(strings(f.get('walletRegistry')),/Wallets did not load/);assert.match(strings(f.get('walletRegistry')),/Refresh wallets/);
});
