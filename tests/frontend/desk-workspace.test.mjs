import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const read = (file) => readFileSync(new URL(`../../public/${file}`, import.meta.url), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };

async function fixture(options = {}) {
  const nodes = new Map(), reads = [], withdrawBindings = [];
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', html: '', writes: 0, open: false, children: [], events: {},
      append(...children) { this.children.push(...children); },
      set innerHTML(html) { this.html = html; this.writes++; }, get innerHTML() { return this.html; },
      querySelectorAll: (selector) => selector === '[data-toggle-link]' ? (options.toggleButtons || []) : [], querySelector: () => node(`${id}-retry`), addEventListener(name,fn) { this.events[name]=fn; }, click() { this.onclick?.(); }, focus() { this.focused=true; } });
    return nodes.get(id);
  }
  const defaults = { get_my_balance: { data: { available: 42 } }, my_earnings_split: { data: { net: 42, settled: 50, platform_fee: 8 } }, get_my_payments: { data: [] }, my_receive_settings: { data: { auto_withdraw: false } }, my_withdraw_settings: { data: { fee_percent: 0 } }, my_payout_book: { data: { wallets: [] } }, update_my_public_profile:{data:true}, set_my_usdt_wallet:{data:true}, delete_my_usdt_wallet:{data:true}, set_my_payout_prefs:{data:{}} };
  const sb = { rpc: async (name, params) => { reads.push({name,params}); return options.rpc ? options.rpc(name, defaults[name], params) : (options.responses?.[name] || defaults[name]); },
    from(table) {
      const query = { select() { return query; }, update(values) { reads.push({table,update:values}); return query; }, insert(values) { reads.push({table,insert:values}); return options.send ? options.send(values) : Promise.resolve({data:{},error:null}); }, then(resolve,reject) { return Promise.resolve(table === 'withdrawals' ? {data: options.withdrawals || [], error: options.historyError || null} : table === 'support_messages' ? (options.readMessages ? options.readMessages() : {data: options.messages || [], error: options.messageError || null}) : {error: options.updateError || null}).then(resolve,reject); }, eq(key,value) { reads.push({table,key,value}); return query; }, is() { return query; }, order(key, config) { reads.push({table,order:key,ascending:config?.ascending}); return table === 'withdrawals' || table === 'support_messages' ? query : Promise.resolve({ data: options.links || [], error: options.linksError || null }); }, limit(count) { reads.push({table,limit:count}); return query; } };
      return query;
    } };
  const context = vm.createContext({ window: { supabaseClient: sb, confirm: () => options.confirm !== false }, document: { getElementById: (id) => id === 'logoutBtn' ? null : node(id), querySelectorAll: (selector) => selector === '[data-del-net]' ? (options.deleteButtons || []) : [], querySelector: () => null, createElement: (tag) => node(`created-${tag}-${nodes.size}`) }, localStorage: { getItem: () => null }, setTimeout: (fn) => fn(),
    Daily: { mountSelf: options.daily || (async () => {}) } });
  vm.runInContext(read('app.js'), context);
  context.loadProfile = async () => null;
  context.layoutLabel = () => 'Standard';
  context.layoutPicker = () => '';
  let binds = 0;
  context.bindExperience = () => { binds++; };
  context.toast = () => {};
  context.bindWithdraw = (...args) => { withdrawBindings.push(args); };
  vm.runInContext(read('freelancer-desk.js'), context);
  await tick(); // boot's null profile exits before the test sets its fixture user.
  vm.runInContext("me = { id: 'member-1', cost_percent: 0 };", context);
  return { context, node, reads, withdrawBindings, binds: () => binds };
}

test('link filters combine status with name/slug search and never mutate source records', async () => {
  const f = await fixture();
  const links = Object.freeze([Object.freeze({ id: 1, slug: 'Logo-Work', display_name: 'Design', is_active: true }), Object.freeze({ id: 2, slug: 'old-logo', display_name: 'Archive', is_active: false }), Object.freeze({ id: 3, slug: 'monthly', display_name: null, is_active: true })]);
  const ids = (filter) => Array.from(f.context.filterPaymentLinks(links, filter), (row) => row.id);
  assert.deepEqual(ids({search: '  LOGO  ', status: ''}), [1,2]);
  assert.deepEqual(ids({search: 'design', status: 'live'}), [1]);
  assert.deepEqual(ids({search: 'logo', status: 'off'}), [2]);
  assert.deepEqual(ids({search: 'missing', status: ''}), []);
  assert.deepEqual(ids({search: '', status: 'live'}), [1,3]);
});

test('typing filters preserves a draft and design selection without refetching or re-binding the composer', async () => {
  const f = await fixture({ links: [{ id:'1', slug:'logo', display_name:'Logo', is_active:true }, {id:'2', slug:'old', display_name:'Archive', is_active:false}] });
  await f.context.renderLinks();
  const rootWrites = f.node('links').writes, readCount = f.reads.length;
  f.node('linkName').value = 'Unsaved customer link';
  f.node('linkCost').value = '2.5';
  vm.runInContext("exp.theme = 'paper';", f.context);
  f.node('linkSearch').oninput({target:{value:'logo'}});
  f.node('linkStatus').onchange({target:{value:'live'}});
  assert.equal(f.node('links').writes, rootWrites);
  assert.equal(f.node('linkName').value, 'Unsaved customer link');
  assert.equal(f.node('linkCost').value, '2.5');
  assert.equal(vm.runInContext('exp.theme', f.context), 'paper');
  assert.equal(f.binds(), 1);
  assert.equal(f.reads.length, readCount);
  assert.equal(f.node('linkResultsCount').textContent, '1 / 2');
  assert.match(f.node('linkRows').innerHTML, /Preview/);
  assert.doesNotMatch(f.node('linkRows').innerHTML, /Archive/);
  f.node('newLinkBtn').onclick();
  assert.equal(f.node('linkComposer').open, true);
  assert.equal(f.node('linkName').focused, true);
  f.node('clearLinkFilters').onclick();
  assert.equal(f.node('linkResultsCount').textContent, '2 / 2');
  assert.equal(f.node('linkSearch').focused, true);
  assert.ok(f.reads.some((r) => r.key==='user_id' && r.value==='member-1'));
});

test('link names and slugs stay escaped, and a zero-match filter differs from an empty account', async () => {
  const f = await fixture({links:[{id:'1',slug:'<img>',display_name:'<script>bad</script>',is_active:true}]});
  await f.context.renderLinks();
  assert.doesNotMatch(f.node('linkRows').innerHTML, /<img>|<script>/);
  f.node('linkSearch').oninput({target:{value:'nothing'}});
  assert.match(f.node('linkRows').innerHTML,/No links match/);
  assert.equal(f.node('linkResultsCount').textContent, '0 / 1');
  const empty=await fixture();await empty.context.renderLinks();
  assert.match(empty.node('linkRows').innerHTML,/No links yet/);
  assert.match(empty.node('links').innerHTML, /id="linkComposer" open/);
});

test('daily loading/failure never hides balance, shortcuts or recent activity', async () => {
  const pending = deferred();
  const f = await fixture({ daily: () => pending.promise });
  const render = f.context.renderHome();await tick();
  assert.match(f.node('home').innerHTML, /\$42\.00/);
  assert.match(f.node('home').innerHTML, /id="homeWithdraw"/);
  assert.match(f.node('home').innerHTML, /id="homeRecent"/);
  pending.reject(new Error('<img> daily read failed'));await render;
  assert.match(f.node('home').innerHTML, /\$42\.00/);
  assert.match(f.node('dailySelf').innerHTML, /&lt;img&gt;/);
  assert.match(f.node('dailySelf').innerHTML, /data-read-retry/);
});

test('receiving settings errors never claim Auto withdraw is off', async () => {
  const f=await fixture({responses:{my_receive_settings:{data:null,error:{message:'offline'}}}});
  await f.context.renderHome();
  assert.match(f.node('home').innerHTML,/Payment mode unavailable/);
  assert.doesNotMatch(f.node('home').innerHTML,/Auto withdraw: Off/);
});

test('a late overview response cannot replace a newer refresh', async () => {
  const pending=deferred();let balances=0;
  const f=await fixture({rpc:(name, fallback)=> name==='get_my_balance' && ++balances===1 ? pending.promise : fallback});
  const first=f.context.renderHome();await tick();
  await f.context.renderHome();
  const latest=f.node('home').innerHTML;
  pending.resolve({error:{message:'stale balance failure'}});await first;
  assert.equal(f.node('home').innerHTML, latest);
});


test('a confirmed status change keeps the composer draft and updates only visible rows', async () => {
  const button={dataset:{toggleLink:'1',active:'1'},disabled:false};
  const f=await fixture({links:[{id:'1',slug:'logo',is_active:true}],toggleButtons:[button]});
  await f.context.renderLinks();
  const writes=f.node('links').writes;
  f.node('linkName').value='Keep this draft';
  f.node('linkStatus').onchange({target:{value:'live'}});
  await button.onclick();
  assert.equal(f.node('links').writes,writes);
  assert.equal(f.node('linkName').value,'Keep this draft');
  assert.equal(f.node('linkResultsCount').textContent,'0 / 1');
  assert.equal(button.disabled,false);
  assert.ok(f.reads.some((r)=>r.update?.is_active===false));
  assert.ok(f.reads.some((r)=>r.key==='user_id' && r.value==='member-1'));
});

test('failed link reads show an escaped error and a working read-only retry', async () => {
  const options={linksError:{message:'<img> unavailable'}};
  const f=await fixture(options);
  await f.context.renderLinks();
  assert.match(f.node('links').innerHTML,/&lt;img&gt;/);
  assert.match(f.node('links').innerHTML,/data-read-retry/);
  options.linksError=null;
  await f.node('links-retry').onclick();
  assert.match(f.node('links').innerHTML,/Your payment links/);
  assert.ok(!f.reads.some((r)=>r.update));
});


test('payment pagination sends the correct offsets and applying/clearing filters resets to page one', async () => {
  const rows=Array.from({length:50},(_,i)=>({id:String(i),amount_requested:1,status:'settled',total_count:51}));
  const f=await fixture({rpc:(name, fallback, params)=>name==='get_my_payments'?{data:params.p_offset ? rows.slice(0,1) : rows}:fallback});
  await f.context.renderPays();
  assert.match(f.node('pay').innerHTML,/id="payNext" >Next/);
  f.node('payNext').onclick();await tick();
  assert.equal(f.reads.at(-1).params.p_offset,50);
  assert.match(f.node('pay').innerHTML,/id="payNext" disabled/);
  f.node('payStatus').value='settled';f.node('paySearch').value='  logo  ';
  f.node('payApply').onclick();await tick();
  assert.equal(f.reads.at(-1).params.p_offset,0);
  assert.equal(f.reads.at(-1).params.p_status,'settled');
  assert.equal(f.reads.at(-1).params.p_search,'logo');
  f.node('payClear').onclick();await tick();
  assert.equal(f.reads.at(-1).params.p_status,null);
  assert.equal(f.reads.at(-1).params.p_search,null);
});

test('payments show explicit detail controls, escape references and ignore stale read failures', async () => {
  const pending=deferred();let count=0;
  const f=await fixture({rpc:(name, fallback)=>name==='get_my_payments' ? (++count===1 ? pending.promise : {data:[{id:'p1',link_slug:'<img>',invoice_ref:'<script>',amount_requested:5,status:'pending',total_count:1}]}) : fallback});
  const old=f.context.renderPays();await tick();
  await f.context.renderPays();
  const current=f.node('pay').innerHTML;
  assert.match(current,/View details/);
  assert.match(current,/&lt;script&gt;/);
  assert.doesNotMatch(current,/<script>|<img>/);
  assert.match(current,/id="payNext" disabled/);
  pending.resolve({error:{message:'late read failed'}});await old;
  assert.equal(f.node('pay').innerHTML,current);
});

test('withdrawal renders with funds and unavailable receiving settings without the undeclared-variable regression', async () => {
  const f=await fixture({responses:{my_receive_settings:{data:null,error:{message:'offline'}}}});
  await f.context.renderCash();await tick();
  assert.match(f.node('cash').innerHTML,/Withdraw your balance/);
  assert.match(f.node('cash').innerHTML,/Receiving settings unavailable/);
  assert.match(f.node('cash').innerHTML,/\$42\.00/);
  assert.equal(f.withdrawBindings.length,1);
  const [fee, options]=f.withdrawBindings[0];
  assert.equal(fee(),0);
  assert.equal(options.available(),42);
  assert.doesNotMatch(f.node('cash').innerHTML,/Auto withdraw is off/);
});

test('zero balance keeps history and address management available without binding a send action', async () => {
  const f=await fixture({responses:{get_my_balance:{data:{available:0}}}});
  await f.context.renderCash();await tick();
  assert.match(f.node('cash').innerHTML,/Nothing to withdraw right now/);
  assert.match(f.node('cash').innerHTML,/Manage saved addresses/);
  assert.equal(f.withdrawBindings.length,0);
  assert.match(f.node('wHist').innerHTML,/Withdrawal history/);
});

test('history refresh and filter do not rebuild the withdrawal form or its current draft', async () => {
  const f=await fixture();await f.context.renderCash();await tick();
  const writes=f.node('cash').writes;
  f.node('wAmt').value='12';f.node('wDest').value='saved-destination';
  f.node('wdRefresh').onclick();await tick();
  f.node('wdStatus').value='failed';f.node('wdApply').onclick();await tick();
  assert.equal(f.node('cash').writes,writes);
  assert.equal(f.node('wAmt').value,'12');
  assert.equal(f.node('wDest').value,'saved-destination');
  assert.equal(f.withdrawBindings.length,1);
  assert.match(f.node('wHist').innerHTML,/No withdrawals match/);
  assert.ok(f.reads.some((r)=>r.table==='withdrawals'&&r.key==='status'&&r.value==='failed'));
  assert.ok(f.reads.some((r)=>r.table==='withdrawals'&&r.limit===40));
});


test('profile shows unavailable receiving settings without claiming Auto withdraw is off', async () => {
  const f=await fixture({responses:{my_receive_settings:{data:null,error:{message:'offline'}}}});
  await f.context.renderProfile();
  const text=(n)=>typeof n==='string'?n:(n.textContent||'')+(n.children||[]).map(text).join('');
  const receive=text(f.node('profileReceiveHost'));
  assert.match(receive,/Unavailable/);
  assert.doesNotMatch(receive,/Auto withdraw: Off/);
  assert.match(f.node('profile').innerHTML,/Visible to payers/);
  assert.match(f.node('profile').innerHTML,/Private account settings/);
});

test('an address save retains step-up and preserves the public-profile draft across reload', async () => {
  const f=await fixture();await f.context.renderProfile();
  f.node('pName').value='<draft name>';f.node('pBio').value='Draft bio';f.node('pSlug').value='my-draft';
  f.node('pName').events.input();
  f.node('usdtNet').value='tron';f.node('usdtAddr').value=' saved-address ';
  let stepped=false;
  f.context.window.cpayWithStepUp=async(call,predicate)=>{stepped=true;assert.equal(predicate({error:{message:'Confirm with your passkey to change address'}}),true);return call();};
  await f.node('saveUsdt').onclick();await tick();
  assert.equal(stepped,true);
  assert.match(f.node('profile').innerHTML,/&lt;draft name&gt;/);
  assert.ok(f.reads.some((r)=>r.name==='set_my_usdt_wallet'&&r.params.p_network==='tron'&&r.params.p_address==='saved-address'));
});

test('profile writes cannot be double-submitted and controls recover after a transport failure', async () => {
  const pending=deferred();
  const f=await fixture({rpc:(name,fallback)=>name==='update_my_public_profile'?pending.promise:fallback});
  await f.context.renderProfile();
  const saving=f.node('saveProf').onclick();
  assert.equal(f.node('saveProf').disabled,true);
  await f.node('saveProf').onclick();
  assert.equal(f.reads.filter((r)=>r.name==='update_my_public_profile').length,1);
  pending.reject(new Error('network unavailable'));await saving;
  assert.equal(f.node('saveProf').disabled,false);
});

test('cancelled address removal performs no mutation', async () => {
  const button={dataset:{delNet:'tron'},disabled:false};
  const f=await fixture({confirm:false,deleteButtons:[button]});await f.context.renderProfile();
  await button.onclick();
  assert.ok(!f.reads.some((r)=>r.name==='delete_my_usdt_wallet'));
  assert.equal(button.disabled,false);
});


test('member support loads the newest 80 messages in chronological order and escapes their content',async()=>{
  const f=await fixture({messages:[{id:'2',sender:'admin',message:'second message'},{id:'1',sender:'creator',message:'<img> first message'}]});
  await f.context.renderChat();
  const html=f.node('memberThread').innerHTML;
  assert.ok(html.indexOf('first message')<html.indexOf('second message'));
  assert.match(html,/&lt;img&gt;/);assert.doesNotMatch(html,/<img>/);
  assert.ok(f.reads.some((r)=>r.table==='support_messages'&&r.ascending===false));
  assert.ok(f.reads.some((r)=>r.table==='support_messages'&&r.limit===80));
});

test('failed member sends preserve the draft and cannot be double-submitted',async()=>{
  const pending=deferred();const f=await fixture({send:()=>pending.promise});await f.context.renderChat();
  f.node('adminMsg').value='Draft question';f.node('adminMsg').oninput();
  const sending=f.node('sendAdmin').onclick();await f.node('sendAdmin').onclick();
  assert.equal(f.reads.filter((r)=>r.insert).length,1);
  pending.resolve({error:{message:'offline'}});await sending;
  assert.equal(f.node('adminMsg').value,'Draft question');
  assert.match(f.node('memberChatStatus').textContent,/draft is kept/);
  assert.equal(f.node('sendAdmin').disabled,false);
  await f.context.renderChat();assert.match(f.node('chat').innerHTML,/Draft question/);
});

test('a successful member send does not erase text typed while the request was pending',async()=>{
  const pending=deferred();const f=await fixture({send:()=>pending.promise});await f.context.renderChat();
  f.node('adminMsg').value='First question';const sending=f.node('sendAdmin').onclick();
  f.node('adminMsg').value='Next question';f.node('adminMsg').oninput();
  pending.resolve({error:null});await sending;
  assert.equal(f.node('adminMsg').value,'Next question');
  assert.ok(f.reads.some((r)=>r.insert?.user_id==='member-1'&&r.insert?.sender==='creator'&&r.insert?.message==='First question'));
});
