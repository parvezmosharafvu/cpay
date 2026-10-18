import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  e2eGatewayFetch, type Fetch, fetchPayRequest, guardedFetch, hostAllowed, ipNotPublic, LnurlError, parseLightningAddress, providerHosts,
  requestInvoice, safeUrl, verifyPayment,
} from "./lnurl.ts";
import { sha256HexBytes } from "./bolt11.ts";
import { buildInvoice, randomPreimage } from "./bolt11_testkit.ts";

const ADDR = parseLightningAddress("Alice@Pay.Example.com")!;
const METADATA = JSON.stringify([["text/plain", "Pay alice"], ["text/identifier", "alice@pay.example.com"]]);
const NOW = Date.now();

type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;
function mock(routes: Record<string, Route>): Fetch & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    const r = routes[url.origin + url.pathname];
    if (!r) return new Response("no", { status: 404 });
    return await r(url, init);
  }) as Fetch & { calls: string[] };
  f.calls = calls;
  return f;
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

function payRequestBody(over: Record<string, unknown> = {}) {
  return { tag: "payRequest", callback: "https://pay.example.com/lnurlp/alice/invoice", minSendable: 1000, maxSendable: 100_000_000_000, metadata: METADATA, ...over };
}

Deno.test("Lightning addresses: canonical form, internal and odd hosts refused", () => {
  assertEquals(ADDR.address, "alice@pay.example.com");
  assertEquals(ADDR.wellKnown, "https://pay.example.com/.well-known/lnurlp/alice");
  for (const bad of ["alice", "alice@localhost", "a@127.0.0.1", "a@[::1]", "a@host.internal", "a@x.onion", "a@intranet", "a@-x.com", "a b@x.com", "a@x.local", ""]) {
    assertEquals(parseLightningAddress(bad), null, bad);
  }
  assert(hostAllowed("breez.tips"));
  assert(!hostAllowed("10.0.0.1"));
});

Deno.test("safeUrl: https on the default port only, no credentials", () => {
  assert(safeUrl("https://pay.example.com/cb?x=1"));
  for (const bad of ["http://pay.example.com/", "https://u:p@pay.example.com/", "https://pay.example.com:8443/", "https://127.0.0.1/", "ftp://x.com", 5, "https://localhost/"]) {
    assertEquals(safeUrl(bad), null, String(bad));
  }
});

Deno.test("private, loopback and reserved addresses are recognised", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe", "2001:db8::1", "ff02::1", "garbage"]) {
    assert(ipNotPublic(ip), ip);
  }
  for (const ip of ["1.1.1.1", "8.8.8.8", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) assert(!ipNotPublic(ip), ip);
});

Deno.test("guardedFetch refuses a host that resolves to a private address", async () => {
  const base = mock({ "https://pay.example.com/x": () => json({ ok: true }) });
  const priv = guardedFetch(base, () => Promise.resolve(["169.254.169.254"]));
  await assertRejects(() => priv("https://pay.example.com/x"), LnurlError, "not allowed");
  assertEquals(base.calls.length, 0);
  const pub = guardedFetch(base, () => Promise.resolve(["93.184.216.34"]));
  assertEquals((await pub("https://pay.example.com/x")).status, 200);
  await assertRejects(() => pub("https://localhost/x"), LnurlError);
});

Deno.test("guardedFetch fails closed when DNS cannot be checked", async () => {
  const base = mock({ "https://pay.example.com/x": () => json({ ok: true }) });
  const code = async (f: Fetch) => {
    try {
      await f("https://pay.example.com/x");
      return "sent";
    } catch (e) {
      return (e as LnurlError).code;
    }
  };
  assertEquals(await code(guardedFetch(base, null)), "dns_unavailable");
  assertEquals(await code(guardedFetch(base, () => Promise.reject(new Error("PermissionDenied")))), "dns_unavailable");
  assertEquals(await code(guardedFetch(base, () => Promise.resolve([]))), "unreachable");
  // One private answer among public ones is enough to refuse.
  assertEquals(await code(guardedFetch(base, () => Promise.resolve(["93.184.216.34", "::ffff:10.0.0.1"]))), "blocked_host");
  assertEquals(base.calls.length, 0);
});

Deno.test("guardedFetch: an owner list of provider hosts, exact names only", async () => {
  const base = mock({ "https://pay.example.com/x": () => json({ ok: true }), "https://evil.pay.example.com/x": () => json({ ok: true }) });
  const pub = () => Promise.resolve(["93.184.216.34"]);
  const listed = guardedFetch(base, pub, providerHosts(" Pay.Example.com., not a host, 10.0.0.1,localhost "));
  assertEquals((await listed("https://pay.example.com/x")).status, 200);
  const e = await assertRejects(() => listed("https://evil.pay.example.com/x"), LnurlError);
  assertEquals(e.code, "provider_not_allowed");
  assertEquals(providerHosts(" Pay.Example.com., not a host, 10.0.0.1,localhost "), ["pay.example.com"]);
  assertEquals(providerHosts(undefined), []);
  // No list: any public host.
  assertEquals((await guardedFetch(base, pub)("https://evil.pay.example.com/x")).status, 200);
});

Deno.test("payRequest: valid shape accepted, every malformed field refused", async () => {
  const ok = await fetchPayRequest(ADDR, mock({ [ADDR.wellKnown]: () => json(payRequestBody()) }));
  assertEquals(ok.minSendableMsat, 1000n);
  assertEquals(ok.description, "Pay alice");
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ tag: "withdrawRequest" }, "not_pay_request"],
    [{ callback: "http://pay.example.com/cb" }, "bad_callback"],
    [{ callback: "https://10.0.0.5/cb" }, "bad_callback"],
    [{ minSendable: 0 }, "bad_limits"],
    [{ minSendable: 5000, maxSendable: 1000 }, "bad_limits"],
    [{ metadata: "not json" }, "bad_metadata"],
    [{ metadata: JSON.stringify([["text/identifier", "alice@pay.example.com"]]) }, "bad_metadata"],
    [{ metadata: JSON.stringify([["text/plain", "x"], ["text/identifier", "mallory@evil.example.com"]]) }, "identifier_mismatch"],
  ];
  for (const [over, code] of cases) {
    const e = await assertRejects(() => fetchPayRequest(ADDR, mock({ [ADDR.wellKnown]: () => json(payRequestBody(over)) })), LnurlError);
    assertEquals(e.code, code, JSON.stringify(over));
  }
});

Deno.test("transport: redirects, errors, non-JSON and oversized bodies are refused", async () => {
  const run = (r: Route) => fetchPayRequest(ADDR, mock({ [ADDR.wellKnown]: r }));
  assertEquals((await assertRejects(() => run(() => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } })), LnurlError)).code, "redirect");
  assertEquals((await assertRejects(() => run(() => new Response("x", { status: 500 })), LnurlError)).code, "http_error");
  assertEquals((await assertRejects(() => run(() => new Response("<html>")), LnurlError)).code, "bad_response");
  assertEquals((await assertRejects(() => run(() => new Response("x".repeat(70_000))), LnurlError)).code, "too_large");
  assertEquals((await assertRejects(() => run(() => json({ status: "ERROR", reason: "no such user" })), LnurlError)).code, "provider_error");
  const thrower = (() => Promise.reject(new TypeError("dns"))) as unknown as Fetch;
  assertEquals((await assertRejects(() => fetchPayRequest(ADDR, thrower), LnurlError)).code, "unreachable");
});

async function provider(opts: { amountMsat?: bigint; descHash?: string; network?: "bc" | "bcrt"; expiry?: number; verify?: unknown } = {}) {
  const { preimage, paymentHash } = await randomPreimage();
  const descHash = opts.descHash ?? await sha256HexBytes(new TextEncoder().encode(METADATA));
  let seenAmount = "";
  const f = mock({
    [ADDR.wellKnown]: () => json(payRequestBody()),
    "https://pay.example.com/lnurlp/alice/invoice": (url) => {
      seenAmount = url.searchParams.get("amount") ?? "";
      const pr = buildInvoice({
        network: opts.network ?? "bc", amountMsat: opts.amountMsat ?? BigInt(seenAmount), paymentHash, descriptionHash: descHash,
        timestamp: Math.floor(NOW / 1000), expirySeconds: opts.expiry ?? 3600,
      });
      return json({ pr, routes: [], verify: opts.verify === undefined ? `https://pay.example.com/verify/${paymentHash}` : opts.verify });
    },
  });
  return { f, preimage, paymentHash, amount: () => seenAmount };
}

Deno.test("invoice: exact amount, matching description hash, right network, not about to expire", async () => {
  const p = await provider();
  const pay = await fetchPayRequest(ADDR, p.f);
  const got = await requestInvoice(pay, 21_000_000n, { network: "bitcoin", nowMs: NOW }, p.f);
  assertEquals(p.amount(), "21000000");
  assertEquals(got.invoice.amountMsat, 21_000_000n);
  assertEquals(got.invoice.paymentHash, p.paymentHash);
  assertEquals(got.verifyUrl, `https://pay.example.com/verify/${p.paymentHash}`);
});

Deno.test("invoice: a provider that changes amount, description, network or expiry is refused", async () => {
  const cases: Array<[Parameters<typeof provider>[0], string]> = [
    [{ amountMsat: 20_000_000n }, "wrong_amount"],
    [{ descHash: "00".repeat(32) }, "wrong_description"],
    [{ network: "bcrt" }, "wrong_network"],
    [{ expiry: 60 }, "expires_too_soon"],
    [{ verify: "http://pay.example.com/verify/x" }, "bad_verify"],
  ];
  for (const [opts, code] of cases) {
    const p = await provider(opts);
    const pay = await fetchPayRequest(ADDR, p.f);
    const e = await assertRejects(() => requestInvoice(pay, 21_000_000n, { network: "bitcoin", nowMs: NOW }, p.f), LnurlError);
    assertEquals(e.code, code);
  }
  const p = await provider({ verify: null });
  const pay = await fetchPayRequest(ADDR, p.f);
  assertEquals((await requestInvoice(pay, 21_000_000n, { network: "bitcoin", nowMs: NOW }, p.f)).verifyUrl, null);
  const e = await assertRejects(() => requestInvoice(pay, 500n, { network: "bitcoin", nowMs: NOW }, p.f), LnurlError);
  assertEquals(e.code, "out_of_range");
});

Deno.test("verify (LUD-21): paid only with a preimage that hashes to the payment hash", async () => {
  const { preimage, paymentHash } = await randomPreimage();
  const invoice = buildInvoice({ amountMsat: 1000n, paymentHash });
  const at = (body: unknown) => mock({ "https://pay.example.com/verify/x": () => json(body) });
  const v = (body: unknown) => verifyPayment("https://pay.example.com/verify/x", { paymentHash, invoice }, at(body));
  assertEquals(await v({ status: "OK", settled: false, preimage: null, pr: invoice }), { state: "not_paid" });
  assertEquals(await v({ status: "OK", settled: true, preimage, pr: invoice }), { state: "paid", preimage });
  assertEquals((await v({ status: "OK", settled: true, preimage: "11".repeat(32), pr: invoice })).state, "unproven");
  assertEquals((await v({ status: "OK", settled: true, preimage: null })).state, "unproven");
  assertEquals((await v({ status: "OK", settled: true, preimage, pr: buildInvoice({ amountMsat: 1000n, paymentHash: "22".repeat(32) }) })).state, "unproven");
  await assertRejects(() => v({ status: "ERROR", reason: "Not found" }), LnurlError);
  await assertRejects(() => verifyPayment("http://pay.example.com/verify/x", { paymentHash, invoice }, at({})), LnurlError);
});

Deno.test("E2E gateway fetch keeps the path and names the original host", async () => {
  let seen: { url: string; host: string | null } | null = null;
  const base = ((input: RequestInfo | URL, init?: RequestInit) => {
    seen = { url: String(input), host: new Headers(init?.headers).get("x-e2e-host") };
    return Promise.resolve(json({}));
  }) as Fetch;
  await e2eGatewayFetch("http://127.0.0.1:9999", base)("https://pay.example.com/.well-known/lnurlp/alice?x=1");
  assertEquals(seen, { url: "http://127.0.0.1:9999/.well-known/lnurlp/alice?x=1", host: "pay.example.com" });
});
