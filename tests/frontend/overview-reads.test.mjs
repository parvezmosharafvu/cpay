import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../../public/admin-home-live.js',import.meta.url),'utf8');
function reader(timer=setTimeout){const context=vm.createContext({setTimeout:timer,clearTimeout});vm.runInContext(source.slice(0,source.indexOf('// Live Overview')),context);return read=>context.overviewRead(read);}
test('overview preserves server read result',async()=>{const result={data:[{available:12}],error:null};assert.equal(await reader()(()=>result),result);});
test('overview captures transport failure without retry',async()=>{let calls=0;const result=await reader()(()=>{calls++;throw Error('offline')});assert.equal(result.error.message,'offline');assert.equal(calls,1);});
test('overview bounds hanging reads without retry',async()=>{let calls=0;const result=await reader(fn=>setTimeout(fn,0))(()=>{calls++;return new Promise(()=>{})});assert.equal(result.error.message,'Read timed out');assert.equal(calls,1);});
function overview(){
 const nodes={};
 const node=()=>({textContent:'',onclick:null,querySelector(selector){return this.children[selector] ||= node()},children:{}});
 const home={innerHTML:'',setAttribute(){},querySelectorAll(){return []},querySelector(){return nodes.spendable ||= node()}};
 const context=vm.createContext({setTimeout:()=>0,clearTimeout,document:{getElementById(id){return id==='home'?home:(nodes[id] ||= node())}},window:{},sb:{rpc:async()=>({data:null,error:{message:'offline'}}),from(){return {select(){return this},order(){return this},limit:async()=>({data:null,error:{message:'offline'}})}}},walletCall:()=>new Promise(()=>{}),escapeHtml:String,money:v=>'$'+Number(v||0),badge:String,when:String,accountTypeText:()=>'',deskEmpty:()=>'<p>empty</p>'});
 vm.runInContext(source,context);return {context,home};
}
test('overview renders failed boards while wallet remains unresolved',async()=>{const {context,home}=overview();await context.renderHomeLive();assert.match(home.innerHTML,/Summary unavailable/);assert.match(home.innerHTML,/Could not load this section/);assert.doesNotMatch(home.innerHTML,/\$0/);assert.match(home.innerHTML,/Loading wallet/);});
