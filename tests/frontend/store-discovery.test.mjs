import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../../public/store.html',import.meta.url),'utf8');
const script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
async function store(rpc){
 const elements={};const document={getElementById(id){return elements[id] ||= {value:'',textContent:'',innerHTML:'',style:{},hidden:false,classList:{remove(){}},appendChild(){}}},documentElement:{style:{setProperty(){}}}};
 const context=vm.createContext({window:{supabaseClient:{rpc}},location:{search:'?u=merchant',href:'https://example.test/store?u=merchant'},navigator:{clipboard:{writeText:async()=>{throw Error('blocked')}}},URLSearchParams,document,setTimeout,clearTimeout,useNavyState(){},setDesign(){}});
 vm.runInContext(script,context);await new Promise(resolve=>setImmediate(resolve));return {elements,context};
}
test('store transport failure offers an explicit read-only retry',async()=>{let calls=0;const {elements}=await store(async()=>{calls++;throw Error('offline')});assert.equal(elements['store-retry'].hidden,false);assert.match(elements.state.textContent,/Could not load/);await elements['store-retry'].onclick();assert.equal(calls,2);});
test('store search filters name and slug, escapes merchant content',async()=>{const {elements}=await store(async()=>({data:[{display_name:'Shop',links:[{display_name:'<b>Work</b>',slug:'work'},{display_name:'Design',slug:'visual'}]}]}));assert.match(elements.grid.innerHTML,/&lt;b&gt;Work/);elements['store-search'].value='VISUAL';elements['store-search'].oninput();assert.match(elements.grid.innerHTML,/Design/);assert.doesNotMatch(elements.grid.innerHTML,/Work/);elements['store-search'].value='missing';elements['store-search'].oninput();assert.match(elements.state.textContent,/No matching/);});
test('store share failure explains how to copy manually',async()=>{const {elements}=await store(async()=>({data:[{display_name:'Shop',links:[]}]}));await elements.share.onclick();assert.match(elements['share-status'].textContent,/address bar/);assert.equal(elements.share.disabled,false);});
