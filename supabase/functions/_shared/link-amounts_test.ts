import {assertEquals} from "jsr:@std/assert@1";
import {checkLinkAmountCents} from "./link-amounts.ts";
Deno.test("legacy links are not silently restricted",()=>{
  assertEquals(checkLinkAmountCents(100,{}),null);
  assertEquals(checkLinkAmountCents(500000,{min_usd:null,max_usd:null}),null);
});
Deno.test("configured links enforce cent-accurate boundaries",()=>{
  assertEquals(checkLinkAmountCents(999,{min_usd:10,max_usd:1000}),"Enter an amount between $10.00 and $1000.00.");
  assertEquals(checkLinkAmountCents(1000,{min_usd:"10.00",max_usd:"1000.00"}),null);
  assertEquals(checkLinkAmountCents(100000,{min_usd:10,max_usd:1000}),null);
  assertEquals(checkLinkAmountCents(100001,{min_usd:10,max_usd:1000}),"Enter an amount between $10.00 and $1000.00.");
  assertEquals(checkLinkAmountCents(1250,{min_usd:"12.50",max_usd:"25.25"}),null);
  assertEquals(checkLinkAmountCents(2526,{min_usd:12.5,max_usd:25.25}),"Enter an amount between $12.50 and $25.25.");
});
Deno.test("incomplete or invalid stored bounds fail closed",()=>{
  assertEquals(checkLinkAmountCents(2000,{min_usd:10}),"Payment link amount settings unavailable");
  assertEquals(checkLinkAmountCents(2000,{min_usd:1,max_usd:1000}),"Payment link amount settings unavailable");
});
