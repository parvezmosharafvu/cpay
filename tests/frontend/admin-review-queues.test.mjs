import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const read=name=>readFileSync(new URL('../../public/'+name,import.meta.url),'utf8');
const later=()=>{let resolve;return {promise:new Promise(r=>{resolve=r}),resolve:v=>resolve(v)}};
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(rpc=async()=>({data:[]})) {
 const nodes=new Map(),calls=[];
 const camel=s=>s.replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
 function node(id='') {return {id,value:'',dataset:{},disabled:false,hidden:false,textContent:'',_html:'',children:[],set innerHTML(value){this._html=value;this.children=[];for(const tag of value.matchAll(/<(button|input|select|tr|p)\b([^>]*)>/g)){const n=node();for(const attr of tag[2].matchAll(/([\w-]+)="([^"]*)"/g)){const [_,key,val]=attr;if(key.startsWith('data-'))n.dataset[camel(key.slice(5))]=val;else n[key]=val}if(/\bdisabled\b/.test(tag[2]))n.disabled=true;if(n.id)nodes.set(n.id,n);this.children.push(n)}},get innerHTML(){return this._html},querySelectorAll(selector){const attrs=[...selector.matchAll(/\[data-([\w-]+)\]/g)].map(m=>camel(m[1]));return this.children.filter(c=>attrs.some(a=>a in c.dataset));},querySelector(selector){return this.querySelectorAll(selector)[0]||node()},setAttribute(){},addEventListener(event,fn){this['on'+event]=fn},click(){return this.onclick?.()},insertBefore(){}};}
 const get=id=>{if(!nodes.has(id))nodes.set(id,node(id));return nodes.get(id)};
 const sb={rpc:async(name,params)=>{calls.push({name,params});return rpc(name,params)},from(){const q={select(){return q},order(){return q},limit(){return rpc('withdrawals')}};return q}};
 const document={getElementById:get,querySelectorAll:selector=>[...nodes.values()].flatMap(n=>n.querySelectorAll(selector)),addEventListener(){}};
 const context=vm.createContext({window:{supabaseClient:sb,confirm:()=>true,prompt:()=>null},sb,document,setTimeout,clearTimeout,location:{hash:''},people:[],toast:()=>{},confirm:()=>true,prompt:()=>null});
 vm.runInContext(read('app.js'),context);context.toast=()=>{};
 const desk=read('admin-desk.js');vm.runInContext(desk.slice(desk.indexOf('let peopleFilter'),desk.indexOf('const FEE_SOURCE'))+'\nconst FEE_SOURCE={};',context);
 context.setTimeout=()=>0;vm.runInContext(read('admin-unify.js'),context);context.setTimeout=setTimeout;context.renderHome=()=>{};
 return {context,get,calls,loadForwards(){vm.runInContext(read('admin-forwards.js').replace(/\}\)\(\);\s*$/, 'window.forwardTest={render,act,batchAct};})();'),context);return context.window.forwardTest;}};
}

test('applications reads all statuses, renders history, and offers actions only on waiting rows',async()=>{
 const f=fixture(async name=>({data:name==='admin_list_account_applications'?[{id:'waiting',status:'pending',email:'new@example.test'},{id:'done',status:'approved',review_note:'<script>note</script>',reviewed_at:'2026-01-01'}]:[]}));
 await f.context.renderApps();assert.equal(f.calls.find(c=>c.name==='admin_list_account_applications').params.p_status,null);
 f.get('applicationClear').onclick();await tick();const html=f.get('apps').innerHTML;
 assert.match(html,/data-approve="waiting"/);assert.doesNotMatch(html,/data-approve="done"/);assert.match(html,/&lt;script&gt;note/);assert.match(html,/Review details/);
});
test('auto-approve switch shows the saved value, saves a change, and reverts on refusal',async()=>{
 let refuse=false;const f=fixture(async name=>name==='cpay_auto_approval_enabled'?{data:true}:name==='admin_set_auto_approval'?(refuse?{error:{message:'Sign in again with your passkey first, then change settings'}}:{data:null}):{data:[]});
 await f.context.renderApps();const sw=f.get('autoApprove');assert.match(f.get('apps').innerHTML,/id="autoApprove" checked/);
 sw.checked=false;await f.context.setAutoApproval(sw);assert.equal(JSON.stringify(f.calls.at(-1)),JSON.stringify({name:'admin_set_auto_approval',params:{p_role:'freelancer',p_enabled:false}}));assert.equal(sw.checked,false);
 refuse=true;sw.checked=true;await f.context.setAutoApproval(sw);assert.equal(sw.checked,false);assert.equal(sw.disabled,false);
});
test('application stale reads cannot replace a newer list',async()=>{
 const old=later();let n=0;const f=fixture(async()=>++n===1?old.promise:{data:[{id:'new',display_name:'New response',status:'pending'}]});
 const first=f.context.renderApps();await tick();await f.context.renderApps();old.resolve({data:[{display_name:'Old response',status:'pending'}]});await first;
 assert.match(f.get('apps').innerHTML,/New response/);assert.doesNotMatch(f.get('apps').innerHTML,/Old response/);
});
test('application review blocks opposite duplicate decision and recovers from failure',async()=>{
 const pending=later();const f=fixture(async name=>name==='admin_review_account_application'?pending.promise:{data:[{id:'a',status:'pending'}]});await f.context.renderApps();
 const first=f.context.review('a','approved');await f.context.review('a','rejected');assert.equal(f.calls.filter(c=>c.name==='admin_review_account_application').length,1);
 pending.resolve({error:{message:'offline'}});await first;assert.ok(f.get('apps').querySelectorAll('[data-approve], [data-reject]').every(b=>!b.disabled));
});
test('people optional reads fail visibly without losing primary accounts or filter draft',async()=>{
 const f=fixture(async name=>name==='admin_list_business_profiles'?{data:[{id:'u',display_name:'Alice',email:'a@example.test',role:'creator',account_status:'active'}]}:{error:{message:'offline'}});
 await f.context.renderPeople();assert.match(f.get('people').innerHTML,/Some account details are unavailable/);assert.match(f.get('people').innerHTML,/Alice/);assert.match(f.get('people').innerHTML,/Unavailable/);
 f.get('peopleSearch').oninput({target:{value:'Alice'}});await f.context.renderPeople();assert.match(f.get('people').innerHTML,/value="Alice"/);assert.match(f.get('people').innerHTML,/Account reference/);
});
test('failed primary account reads show read-only retry',async()=>{const f=fixture(async()=>{throw Error('offline')});await f.context.renderPeople();assert.match(f.get('people').innerHTML,/offline/);assert.match(f.get('people').innerHTML,/Refresh section/);});
test('payout details use actual note/reference fields and explain 120 request scope',async()=>{
 const f=fixture(async()=>({data:[{id:'wd',user_id:'owner',status:'failed',admin_note:'<bad>',payout_ref:'ref-123',amount_requested:10,method:'usdt'}]}));await f.context.renderPayouts();const html=f.get('payouts').innerHTML;
 assert.match(html,/latest 120 requests/);assert.match(html,/&lt;bad&gt;/);assert.match(html,/ref-123/);assert.match(html,/owner/);assert.doesNotMatch(html,/data-wd="wd"/);
});
test('payout action is serialized per request and retains original step-up payload',async()=>{
 const pending=later();const f=fixture(async()=>({data:[{id:'wd',status:'pending',amount_requested:10}]}));await f.context.renderPayouts();let action,stepups=0;
 f.context.adminFn=(path,body)=>{action={path,...body};return pending.promise};f.context.window.cpayWithStepUp=run=>{stepups++;return run()};
 const controls=f.get('payouts').querySelectorAll('[data-wd]');const first=controls[0].onclick();await controls[1].onclick();assert.equal(stepups,1);assert.equal(action.withdrawalId,'wd');assert.equal(action.action,'mark_paid_manual');
 pending.resolve({});await first;await tick();assert.ok(f.get('payouts').querySelectorAll('[data-wd]').every(b=>!b.disabled));
});
test('forward queue failure offers refresh and escapes read errors',async()=>{const f=fixture(async()=>{throw Error('<offline>')});const fw=f.loadForwards();await fw.render();assert.match(f.get('instantForwards').innerHTML,/&lt;offline&gt;/);assert.equal(typeof f.get('fwRefresh').onclick,'function');});
test('forward actions honor cancellation and never retry uncertain mutations',async()=>{
 const pending=later();const f=fixture(async name=>name==='admin_forward_action'?pending.promise:{data:{rows:[],counts:{},totals:{ok:true}}});const fw=f.loadForwards();
 f.context.window.confirm=()=>false;await fw.act('a','retry');assert.equal(f.calls.length,0);
 f.context.window.confirm=()=>true;const first=fw.act('a','retry');await fw.act('a','release');assert.equal(f.calls.length,1);pending.resolve({error:{message:'offline'}});await first;
 assert.match(f.get('fwFeedback').textContent,/could not be confirmed/);assert.equal(f.calls.length,1);
});
test('forward refresh ignores old results and retains diagnostic details',async()=>{
 const old=later();let n=0;const f=fixture(async()=>++n===1?old.promise:{data:{rows:[{id:'new',status:'owed',reason:'failed',last_error:'<timeout>',payment_id:'pay1'}],totals:{ok:true}}});const fw=f.loadForwards();const first=fw.render();await tick();await fw.render();old.resolve({data:{rows:[],totals:{ok:true}}});await first;
 const html=f.get('instantForwards').innerHTML;assert.match(html,/pay1/);assert.match(html,/&lt;timeout&gt;/);assert.match(html,/up to 200/);assert.match(html,/Next attempt/);
});
test('forward local error search does not issue another read or mutation',async()=>{
 const f=fixture(async()=>({data:{rows:[{id:'a',status:'owed',last_error:'timed out'},{id:'b',status:'queued',last_error:'address invalid'}],totals:{ok:true}}}));const fw=f.loadForwards();await fw.render();
 f.get('fwSearch').oninput({target:{value:'timed'}});const rows=f.get('instantForwards').querySelectorAll('[data-fw-search]');assert.equal(rows[0].hidden,false);assert.equal(rows[1].hidden,true);assert.equal(f.calls.length,1);assert.equal(f.get('fwCount').textContent,'1 / 2');
});
test('cancelled payout step-up never invokes the payout endpoint and restores controls',async()=>{
 const f=fixture(async()=>({data:[{id:'a',status:'pending',amount_requested:12}]}));await f.context.renderPayouts();let mutations=0;f.context.adminFn=async()=>{mutations++};f.context.window.cpayWithStepUp=async()=>{throw Error('Cancelled')};
 const controls=f.get('payouts').querySelectorAll('[data-wd]');await controls[0].onclick();assert.equal(mutations,0);assert.ok(controls.every(b=>!b.disabled));
});
