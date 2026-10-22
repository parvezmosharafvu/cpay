import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const read=(name)=>readFileSync(new URL(`../../public/${name}`,import.meta.url),'utf8');
function fixture(reply) {
  const nodes=new Map(),calls=[],timers=[];
  function node(id){if(!nodes.has(id))nodes.set(id,{hidden:true,dataset:{},attrs:{},value:'',writes:0,_text:'',set textContent(v){this._text=v;this.writes++;},get textContent(){return this._text;},setAttribute(k,v){this.attrs[k]=v;},querySelectorAll:()=>[],focus(){},classList:{toggle(){},add(){},remove(){}}});return nodes.get(id);}
  const document={visibilityState:'visible',getElementById:node,addEventListener(){}};
  const context={window:{CPAY_INVOICE_EMBEDDED:true,supabaseClient:{rpc:async(name,params)=>{calls.push({name,params});return reply();}}},document,navigator:{userAgent:''},sessionStorage:{removeItem(){}},setTimeout(fn,ms){timers.push(ms);return timers.length;},clearTimeout(){},setInterval(){return 1;},clearInterval(){}};
  // Test-only access to closure state; production exports remain { start }.
  const source=read('invoice-view.js').replace('window.cpayInvoice = { start };',"window.cpayInvoice = { start, test: {pollOnce, setStatus, updateStatusSync, receiptText, prepare(){finished=false;currentPaymentId='invoice-1';amountRequested=15;merchantName='Merchant';},finish(){finished=true;}} };");
  vm.runInNewContext(source,context);const api=context.window.cpayInvoice.test;api.prepare();
  return {api,node,calls,timers,document};
}

test('status read failure is connection feedback and never a paid or failed payment decision',async()=>{
  const f=fixture(()=>({error:{message:'offline'}}));f.api.setStatus('waiting');
  await f.api.pollOnce();
  assert.equal(f.node('statusSync').dataset.connection,'interrupted');
  assert.match(f.node('statusSync').textContent,/Check your wallet/);
  assert.equal(f.node('statusChip').dataset.state,'waiting');
  assert.equal(f.node('step3').hidden,true);
  assert.ok(f.timers.includes(3000));
  assert.ok(f.calls.every((call)=>call.name==='get_invoice_public'&&call.params.p_payment_id==='invoice-1'));
});

test('a recovered pending read restores connection feedback and keeps duplicate-pay handoffs disabled',async()=>{
  let offline=true;const f=fixture(()=>offline?{error:{message:'offline'}}:{data:[{status:'pending'}]});
  await f.api.pollOnce();offline=false;await f.api.pollOnce();
  assert.equal(f.node('statusSync').dataset.connection,'ok');
  assert.equal(f.node('statusChip').dataset.state,'detected');
  for(const id of ['payBtn','cashAppBtn','otherWalletsBtn'])assert.equal(f.node(id).disabled,true);
});

test('only a settled server response shows the receipt and its full original reference',async()=>{
  const f=fixture(()=>({data:[{status:'settled',amount_settled:15}]}));await f.api.pollOnce();
  assert.equal(f.node('step3').hidden,false);assert.equal(f.node('step2').hidden,true);
  assert.equal(f.node('successAmount').textContent,'$15.00');
  assert.match(f.api.receiptText(),/Confirmation seen/);
  assert.match(f.api.receiptText(),/invoice-1/);
  const count=f.calls.length;await f.api.pollOnce();assert.equal(f.calls.length,count);
});

test('unchanged connection feedback is not announced again on every poll',()=>{
  const f=fixture(()=>({data:[{status:'new'}]}));
  f.api.updateStatusSync(true);const writes=f.node('statusSync').writes;
  f.api.updateStatusSync(true);assert.equal(f.node('statusSync').writes,writes);
  f.api.updateStatusSync(false);assert.equal(f.node('statusSync').writes,writes+1);
});
