// Original CPAY v2 checkout. No legacy wallet or gateway integration.
// All prices and invoice settlements are checked again by the server.
(() => {
  "use strict";
  const $=id=>document.getElementById(id);
  const sections=["loading","entry","invoice","success","expired","unavailable"];
  const base=String(window.SUPABASE_URL||"").replace(/\/$/,"");
  const endpoint=base+"/functions/v1/v2-payments";
  const query=new URLSearchParams(location.search);
  const slug=query.get("link")||"";
  let link=null,invoice=null,ticker=null,stop=false,busy=false;
  window.CPAY_TURNSTILE_PAYMENTS=true;

  function screen(id){
    for(const name of sections)$(name).hidden=name!==id;
  }
  function unavailable(msg){
    $("unavailableMessage").textContent=msg||"This payment is unavailable.";
    screen("unavailable");
  }
  function money(n){return "$"+Number(n).toFixed(2);}
  async function withDeadline(url,opts={}){
    return await fetch(url,{...opts,credentials:"omit",cache:"no-store",signal:AbortSignal.timeout(15000)});
  }
  function validateAmount(value){
    const raw=String(value).trim();
    if(!/^\d{1,4}(?:\.\d{1,2})?$/.test(raw))return null;
    const cents=Number(raw.replace(".","")) * (raw.includes(".")?10**(2-raw.split(".")[1].length):100);
    if(!Number.isSafeInteger(cents)||cents<Math.round(link.min_usd*100)||cents>Math.round(link.max_usd*100))
      return null;
    return cents/100;
  }
  function newAttempt(amount){
    const key="cpay-v2:"+slug+":"+Number(amount).toFixed(2);
    try{
      const value=JSON.parse(sessionStorage.getItem(key)||"null");
      if(value?.id && Date.now()-value.at<600000)return value.id;
    }catch{}
    const id=crypto.randomUUID();
    try{sessionStorage.setItem(key,JSON.stringify({id,at:Date.now()}));}catch{}
    return id;
  }
  function removeAttempt(amount){
    try{sessionStorage.removeItem("cpay-v2:"+slug+":"+Number(amount).toFixed(2));}catch{}
  }
  async function load(){
    screen("loading");$("error").textContent="";
    if(!/^[a-z0-9][a-z0-9-]{2,46}[a-z0-9]$/.test(slug)||!window.supabaseClient){
      unavailable("Payment link not found.");return;
    }
    try{
      const {data,error}=await window.supabaseClient.rpc("v2_public_link",{p_slug:slug});
      const row=Array.isArray(data)?data[0]:data;
      if(error||!row){unavailable("This link is not taking payments.");return;}
      link={
        min_usd:Number(row.min_usd),max_usd:Number(row.max_usd),
        quick_amounts:Array.isArray(row.quick_amounts)?row.quick_amounts.map(Number):[],
        display_name:String(row.display_name||""),note:String(row.note||""),
      };
      if(link.min_usd<10||link.max_usd>1000||link.min_usd>link.max_usd)throw Error("bounds");
      $("merchant").textContent="Pay "+link.display_name;
      document.title="Pay "+link.display_name+" — CPAY";
      $("range").textContent="Choose "+money(link.min_usd)+" to "+money(link.max_usd)+".";
      $("note").textContent=link.note;$("note").hidden=!link.note;
      $("chips").replaceChildren();
      for(const amount of link.quick_amounts){
        if(!Number.isFinite(amount)||amount<link.min_usd||amount>link.max_usd)continue;
        const b=document.createElement("button");
        b.type="button";b.textContent=money(amount);
        b.onclick=()=>{$("amount").value=Number(amount).toFixed(2);$("error").textContent="";};
        $("chips").append(b);
      }
      const remembered=query.get("invoice");
      if(remembered){
        try{
          const saved=JSON.parse(sessionStorage.getItem("cpay-v2:invoice:"+remembered)||"null");
          if(saved?.id===remembered && saved?.bolt11 && saved?.expires_at){
            invoice=saved;showInvoice();return;
          }
        }catch{}
      }
      screen("entry");
    }catch{unavailable("Could not load this link. Please try again.");}
  }
  async function getToken(){
    if(!window.CPAY_TURNSTILE_SITE_KEY||!window.cpayTurnstileToken)
      throw Error("Payment verification is not configured.");
    return await window.cpayTurnstileToken("pay",{container:$("v2Turnstile")});
  }
  async function create(e){
    e.preventDefault();if(busy||!link)return;
    const amount=validateAmount($("amount").value);
    if(amount===null){$("error").textContent=$("range").textContent+" Use up to 2 decimals.";return;}
    busy=true;$("continueBtn").disabled=true;$("error").textContent="";
    try{
      const token=await getToken();
      if(!token)throw Error("Security verification failed.");
      const id=newAttempt(amount);
      const res=await withDeadline(endpoint+"?action=create",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({slug,amount:amount.toFixed(2),requestId:id,turnstileToken:token}),
      });
      const data=await res.json().catch(()=>({}));
      if(res.status===202||data.status==="creating")throw Error("Invoice is being prepared. Retry with the same amount.");
      if(!res.ok||!data.bolt11||!data.id){
        throw Error(data.error||"Could not create an invoice. Try again.");
      }
      invoice={
        id:data.id,bolt11:String(data.bolt11),amount_usd:Number(data.amount_usd),
        amount_sats:Number(data.amount_sats),expires_at:String(data.expires_at),
      };
      try{sessionStorage.setItem("cpay-v2:invoice:"+invoice.id,JSON.stringify(invoice));}catch{}
      removeAttempt(amount);
      showInvoice();
      const url=new URL(location.href);url.searchParams.set("invoice",invoice.id);
      history.replaceState(null,"",url.toString());
    }catch(ex){
      $("error").textContent=String(ex?.message||"Payment unavailable.");
    }finally{busy=false;$("continueBtn").disabled=false;}
  }
  function showInvoice(){
    if(!invoice)return;
    stop=false;screen("invoice");
    $("invoiceAmount").textContent=money(invoice.amount_usd);
    $("invoiceSats").textContent=Number(invoice.amount_sats).toLocaleString("en-US");
    $("bolt11").textContent=invoice.bolt11;
    const uri="lightning:"+invoice.bolt11;
    $("cashApp").href="https://cash.app/launch/lightning/"+encodeURIComponent(invoice.bolt11);
    $("wallet").href=uri;
    $("qr").replaceChildren();
    if(typeof window.QRCode==="function"){
      new window.QRCode($("qr"),{
        text:"LIGHTNING:"+invoice.bolt11.toUpperCase(),width:224,height:224,
        correctLevel:window.QRCode.CorrectLevel.M,
      });
    }else{$("qr").textContent="QR unavailable — copy the invoice below.";}
    clearInterval(ticker);
    ticker=setInterval(()=>{
      const left=Math.max(0,Math.ceil((Date.parse(invoice.expires_at)-Date.now())/1000));
      $("countdown").textContent=Math.floor(left/60)+":"+String(left%60).padStart(2,"0")+" remaining";
      // An invoice can still be confirmed by the node just after expiry.
      if(!left)$("invoiceStatus").textContent="Checking final payment status…";
    },1000);
    poll();
  }
  async function poll(){
    if(stop||!invoice)return;
    try{
      const res=await withDeadline(endpoint+"?action=status&id="+encodeURIComponent(invoice.id));
      const data=await res.json();
      if(res.ok){
        if(data.status==="settled"){
          stop=true;clearInterval(ticker);
          $("successAmount").textContent=money(invoice.amount_usd);
          $("receipt").textContent="Receipt "+invoice.id.slice(0,8).toUpperCase();
          screen("success");return;
        }
        if(data.status==="expired"||data.status==="failed"){
          stop=true;clearInterval(ticker);screen("expired");return;
        }
        $("invoiceStatus").textContent="Waiting for Lightning payment…";
      }else $("invoiceStatus").textContent="Connection interrupted. Retrying safely…";
    }catch{$("invoiceStatus").textContent="Status not available yet. Retrying…";}
    if(!stop)setTimeout(poll,document.hidden?10000:3000);
  }
  $("amountForm").addEventListener("submit",create);
  $("copyInvoice").onclick=async()=>{
    if(!invoice)return;
    try{await navigator.clipboard.writeText(invoice.bolt11);$("copyInvoice").textContent="Invoice copied";}
    catch{$("copyInvoice").textContent="Select the invoice text to copy";}
  };
  $("tryAgain").onclick=()=>{
    stop=true;clearInterval(ticker);invoice=null;
    const url=new URL(location.href);url.searchParams.delete("invoice");history.replaceState(null,"",url);
    screen("entry");
  };
  $("retry").onclick=load;
  load();
})();
