import type {Page} from '@playwright/test';
export async function mockDesk(page:Page, role:'creator'|'admin', lang:string, failed=false, populated=false, ownerResponses:Record<string,any>={}){
 await page.addInitScript(({lang})=>localStorage.setItem('cpay-lang',lang),{lang});
 const script=`(${function(role:string,failed:boolean,populated:boolean,ownerResponses:Record<string,any>){
 for(const response of Object.values(ownerResponses)) if(response.error) response.error.context={json:async()=>({code:response.error.code,error:response.error.message})};
 const profile={id:'fixture-user',email:'qa@example.test',display_name:'QA Workspace',role,account_status:'active',account_type:'individual',available:42,platform_fee_percent:1};
 const objectRPC:Record<string,unknown>={get_my_balance:{available:42},my_earnings_split:{net:42,settled:50,platform_fee:8},my_receive_settings:{auto_withdraw:false},my_withdraw_settings:{fee_percent:1},my_payout_book:{wallets:[]},my_dashboard_profile:profile,admin_global_stats:{total_settled:500,total_admin_profit:5,total_withdrawn:100,pending_withdrawals_count:0,active_creators:1},admin_auto_withdraw_overview:{users:[]},admin_ops_snapshot:{profiles:{active:1}},admin_system_snapshot:{database:{size_pretty:'Fixture data'}},admin_system_alerts:{alerts:[]},admin_wallet_health:{cards:[{key:'wallet',label:'Wallet sync',state:'warn',age_sec:30,detail:'Local fixture only'}]},admin_list_forwards:{mode:'instant_forward',rows:[],counts:{},totals:{ok:true}},admin_locations:{users:[],payments:[]}};
 const rpc=async(name:string)=>failed&&['get_my_balance','admin_ops_snapshot','admin_system_alerts','admin_list_receipt_reviews'].includes(name)?{data:null,error:{message:'Fixture read unavailable'}}:{data:name in objectRPC?objectRPC[name]:['admin_list_business_profiles','admin_list_creators'].includes(name)?[profile]:name==='admin_platform_settings'?[{key:'payment_mode',kind:'string',value:'balance',label:'Payment mode'},{key:'legal_entity_name',kind:'text',value:'',label:'Legal entity name'}]:[],error:null};
 const payment={id:'fixture-payment-reference',status:'settled',amount_requested:123.45,amount_settled:123.45,created_at:'2026-10-22T00:00:00Z',settled_at:'2026-10-22T00:01:00Z',link_slug:'design-'+ 'x'.repeat(70),creator_name:'Long account name '.repeat(6)};
 if(populated){objectRPC.get_my_payments=[payment];objectRPC.admin_list_payments=[payment];objectRPC.admin_list_account_applications=[{id:'application-reference',status:'pending',email:'long-account@example.test',display_name:'Long applicant name '.repeat(6),requested_role:'creator'}];}
 const from=(table:string)=>{let single=false;const q:any={};for(const key of ['select','eq','is','in','order','limit','range','update','insert','delete'])q[key]=()=>q;q.single=q.maybeSingle=()=>{single=true;return q};q.then=(resolve:any,reject:any)=>Promise.resolve({data:table==='profiles'?profile:table==='app_settings'?(single?{value:{percent:1}}:[]):populated&&table==='payment_links'?[{id:'link-reference',slug:payment.link_slug,display_name:'Long project name '.repeat(8),theme:'keypad',is_active:true}]:populated&&table==='withdrawals'?[{id:'withdrawal-full-reference',user_id:'fixture-user',status:'failed',amount_requested:42,fee_percent:1,amount_after_fee:41.58,method:'usdt',destination:'0x'+'a'.repeat(40),requested_at:'2026-10-22T00:00:00Z',admin_note:'<img src=x onerror=alert(1)> retained as text',payout_ref:'full-provider-reference-'+'r'.repeat(90)}]:[],error:null}).then(resolve,reject);return q};
 const session={user:{id:profile.id,email:profile.email},access_token:'fixture-only'};
 (window as any).SUPABASE_URL='https://fixture.invalid';(window as any).SUPABASE_ANON_KEY='fixture-only';
 (window as any).supabaseClient={rpc,from,auth:{getSession:async()=>({data:{session}}),getUser:async()=>({data:{user:session.user}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})},functions:{invoke:async(name:string,options:any)=>name in ownerResponses ? (options?.method==='GET' ? ownerResponses[name] : Promise.reject(new Error('Fixture prohibits owner writes'))) : ({data:null,error:{message:'Owner only in fixture',context:{json:async()=>({code:'owner_only'})}}})}};
 }.toString()})(${JSON.stringify(role)},${JSON.stringify(failed)},${JSON.stringify(populated)},${JSON.stringify(ownerResponses)});`;
 await page.route('**/*',async route=>{const url=new URL(route.request().url());
  if(url.hostname==='127.0.0.1'){
   if(url.pathname==='/config.js')return route.fulfill({contentType:'text/javascript',body:script});
   if(url.pathname==='/mfa.js')return route.fulfill({contentType:'text/javascript',body:'window.cpayMfa={strong:async()=>true,ensureStrong:async()=>true,promptPasskey:async()=>false};'});
   return route.continue();
  }
  if(url.hostname==='fixture.invalid'){
   let body:any={};try{body=route.request().postDataJSON() || {}}catch{}
   return route.fulfill({contentType:'application/json',body:JSON.stringify(body.action==='info'?{balanceSats:5000,balanceUsd:50,owedToCreatorsUsd:42,spendableSat:800}:body.action==='fiat'?{currencies:[]}:body.action==='payments'?{payments:[],hasMore:false}:{routes:[]})});
  }
  return route.abort();
 });
}
