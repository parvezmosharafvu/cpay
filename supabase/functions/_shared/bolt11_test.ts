import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  Bolt11Error, bech32Decode, bech32Encode, bytesToWords, decodeBolt11, hexToBytes, preimageMatches, sha256HexBytes,
} from "./bolt11.ts";

// Test vectors from BOLT #11 ("Examples"), lightning/bolts master.
const HASH = "0001020304050607080900010203040506070809000102030405060708090102";
const DONATION =
  "lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql";
const COFFEE =
  "lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh";
const HASHED =
  "lnbc20m1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqhp58yjmdan79s6qqdhdzgynm4zwqd5d7xmw5fk98klysy043l2ahrqs9qrsgq7ea976txfraylvgzuxs8kgcw23ezlrszfnh8r6qtfpr6cxga50aj6txm9rxrydzd06dfeawfk6swupvz4erwnyutnjq7x39ymw6j38gp7ynn44";
const TESTNET =
  "lntb20m1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygshp58yjmdan79s6qqdhdzgynm4zwqd5d7xmw5fk98klysy043l2ahrqspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqfpp3x9et2e20v6pu37c5d9vax37wxq72un989qrsgqdj545axuxtnfemtpwkc45hx9d2ft7x04mt8q7y6t0k2dge9e7h8kpy9p34ytyslj3yu569aalz2xdk8xkd7ltxqld94u8h2esmsmacgpghe9k8";
const PICO =
  "lnbc9678785340p1pwmna7lpp5gc3xfm08u9qy06djf8dfflhugl6p7lgza6dsjxq454gxhj9t7a0sd8dgfkx7cmtwd68yetpd5s9xar0wfjn5gpc8qhrsdfq24f5ggrxdaezqsnvda3kkum5wfjkzmfqf3jkgem9wgsyuctwdus9xgrcyqcjcgpzgfskx6eqf9hzqnteypzxz7fzypfhg6trddjhygrcyqezcgpzfysywmm5ypxxjemgw3hxjmn8yptk7untd9hxwg3q2d6xjcmtv4ezq7pqxgsxzmnyyqcjqmt0wfjjq6t5v4khxsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsxqyjw5qcqp2rzjq0gxwkzc8w6323m55m4jyxcjwmy7stt9hwkwe2qxmy8zpsgg7jcuwz87fcqqeuqqqyqqqqlgqqqqn3qq9q9qrsgqrvgkpnmps664wgkp43l22qsgdw4ve24aca4nymnxddlnp8vh9v2sdxlu5ywdxefsfvm0fq3sesf08uf6q9a2ke0hc9j6z6wlxg5z5kqpu2v9wz";
const BAD_CHECKSUM =
  "lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpquwpc4curk03c9wlrswe78q4eyqc7d8d0xqzpuyk0sg5g70me25alkluzd2x62aysf2pyy8edtjeevuv4p2d5p76r4zkmneet7uvyakky2zr4cusd45tftc9c5fh0nnqpnl2jfll544esqchsrnt";
const TOO_SHORT =
  "lnbc1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6na6hlh";

Deno.test("spec: amountless donation invoice", () => {
  const d = decodeBolt11(DONATION);
  assertEquals(d.network, "bitcoin");
  assertEquals(d.amountMsat, null);
  assertEquals(d.timestamp, 1496314658);
  assertEquals(d.paymentHash, HASH);
  assertEquals(d.paymentSecret, "1111111111111111111111111111111111111111111111111111111111111111");
  assertEquals(d.description, "Please consider supporting this project");
  assertEquals(d.descriptionHash, null);
  assertEquals(d.expirySeconds, 3600);
});

Deno.test("spec: 2500u with a one-minute expiry", () => {
  const d = decodeBolt11(COFFEE);
  assertEquals(d.amountMsat, 250_000_000n); // 0.0025 BTC = 250 000 sat
  assertEquals(d.description, "1 cup coffee");
  assertEquals(d.expirySeconds, 60);
  assertEquals(d.expiresAtMs, (1496314658 + 60) * 1000);
});

Deno.test("spec: hashed description and milli amount", () => {
  const d = decodeBolt11(HASHED);
  assertEquals(d.amountMsat, 2_000_000_000n); // 20m = 0.02 BTC
  assertEquals(d.description, null);
  assertEquals(d.descriptionHash, "3925b6f67e2c340036ed12093dd44e0368df1b6ea26c53dbe4811f58fd5db8c1");
});

Deno.test("spec: testnet prefix, fields in another order", () => {
  const d = decodeBolt11(TESTNET);
  assertEquals(d.network, "testnet");
  assertEquals(d.paymentHash, HASH);
});

Deno.test("spec: pico-BTC amount", () => {
  assertEquals(decodeBolt11(PICO).amountMsat, 967_878_534n);
});

Deno.test("lightning: prefix and upper case are accepted", () => {
  assertEquals(decodeBolt11("lightning:" + COFFEE.toUpperCase()).paymentHash, HASH);
});

Deno.test("spec: invalid invoices are refused", () => {
  assertThrows(() => decodeBolt11(BAD_CHECKSUM), Bolt11Error, "checksum");
  assertThrows(() => decodeBolt11(TOO_SHORT), Bolt11Error);
  assertThrows(() => decodeBolt11("pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6na6hlh"), Bolt11Error);
  assertThrows(() => decodeBolt11("LNBC2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpquwpc4curk03c9wlrswe78q4eyqc7d8d0xqzpuyk0sg5g70me25alkluzd2x62aysf2pyy8edtjeevuv4p2d5p76r4zkmneet7uvyakky2zr4cusd45tftc9c5fh0nnqpnl2jfll544esqchsrnt"), Bolt11Error, "mixed case");
  assertThrows(() => decodeBolt11(""), Bolt11Error);
  assertThrows(() => decodeBolt11("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"), Bolt11Error);
});

Deno.test("round trip: an invoice built here decodes to what was put in", () => {
  const words: number[] = [];
  const ts = 1_800_000_000;
  for (let i = 6; i >= 0; i--) words.push(Math.floor(ts / 32 ** i) % 32);
  const field = (type: number, data: number[]) => [type, Math.floor(data.length / 32), data.length % 32, ...data];
  words.push(...field(1, bytesToWords(hexToBytes(HASH))));
  words.push(...field(23, bytesToWords(hexToBytes("ab".repeat(32)))));
  words.push(...field(6, [0, 28, 4])); // 900 s
  words.push(...new Array(104).fill(0)); // signature (not checked)
  const inv = bech32Encode("lnbcrt21u", words);
  const d = decodeBolt11(inv);
  assertEquals(d.network, "regtest");
  assertEquals(d.amountMsat, 2_100_000n);
  assertEquals(d.timestamp, ts);
  assertEquals(d.expirySeconds, 900);
  assertEquals(d.descriptionHash, "ab".repeat(32));
  assertEquals(bech32Decode(inv).hrp, "lnbcrt21u");
});

Deno.test("sub-millisatoshi pico amounts are refused", () => {
  const ts = [1, 1, 1, 1, 1, 1, 1];
  const inv = bech32Encode("lnbc15p", [...ts, 1, 1, 20, ...bytesToWords(hexToBytes(HASH)), ...new Array(104).fill(0)]);
  assertThrows(() => decodeBolt11(inv), Bolt11Error, "sub-millisatoshi");
});

Deno.test("preimage proof: only the true preimage matches", async () => {
  const preimage = "00".repeat(32);
  const hash = await sha256HexBytes(hexToBytes(preimage));
  assert(await preimageMatches(preimage, hash));
  assert(await preimageMatches(preimage.toUpperCase(), hash.toUpperCase()));
  assert(!(await preimageMatches("01".repeat(32), hash)));
  assert(!(await preimageMatches("zz", hash)));
  assert(!(await preimageMatches(preimage, "nothex")));
  await assertRejects(async () => { hexToBytes("abc"); return Promise.resolve(); }, Bolt11Error);
});
