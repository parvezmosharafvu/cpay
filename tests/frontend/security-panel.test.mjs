import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source=readFileSync(new URL('../../public/admin-security.js',import.meta.url),'utf8');
const tick=()=>new Promise((resolve)=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
class Element {
  constructor(tag) { this.tag=tag;this.children=[];this.dataset={};this.attrs={};this.disabled=false;this._text=''; }
  set textContent(text) { this._text=String(text);this.children=[]; }
  get textContent() { return this._text+this.children.map((n)=>typeof n==='string'?n:n.textContent).join(''); }
  set innerHTML(_) { throw new Error('Security UI must use text nodes'); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this._text='';this.children=[...nodes]; }
  setAttribute(key,value) { this.attrs[key]=value; }
  removeAttribute(key) { delete this.attrs[key]; }
}
function fixture(options={}) {
  const section=new Element('section'),calls=[],messages=[];
  const api={supported:()=>true,list:async()=> options.keys || [],register:async()=>{calls.push('register');return options.register?options.register():{};},remove:async(id)=>{calls.push(`remove:${id}`);}};
  if(options.list) api.list=options.list;
  const context={window:{cpayPasskey:api,cpayAuthFeatures:async()=>({passkeys:true}),cpayMfa:{strong:async()=>options.strong===true,promptPasskey:async()=>{calls.push('prompt');return options.confirmStrong===true;},factors:async()=>({verified:[]})},confirm:()=>{calls.push('confirm');return options.confirm!==false;},addEventListener(){}},document:{readyState:'loading',querySelector:()=>section,querySelectorAll:()=>[],createElement:(tag)=>new Element(tag),addEventListener(){}},location:{pathname:options.admin?'/admin.html':'/dashboard.html',hash:''},toast:(msg)=>messages.push(msg)};
  vm.runInNewContext(source,context);
  const all=(node=section)=>[node,...node.children.filter((n)=>typeof n!=='string').flatMap(all)];
  return {section,calls,messages,render:context.window.cpayAdminSecurity.render,all,add:()=>all().find((n)=>n.dataset.role==='add-passkey'),remove:()=>all().find((n)=>n.dataset.passkey)};
}

test('the final admin passkey cannot be removed, even via a direct handler call',async()=>{
  const f=fixture({admin:true,keys:[{id:'last',friendly_name:'Phone'}],strong:true});await f.render();
  assert.equal(f.remove().disabled,true);await f.remove().onclick();
  assert.deepEqual(f.calls,[]);
});

test('an additional passkey cannot be registered when strong confirmation is cancelled',async()=>{
  const f=fixture({keys:[{id:'one'}],strong:false,confirmStrong:false});await f.render();
  await f.add().onclick();
  assert.deepEqual(f.calls,['prompt']);
  assert.equal(f.add().disabled,false);
});

test('first-passkey registration remains available and concurrent actions cannot duplicate it',async()=>{
  const pending=deferred();const f=fixture({register:()=>pending.promise});await f.render();
  const add=f.add();const first=add.onclick();await tick();await add.onclick();
  await f.render(); // Navigation/refresh during a ceremony must not expose another action.
  assert.deepEqual(f.calls,['register']);
  assert.equal(add.disabled,true);
  pending.resolve({});await first;
  assert.equal(f.add().disabled,false);
});

test('removal still requires strong confirmation and explicit user confirmation',async()=>{
  const f=fixture({keys:[{id:'one'},{id:'two'}],strong:false,confirmStrong:true,confirm:false});await f.render();
  await f.remove().onclick();assert.deepEqual(f.calls,['prompt','confirm']);
  const allowed=fixture({keys:[{id:'one'},{id:'two'}],strong:true});await allowed.render();
  await allowed.remove().onclick();assert.deepEqual(allowed.calls,['confirm','remove:one']);
});

test('failed list reads expose a read-only refresh and no credential actions',async()=>{
  let fail=true;const f=fixture({list:async()=>{if(fail)throw new Error('offline');return [{id:'one'}];}});await f.render();
  assert.equal(f.add(),undefined);assert.match(f.section.textContent,/Refresh security to try again/);
  const retry=f.all().find((n)=>n.dataset.role==='refresh-security');fail=false;await retry.onclick();
  assert.ok(f.add());assert.deepEqual(f.calls,[]);
});

test('stale credential list responses cannot replace the latest panel',async()=>{
  const pending=deferred();let reads=0;
  const f=fixture({list:()=>++reads===1?pending.promise:Promise.resolve([{id:'latest',friendly_name:'Latest key'}])});
  const old=f.render();await tick();await f.render();
  pending.resolve([{id:'old',friendly_name:'Obsolete key'}]);await old;
  assert.match(f.section.textContent,/Latest key/);assert.doesNotMatch(f.section.textContent,/Obsolete key/);
  assert.equal(f.section.attrs['aria-busy'],undefined);
});

test('a failed registration restores controls and never retries the credential mutation',async()=>{
  const f=fixture({register:async()=>{throw new Error('offline');}});await f.render();
  await f.add().onclick();assert.deepEqual(f.calls,['register']);
  assert.equal(f.add().disabled,false);assert.match(f.messages.join(' '),/could not be completed/);
});
