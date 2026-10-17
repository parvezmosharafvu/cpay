import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { agree, centsToMsat, currentRate, fetchRate, RateError, resetRateCache, SOURCES } from "./btc-rate.ts";

const q = (name: string, value: number) => ({ name, value });

Deno.test("two or three agreeing sources give their median", () => {
  assertEquals(agree([q("a", 100_000), q("b", 100_400)]).usdPerBtc, 100_200);
  const r = agree([q("a", 100_000), q("b", 100_400), q("c", 100_200)]);
  assertEquals(r.usdPerBtc, 100_200);
  assertEquals(r.usdPerBtcCents, 10_020_000n);
  assertEquals(r.sources.length, 3);
});

Deno.test("an outlier is dropped; disagreement or a single source gives no price", () => {
  const r = agree([q("a", 100_000), q("b", 100_300), q("c", 150_000)]);
  assertEquals(r.sources, ["a", "b"]);
  assertThrows(() => agree([q("a", 100_000), q("b", 110_000)]), RateError, "disagree");
  assertThrows(() => agree([q("a", 100_000)]), RateError, "fewer than two");
  assertThrows(() => agree([]), RateError);
});

Deno.test("cents to whole-sat millisatoshi, rounded down, exact", () => {
  const rate = agree([q("a", 100_000), q("b", 100_000)]);
  assertEquals(centsToMsat(100, rate), 1_000_000n); // $1 at $100k = 1000 sat
  assertEquals(centsToMsat(2_500, rate), 25_000_000n);
  const odd = agree([q("a", 61_234.56), q("b", 61_234.56)]);
  assertEquals(centsToMsat(1_999, odd), 32_644_000n); // 19.99 / 61234.56 * 1e8 = 32644.6 -> 32644 sat
  assertThrows(() => centsToMsat(0, rate), RateError);
  assertThrows(() => centsToMsat(1.5, rate), RateError);
});

function fakeExchanges(values: Record<string, unknown>) {
  return ((input: RequestInfo | URL) => {
    const url = String(input);
    const src = SOURCES.find((s) => s.url === url)!;
    const v = values[src.name];
    if (v === "down") return Promise.reject(new TypeError("down"));
    if (v === 500) return Promise.resolve(new Response("x", { status: 500 }));
    const body = src.name === "coinbase" ? { data: { amount: String(v) } }
      : src.name === "kraken" ? { result: { XXBTZUSD: { c: [String(v), "1"] } } }
      : { last: String(v) };
    return Promise.resolve(new Response(JSON.stringify(body)));
  }) as typeof fetch;
}

Deno.test("fetchRate reads each exchange's own shape and survives one being down", async () => {
  assertEquals((await fetchRate(fakeExchanges({ coinbase: 100_000, kraken: 100_100, bitstamp: 100_050 }))).usdPerBtc, 100_050);
  assertEquals((await fetchRate(fakeExchanges({ coinbase: "down", kraken: 100_100, bitstamp: 100_000 }))).sources, ["bitstamp", "kraken"]);
  await assertRejects(() => fetchRate(fakeExchanges({ coinbase: "down", kraken: 500, bitstamp: 100_000 })), RateError);
  await assertRejects(() => fetchRate(fakeExchanges({ coinbase: 5, kraken: "nope", bitstamp: 100_000 })), RateError);
});

Deno.test("currentRate caches for a minute", async () => {
  resetRateCache();
  let calls = 0;
  const f = ((i: RequestInfo | URL) => { calls++; return fakeExchanges({ coinbase: 100_000, kraken: 100_000, bitstamp: 100_000 })(i); }) as typeof fetch;
  await currentRate(f, 1_000_000);
  await currentRate(f, 1_030_000);
  assertEquals(calls, 3);
  await currentRate(f, 1_070_000);
  assertEquals(calls, 6);
  resetRateCache();
});
