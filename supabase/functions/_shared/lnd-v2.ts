/**
 * CPAY v2 — LND-only receiving transport. Nothing from Blink or BTCPay is
 * imported. Restricted to two invoice RPCs; cannot spend, send or withdraw.
 * The provided URL must be the exact HTTPS origin of a Cloudflare Access
 * protected tunnel. No untrusted client URL ever reaches this module.
 */
export type LndSecrets={
  baseUrl:string; invoiceMacaroonHex:string;
  accessClientId:string; accessClientSecret:string;
};
export type LndInvoice={bolt11:string;paymentHashHex:string;expirySeconds:3600};
export type LndInvoiceState="pending"|"settled"|"cancelled";
export class LndTransportError extends Error { constructor(){super("Lightning node unavailable");} }
export class LndConfigurationError extends Error { constructor(){super("Lightning receiving is not configured");} }

export function makeLndClient(secrets:LndSecrets, http:typeof fetch=fetch) {
  let base:URL;
  try {
    base=new URL(secrets.baseUrl);
    if(base.protocol!=="https:" || base.username || base.password || base.search || base.hash ||
       base.pathname!=="/" || !base.hostname || secrets.baseUrl!==base.origin+"/" && secrets.baseUrl!==base.origin)
      throw Error("invalid URL");
  }catch{throw new LndConfigurationError();}
  if(!/^[a-f0-9]{2,8192}$/i.test(secrets.invoiceMacaroonHex) ||
     secrets.invoiceMacaroonHex.length%2!==0 ||
     !secrets.accessClientId.trim() || !secrets.accessClientSecret.trim())
    throw new LndConfigurationError();
  const headers={
    "Grpc-Metadata-macaroon":secrets.invoiceMacaroonHex,
    "CF-Access-Client-Id":secrets.accessClientId,
    "CF-Access-Client-Secret":secrets.accessClientSecret,
  };
  async function call(path:string,method:"GET"|"POST",body?:Record<string,unknown>) {
    let res:Response;
    try {
      res=await http(base.origin+path,{
        method,headers:{...headers,"Content-Type":"application/json","Accept":"application/json"},
        body:body?JSON.stringify(body):undefined,redirect:"error",
        signal:AbortSignal.timeout(12000),
      });
      if(!res.ok){await res.body?.cancel();throw new LndTransportError();}
      const data=await res.json();
      if(!data || typeof data!=="object") throw new LndTransportError();
      return data as Record<string,unknown>;
    }catch{throw new LndTransportError();}
  }
  function hashHex(raw:unknown):string{
    if(typeof raw!=="string" || raw.length<42 || raw.length>100)throw new LndTransportError();
    try {
      const bytes=atob(raw.replace(/-/g,"+").replace(/_/g,"/"));
      if(bytes.length!==32)throw Error("bad hash");
      return [...bytes].map(x=>x.charCodeAt(0).toString(16).padStart(2,"0")).join("");
    } catch {throw new LndTransportError();}
  }
  return {
    async addInvoice(valueSats:number,memo:string):Promise<LndInvoice>{
      if(!Number.isSafeInteger(valueSats)||valueSats<=0||valueSats>100_000_000||
         memo.length>220)throw new RangeError("Invalid invoice request");
      const result=await call("/v1/invoices","POST",{
        value:String(valueSats),memo,expiry:"3600",private:false,
      });
      if(typeof result.payment_request!=="string" ||
         !/^ln(bc|tb|bcrt)[0-9a-z]+$/i.test(result.payment_request))
        throw new LndTransportError();
      return {
        bolt11:result.payment_request,
        paymentHashHex:hashHex(result.r_hash),
        expirySeconds:3600,
      };
    },
    async lookupInvoice(paymentHashHex:string):Promise<{state:LndInvoiceState;paidSats:number|null}>{
      if(!/^[a-f0-9]{64}$/i.test(paymentHashHex))throw new RangeError("Invalid payment hash");
      const result=await call("/v1/invoice/"+paymentHashHex.toLowerCase(),"GET");
      const state=String(result.state||"OPEN").toUpperCase();
      if(!["OPEN","ACCEPTED","SETTLED","CANCELED"].includes(state))throw new LndTransportError();
      if(state==="SETTLED"){
        const n=Number(result.amt_paid_sat);
        if(!Number.isSafeInteger(n)||n<=0)throw new LndTransportError();
        return {state:"settled",paidSats:n};
      }
      return {state:state==="CANCELED"?"cancelled":"pending",paidSats:null};
    },
  };
}
