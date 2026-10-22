import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const read=(name)=>readFileSync(new URL(`../../public/${name}`,import.meta.url),'utf8');
const tick=()=>new Promise((resolve)=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise((r)=>{resolve=r;});return {promise,resolve};};
function fixture(options={}) {
  const nodes=new Map(),calls=[];
  function node(id) {if(!nodes.has(id))nodes.set(id,{value:'',innerHTML:'',textContent:'',disabled:false,addEventListener(){},querySelector:()=>null});return nodes.get(id);}
  const accounts=[{id:'a',display_name:'Alice',email:'alice@example.com'},{id:'b',display_name:'Bob',email:'bob@example.com'}];
  const sb={rpc:async(name,params)=>{calls.push({name,params});return name==='admin_list_creators' ? {data:accounts,error:options.listError||null} : {data:true,error:null};},from(table){let userId='';const query={select(){return query;},eq(key,value){userId=value;return query;},order(){return query;},limit(){return query;},update(value){calls.push({update:value,userId});return query;},in(){return Promise.resolve({error:null});},then(resolve,reject){calls.push({read:userId});return Promise.resolve(options.read?options.read(userId):{data:[],error:null}).then(resolve,reject);},insert(value){calls.push({insert:value});return options.send?options.send(value):Promise.resolve({error:null});}};return query;}};
  const context=vm.createContext({sb,window:{supabaseClient:sb},document:{getElementById:node,querySelector:()=>null},setTimeout(){},confirm:()=>options.confirm!==false});
  vm.runInContext(read('app.js'),context);context.toast=()=>{};
  vm.runInContext(read('admin-unify.js'),context);
  return {context,node,calls,choose(id){node('creatorSelect').value=id;node('creatorSelect').onchange();},draft(text){node('adminMsgInput').value=text;node('adminMsgInput').oninput();}};
}

test('switching accounts ignores the previous thread response and retains separate drafts',async()=>{
  const old=deferred();const f=fixture({read:(id)=>id==='a'?old.promise:{data:[{sender:'creator',message:'Bob message'}]}});
  await f.context.renderChat();f.choose('a');f.draft('Draft for Alice');f.choose('b');await tick();
  f.draft('Draft for Bob');old.resolve({data:[{sender:'creator',message:'Alice old message',read_by_admin:false}]});await tick();
  assert.match(f.node('threadList').innerHTML,/Bob message/);
  assert.doesNotMatch(f.node('threadList').innerHTML,/Alice old message/);
  assert.ok(!f.calls.some((call)=>call.update));
  f.choose('a');assert.equal(f.node('adminMsgInput').value,'Draft for Alice');
  f.choose('b');assert.equal(f.node('adminMsgInput').value,'Draft for Bob');
});

test('account search never silently changes the selected recipient',async()=>{
  const f=fixture();await f.context.renderChat();f.choose('a');await tick();f.draft('For Alice');
  f.node('creatorSearch').oninput({target:{value:'Bob'}});
  assert.equal(f.node('creatorSelect').value,'a');
  assert.match(f.node('creatorSelect').innerHTML,/Alice/);
  await f.context.sendAdminMessage();
  assert.equal(f.calls.find((call)=>call.insert).insert.user_id,'a');
});

test('pending sends stay bound to the original account and never clear the new account draft',async()=>{
  const pending=deferred();const f=fixture({send:()=>pending.promise});await f.context.renderChat();f.choose('a');await tick();
  f.draft('For Alice');const send=f.context.sendAdminMessage();
  f.choose('b');f.draft('For Bob');await f.context.sendAdminMessage();
  assert.equal(f.calls.filter((call)=>call.insert).length,1);
  assert.equal(f.calls.find((call)=>call.insert).insert.user_id,'a');
  pending.resolve({error:null});await send;
  assert.equal(f.node('adminMsgInput').value,'For Bob');
  f.choose('a');assert.equal(f.node('adminMsgInput').value,'');
});

test('failed sends preserve the draft and do not retry the insert',async()=>{
  const f=fixture({send:async()=>({error:{message:'offline'}})});await f.context.renderChat();f.choose('a');await tick();f.draft('Keep this');
  await f.context.sendAdminMessage();
  assert.equal(f.node('adminMsgInput').value,'Keep this');
  assert.match(f.node('adminChatStatus').textContent,/draft is kept/);
  assert.equal(f.calls.filter((call)=>call.insert).length,1);
  assert.equal(f.node('adminMsgSend').disabled,false);
});

test('failed account-list reads disable sending and cancelled clear never calls its mutation',async()=>{
  const bad=fixture({listError:{message:'offline'}});await bad.context.renderChat();
  assert.equal(bad.node('adminMsgSend').disabled,true);
  assert.match(bad.node('creatorListStatus').textContent,/could not be loaded/);
  const f=fixture({confirm:false});await f.context.renderChat();f.choose('a');await tick();await f.context.clearThread();
  assert.ok(!f.calls.some((call)=>call.name==='clear_message_thread'));
});
