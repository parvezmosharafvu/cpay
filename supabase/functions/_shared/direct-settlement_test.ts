import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { EXPIRY_GRACE_MS, lightningAddressProvider, merchantMessage, nextAction, providerMessage, publicStatus } from "./direct-settlement.ts";
import { type Fetch, LnurlError } from "./lnurl.ts";
import { sha256HexBytes } from "./bolt11.ts";
import { buildInvoice, randomPreimage } from "./bolt11_testkit.ts";

const EXP = 1_000_000;

Deno.test("state rules: proof pays, expiry waits for the grace period, paid is final", () => {
  const paid = { state: "paid" as const, preimage: "aa".repeat(32) };
  const notPaid = { state: "not_paid" as const };
  const unproven = { state: "unproven" as const, reason: "x" };
  assertEquals(nextAction("pending", EXP, paid, 0), { kind: "record_proof", preimage: paid.preimage });
  assertEquals(nextAction("expired", EXP, paid, EXP * 10), { kind: "record_proof", preimage: paid.preimage });
  assertEquals(nextAction("paid", EXP, paid, 0), { kind: "none" });
  assertEquals(nextAction("pending", EXP, notPaid, EXP + 1), { kind: "none" });
  assertEquals(nextAction("pending", EXP, notPaid, EXP + EXPIRY_GRACE_MS + 1), { kind: "expire" });
  assertEquals(nextAction("pending", EXP, null, EXP + EXPIRY_GRACE_MS + 1), { kind: "expire" });
  // A provider that claims settlement without proof never expires the row
  // either: it stays pending for a person to look at.
  assertEquals(nextAction("pending", EXP, unproven, EXP + EXPIRY_GRACE_MS + 1), { kind: "none" });
  assertEquals(nextAction("pending", EXP, unproven, 0), { kind: "none" });
  assertEquals(publicStatus("pending"), "new");
  assertEquals(publicStatus("paid"), "settled");
  assertEquals(publicStatus("expired"), "expired");
});

const METADATA = JSON.stringify([["text/plain", "Pay bob"]]);
async function fakeProvider(opts: { verify?: boolean; forgePreimage?: boolean } = {}) {
  const settled = new Set<string>();
  const descHash = await sha256HexBytes(new TextEncoder().encode(METADATA));
  const issued = new Map<string, string>();
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    const j = (b: unknown) => new Response(JSON.stringify(b));
    if (url.pathname === "/.well-known/lnurlp/bob") {
      return j({ tag: "payRequest", callback: "https://cb.example.net/pay/bob", minSendable: 1500, maxSendable: 1_000_000_000, metadata: METADATA });
    }
    if (url.pathname === "/pay/bob") {
      const { preimage, paymentHash } = await randomPreimage();
      issued.set(paymentHash, preimage);
      const pr = buildInvoice({ amountMsat: BigInt(url.searchParams.get("amount")!), paymentHash, descriptionHash: descHash });
      return j({ pr, verify: opts.verify === false ? undefined : `https://cb.example.net/v/${paymentHash}` });
    }
    if (url.pathname.startsWith("/v/")) {
      const h = url.pathname.slice(3);
      const done = settled.has(h);
      return j({ status: "OK", settled: done, preimage: done ? (opts.forgePreimage ? "ee".repeat(32) : issued.get(h)) : null });
    }
    return new Response("no", { status: 404 });
  }) as Fetch;
  return { f, calls, issued, settle: (h: string) => settled.add(h) };
}

Deno.test("destination check: a real unpaid test invoice at the minimum, LUD-21 required", async () => {
  const p = await fakeProvider();
  const prov = lightningAddressProvider(p.f, "bitcoin");
  const d = await prov.checkDestination(" Bob@Pay.Example.com ");
  assertEquals(d.address, "bob@pay.example.com");
  assertEquals(d.callbackHost, "cb.example.net");
  assertEquals(d.minSendableMsat, 1500n);
  assertEquals(p.calls, ["/.well-known/lnurlp/bob", "/pay/bob", `/v/${[...p.issued.keys()][0]}`]);
  const none = await fakeProvider({ verify: false });
  const e = await assertRejects(() => lightningAddressProvider(none.f, "bitcoin").checkDestination("bob@pay.example.com"), LnurlError);
  assertEquals(e.code, "no_verify");
  assertEquals((await assertRejects(() => prov.checkDestination("bob"), LnurlError)).code, "bad_address");
});

Deno.test("invoice and check: paid only with the provider's proof for that invoice", async () => {
  const p = await fakeProvider();
  const prov = lightningAddressProvider(p.f, "bitcoin");
  const inv = await prov.createInvoice("bob@pay.example.com", 21_000n);
  assertEquals(inv.invoice.amountMsat, 21_000n);
  const ref = { verifyUrl: inv.verifyUrl, paymentHash: inv.invoice.paymentHash, invoice: inv.invoice.invoice };
  assertEquals((await prov.check(ref)).state, "not_paid");
  p.settle(inv.invoice.paymentHash);
  assertEquals(await prov.check(ref), { state: "paid", preimage: p.issued.get(inv.invoice.paymentHash)! });
  // A provider that says "settled" with a preimage that does not hash to
  // the payment hash is not believed.
  const forger = await fakeProvider({ forgePreimage: true });
  const fprov = lightningAddressProvider(forger.f, "bitcoin");
  const finv = await fprov.createInvoice("bob@pay.example.com", 21_000n);
  forger.settle(finv.invoice.paymentHash);
  assertEquals((await fprov.check({ verifyUrl: finv.verifyUrl, paymentHash: finv.invoice.paymentHash, invoice: finv.invoice.invoice })).state, "unproven");
  // An amount the provider does not accept is refused before any invoice.
  assertEquals((await assertRejects(() => prov.createInvoice("bob@pay.example.com", 1000n), LnurlError)).code, "out_of_range");
});

Deno.test("messages never pass provider text to a payer", () => {
  assertEquals(providerMessage(new LnurlError("provider_error", "<script>x</script>")).includes("script"), false);
  assertEquals(merchantMessage(new LnurlError("provider_error", "<b>raw</b>")).includes("raw"), false);
  assertEquals(providerMessage(new Error("boom")), "Something went wrong. Try again in a moment.");
});
