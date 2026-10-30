// CPAY rebuild v2 — LND-only payment entrypoint.
// Public GET status, public POST create and secret-protected cron watcher.
// Completely independent of older gateway/wallet code and financial rows.
import {createClient} from "https://esm.sh/@supabase/supabase-js@2.117.3";
import {currentRate,centsToMsat} from "../_shared/btc-rate.ts";
import {parseAmountToCents,formatCents} from "../_shared/money.ts";
import {makeLndClient,LndConfigurationError} from "../_shared/lnd-v2.ts";

const env=(key:string)=>Deno.env.get(key)||"";
const cors={
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Methods":"GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":"Content-Type",
};
const db=createClient(env("SUPABASE_URL"),env("SUPABASE_SERVICE_ROLE_KEY"),{
  auth:{persistSession:false,autoRefreshToken:false}
});
function json(data:unknown,status=200){
  return new Response(JSON.stringify(data),{
    status,headers:{"Content-Type":"application/json","Cache-Control":"no-store",...cors},
  });
}
function fail(){return json({error:"Payment service temporarily unavailable"},503);}
function client(){
  return makeLndClient({
    baseUrl:env("LND_REST_URL"),invoiceMacaroonHex:env("LND_INVOICE_MACAROON_HEX"),
    accessClientId:env("CF_ACCESS_CLIENT_ID"),accessClientSecret:env("CF_ACCESS_CLIENT_SECRET"),
  });
}
function isUuid(value:string){
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function constantTimeEqual(a:string,b:string){
  if(!a || !b)return false;
  const aa=new TextEncoder().encode(a),bb=new TextEncoder().encode(b);
  let diff=aa.length^bb.length;
  for(let i=0;i<Math.max(aa.length,bb.length);i++)diff|=(aa[i]??0)^(bb[i]??0);
  return diff===0;
}
async function sha(value:string){
  const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return [...new Uint8Array(b)].map(n=>n.toString(16).padStart(2,"0")).join("");
}
async function claim(key:string,max:number){
  const {data,error}=await db.rpc("v2_claim_rate",{p_key:await sha(key),p_max:max});
  return !error && data===true;
}
async function verifyHuman(token:string) {
  const secret=env("TURNSTILE_SECRET_KEY");
  if(!secret || !token || token.length>2048)return false;
  try{
    const body=new URLSearchParams({secret,response:token});
    const res=await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify",{
      method:"POST",body,redirect:"error",signal:AbortSignal.timeout(7000),
    });
    if(!res.ok){await res.body?.cancel();return false;}
    const result=await res.json();
    return result?.success===true;
  }catch{return false;}
}
async function fetchLink(slug:string){
  const {data,error}=await db.from("v2_links")
    .select("id,owner_id,slug,display_name,min_usd,max_usd,active")
    .eq("slug",slug).maybeSingle();
  if(error||!data||!data.active)return null;
  const user=await db.from("profiles").select("account_status").eq("id",data.owner_id).maybeSingle();
  if(user.error||user.data?.account_status!=="active")return null;
  return data;
}
async function existingInvoice(linkId:string,requestId:string) {
  const {data,error}=await db.from("v2_invoices")
    .select("id,status,bolt11,amount_usd,amount_sats,expires_at")
    .eq("link_id",linkId).eq("request_id",requestId).maybeSingle();
  if(error)throw Error("invoice lookup failed");
  return data;
}
function publicInvoice(row:{id:string;bolt11:string;amount_usd:unknown;amount_sats:unknown;expires_at:string}){
  return {
    id:row.id,status:"pending",amount_usd:Number(row.amount_usd),
    amount_sats:Number(row.amount_sats),bolt11:row.bolt11,expires_at:row.expires_at,
  };
}
async function create(req:Request) {
  // Explicit opt-in on both DB and Edge. No fallback to older receiving rails.
  if(env("PAYLINK_V2_ENABLED")!=="true")return json({error:"New checkout is not enabled"},503);
  const setting=await db.from("v2_settings").select("checkout_enabled").eq("id",true).maybeSingle();
  if(setting.error||setting.data?.checkout_enabled!==true)
    return json({error:"New checkout is not enabled"},503);
  let lnd:ReturnType<typeof makeLndClient>;
  try{lnd=client();}catch(e){if(e instanceof LndConfigurationError)return fail();throw e;}
  if(Number(req.headers.get("content-length")||"0")>4096)return json({error:"Request too large"},413);
  let body:Record<string,unknown>;
  try{body=await req.json();if(!body||Array.isArray(body)||typeof body!=="object")throw Error(); }
  catch{return json({error:"Invalid request"},400);}
  const slug=String(body.slug??"");
  const requestId=String(body.requestId??"");
  const raw=body.amount;
  const amountText=typeof raw==="number"||typeof raw==="string"?String(raw):"";
  const cents=/^\d{1,4}(?:\.\d{1,2})?$/.test(amountText)?parseAmountToCents(amountText):null;
  if(!/^[a-z0-9][a-z0-9-]{2,46}[a-z0-9]$/.test(slug)||!isUuid(requestId)||cents===null)
    return json({error:"Invalid link or amount"},400);
  const link=await fetchLink(slug);
  if(!link)return json({error:"Payment link unavailable"},404);
  if(cents<Math.round(Number(link.min_usd)*100)||
     cents>Math.round(Number(link.max_usd)*100))
    return json({error:"Amount outside this link's range"},400);
  // Independent per-link limit remains enforced when clients spoof IP headers.
  if(!await claim("v2:link:"+link.id,120))return json({error:"Too many requests"},429);
  const ip=req.headers.get("cf-connecting-ip")||req.headers.get("x-forwarded-for")||"unknown";
  if(!await claim("v2:ip:"+ip.slice(0,128),12))return json({error:"Please retry shortly"},429);
  if(!await verifyHuman(String(body.turnstileToken||"")))
    return json({error:"Complete verification and retry"},403);
  const saved=await existingInvoice(link.id,requestId);
  if(saved){
    if(saved.status==="pending"&&saved.bolt11)return json(publicInvoice(saved));
    return json({status:saved.status,id:saved.id},saved.status==="creating"?202:409);
  }
  // Two agreeing sources, <=60-second cache. Round DOWN to whole sats to
  // avoid asking the sender for a larger USD amount than the link displays.
  const rate=await currentRate();
  const sats=Number(centsToMsat(cents,rate)/1000n);
  if(!Number.isSafeInteger(sats)||sats<=0)return fail();
  const expires=new Date(Date.now()+3_600_000).toISOString();
  const quote={
    link_id:link.id,owner_id:link.owner_id,request_id:requestId,
    status:"creating",amount_usd:formatCents(cents),amount_sats:sats,
    btc_usd_rate:rate.usdPerBtc,btc_rate_sources:rate.sources,platform_fee_pct:0,platform_fee_usd:0,
    net_usd:formatCents(cents),expires_at:expires,
  };
  const inserted=await db.from("v2_invoices").insert(quote).select("id").single();
  if(inserted.error||!inserted.data){
    // Uniqueness race: NEVER create another LND invoice for the same
    // request id. Return the winner or a retryable busy response.
    const raced=await existingInvoice(link.id,requestId);
    if(raced?.status==="pending"&&raced.bolt11)return json(publicInvoice(raced));
    return json({error:"Payment request already in progress"},409);
  }
  const id=inserted.data.id as string;
  // A network timeout can leave a valid invoice in LND. In that case keep
  // the row as 'creating' and do NOT retry generation automatically.
  const inv=await lnd.addInvoice(sats,"CPAY "+id);
  const updated=await db.from("v2_invoices")
    .update({status:"pending",payment_hash:inv.paymentHashHex,bolt11:inv.bolt11})
    .eq("id",id).eq("status","creating").select("id").single();
  if(updated.error||!updated.data)throw Error("invoice registration failed");
  return json(publicInvoice({id,bolt11:inv.bolt11,amount_usd:formatCents(cents),amount_sats:sats,expires_at:expires}),201);
}
async function reconcile(hash:string,amountSats:number,expiresAt:string){
  const node=client();
  const info=await node.lookupInvoice(hash);
  const {data,error}=await db.rpc("v2_reconcile_invoice",{
    p_hash:hash,p_node_state:info.state==="cancelled"?"cancelled":info.state==="settled"?"settled":"open",
    p_paid_sats:info.paidSats,
  });
  if(error)throw Error("invoice reconcile failed");
  return String(data);
}
async function status(req:Request) {
  const id=new URL(req.url).searchParams.get("id")||"";
  if(!isUuid(id))return json({error:"Invalid invoice id"},400);
  const {data,error}=await db.from("v2_invoices")
    .select("id,status,amount_usd,expires_at,settled_at,payment_hash,amount_sats,checked_at")
    .eq("id",id).maybeSingle();
  if(error)return fail();
  if(!data)return json({error:"Invoice not found"},404);
  let current=data.status;
  if(current==="pending" && data.payment_hash &&
     (!data.checked_at||Date.now()-Date.parse(data.checked_at)>12000)){
    try{current=await reconcile(data.payment_hash,data.amount_sats,data.expires_at);}
    catch{ /* Return known pending; never fabricate settlement. */ }
  }
  const refreshed=current!==data.status?await db.from("v2_invoices")
    .select("status,settled_at").eq("id",id).maybeSingle():null;
  return json({status:refreshed?.data?.status||current,amount_usd:Number(data.amount_usd),
    settled_at:refreshed?.data?.settled_at||data.settled_at,
    expires_at:data.expires_at});
}
async function watch(req:Request) {
  if(!constantTimeEqual(req.headers.get("x-cron-secret")||"",env("CRON_SECRET")))
    return json({error:"Unauthorized"},401);
  // Even when creating new invoices is disabled, continue reconciling
  // already issued payables so the accounting ledger never gets stuck.
  const {data,error}=await db.from("v2_invoices").select("payment_hash,amount_sats,expires_at")
    .eq("status","pending").order("created_at",{ascending:true}).limit(50);
  if(error)return fail();
  let checked=0,errors=0;
  for(const row of data||[]){
    if(!row.payment_hash)continue;
    try{await reconcile(row.payment_hash,row.amount_sats,row.expires_at);checked++;}
    catch{errors++;}
  }
  return json({checked,errors});
}
Deno.serve(async req=>{
  if(req.method==="OPTIONS")return new Response(null,{headers:cors});
  const url=new URL(req.url),action=url.searchParams.get("action");
  try{
    if(action==="create"&&req.method==="POST")return await create(req);
    if(action==="status"&&req.method==="GET")return await status(req);
    if(action==="watch"&&req.method==="POST")return await watch(req);
    return json({error:"Not found"},404);
  }catch{
    return fail();
  }
});
