import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read=(name)=>readFileSync(new URL(`../../public/${name}`,import.meta.url),'utf8');
const tick=()=>new Promise((resolve)=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise((r)=>{resolve=r;});return {promise,resolve};};
function fixture(reply) {
  const calls=[],events={},closeButton={},retryButton={},message={outerHTML:''};
  const dialog={open:false,innerHTML:'',addEventListener:(name,fn)=>{events[name]=fn;},querySelector:(selector)=>selector==='p'?message:selector==='[data-payment-retry]'?retryButton:closeButton,
    showModal(){this.open=true;},close(){this.open=false;events.close();},setAttribute(){}};
  const opener={isConnected:true,focused:false,focus(){this.focused=true;}};
  const context=vm.createContext({window:{supabaseClient:{rpc:async(name,params)=>{calls.push({name,params});return reply(params.p_payment_id);}}},document:{activeElement:opener,createElement:()=>dialog,body:{appendChild(){}}}});
  vm.runInContext(read('app.js'),context);
  vm.runInContext(read('desk-locations.js'),context);
  return {api:context.window.cpayLoc,dialog,message,retryButton,opener,calls};
}
const payment=(name)=>({data:{you_receive:12,amount_requested:15,status:'settled',invoice_ref:name,created_at:'2026-10-21T00:00:00Z',settled_at:'2026-10-21T00:01:00Z',forward:{status:'forwarded',kind:'lightning',forwarded_at:'2026-10-21T00:02:00Z'}}});

test('a newer payment detail request supersedes an older response',async()=>{
  const old=deferred();const f=fixture((id)=>id==='old'?old.promise:payment('latest-reference'));
  const first=f.api.openPayment('old');await tick();
  await f.api.openPayment('new');
  assert.match(f.dialog.innerHTML,/latest-reference/);
  assert.match(f.dialog.innerHTML,/payment-timeline/);
  old.resolve(payment('obsolete-reference'));await first;
  assert.doesNotMatch(f.dialog.innerHTML,/obsolete-reference/);
  assert.match(f.dialog.innerHTML,/latest-reference/);
});

test('closing a loading dialog restores focus and prevents its late response from updating it',async()=>{
  const pending=deferred();const f=fixture(()=>pending.promise);
  const reading=f.api.openPayment('one');await tick();
  const loading=f.dialog.innerHTML;f.dialog.close();
  assert.equal(f.opener.focused,true);
  pending.resolve(payment('late'));await reading;
  assert.equal(f.dialog.open,false);
  assert.equal(f.dialog.innerHTML,loading);
});

test('detail read errors stay escaped and retry the same read-only endpoint',async()=>{
  let fail=true;const f=fixture(()=>fail?{error:{message:'<img> network error'}}:payment('recovered'));
  await f.api.openPayment('one');
  assert.match(f.message.outerHTML,/&lt;img&gt;/);
  assert.match(f.message.outerHTML,/data-payment-retry/);
  fail=false;await f.retryButton.onclick();
  assert.match(f.dialog.innerHTML,/recovered/);
  assert.equal(f.calls.length,2);
  assert.ok(f.calls.every((c)=>c.name==='get_my_payment_details'&&c.params.p_payment_id==='one'));
});

test('a detail button inside a clickable row opens only once for keyboard or pointer input',async()=>{
  const f=fixture(()=>payment('one'));
  const row={dataset:{payId:'one'}},button={dataset:{payId:'one'}};
  f.api.bindPaymentRows({querySelectorAll:()=>[row,button]});
  let prevented=false;const event={target:button,key:'Enter',preventDefault(){prevented=true;}};
  button.onkeydown(event);row.onkeydown(event);await tick();
  assert.equal(prevented,true);assert.equal(f.calls.length,1);
  let stopped=false;button.onclick({stopPropagation(){stopped=true;}});await tick();
  assert.equal(stopped,true);assert.equal(f.calls.length,2);
});
