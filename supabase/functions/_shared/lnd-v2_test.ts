import {assertEquals,assertRejects} from "jsr:@std/assert@1";
import {makeLndClient,LndConfigurationError,LndTransportError} from "./lnd-v2.ts";
const sec={baseUrl:"https://node.example.test",invoiceMacaroonHex:"abcd",accessClientId:"test-client",accessClientSecret:"test-secret"};
const hash=Array.from({length:32},(_,i)=>i);
const encoded=btoa(String.fromCharCode(...hash));
const expected=hash.map(i=>i.toString(16).padStart(2,"0")).join("");
Deno.test("LND AddInvoice sets private false and exactly 3600-second expiry",async()=>{
 let observed:any;
 const f=(async(url:unknown,init?:RequestInit)=>{
  observed={url,init};
  return new Response(JSON.stringify({payment_request:"lnbc100n1thisistestnotpayable",r_hash:encoded}),{status:200});
 }) as typeof fetch;
 const l=makeLndClient(sec,f);
 const v=await l.addInvoice(1500,"CPAY v2 payment");
 assertEquals(v,{bolt11:"lnbc100n1thisistestnotpayable",paymentHashHex:expected,expirySeconds:3600});
 assertEquals(observed.url,"https://node.example.test/v1/invoices");
 assertEquals(observed.init.headers["Grpc-Metadata-macaroon"],"abcd");
 assertEquals(observed.init.headers["CF-Access-Client-Id"],"test-client");
 assertEquals(observed.init.headers["CF-Access-Client-Secret"],"test-secret");
 assertEquals(JSON.parse(observed.init.body),{value:"1500",memo:"CPAY v2 payment",expiry:"3600",private:false});
});
Deno.test("LND lookup uses fixed hash-only URL and recognizes settlement",async()=>{
 const f=(async(url:unknown,init?:RequestInit)=>{
  assertEquals(url,"https://node.example.test/v1/invoice/"+expected);
  assertEquals(init?.method,"GET");
  return Response.json({state:"SETTLED",amt_paid_sat:"1500"});
 }) as typeof fetch;
 const l=makeLndClient(sec,f);
 assertEquals(await l.lookupInvoice(expected),{state:"settled",paidSats:1500});
});
Deno.test("LND lookup respects pending and cancelled",async()=>{
 for(const [name,state] of [["OPEN","pending"],["ACCEPTED","pending"],["CANCELED","cancelled"]]){
  const l=makeLndClient(sec,(async()=>Response.json({state:name})) as typeof fetch);
  assertEquals((await l.lookupInvoice(expected)).state,state);
 }
});
Deno.test("LND fails closed on missing credentials, unsafe URL and bad hash",async()=>{
 for(const baseUrl of ["http://node.example.test","https://node.example.test/evil","https://user@node.example.test"]){
  await assertRejects(async()=>makeLndClient({...sec,baseUrl}),LndConfigurationError);
 }
 await assertRejects(async()=>makeLndClient({...sec,accessClientSecret:""}),LndConfigurationError);
 const l=makeLndClient(sec,(async()=>Response.json({state:"SETTLED"})) as typeof fetch);
 await assertRejects(()=>l.lookupInvoice("malicious/path"),RangeError);
 await assertRejects(()=>l.lookupInvoice(expected),LndTransportError);
});
Deno.test("LND returns generic errors; no headers or tokens in error",async()=>{
 const l=makeLndClient(sec,(async()=>new Response("secret error", {status:503})) as typeof fetch);
 await assertRejects(()=>l.addInvoice(1500,"test"),LndTransportError,"Lightning node unavailable");
});
