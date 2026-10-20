import { assertEquals } from "jsr:@std/assert@1";
import { BIP39_WORDS } from "./bip39-wordlist.ts";
import { checkMnemonic12, normalizeMnemonic } from "./bip39.ts";

// Public BIP39 test vectors only.
const V1 = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const V2 = "legal winner thank year wave sausage worth useful legal winner thank yellow";

Deno.test("wordlist is the published BIP39 English list", async () => {
  assertEquals(BIP39_WORDS.length, 2048);
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(BIP39_WORDS.join("\n") + "\n")));
  assertEquals([...d].map((b) => b.toString(16).padStart(2, "0")).join(""), "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda");
});

Deno.test("valid vectors pass, normalized", async () => {
  assertEquals(await checkMnemonic12(V1), { ok: true, normalized: V1 });
  assertEquals(await checkMnemonic12("  " + V2.toUpperCase().replace(/ /g, "\n  ") + " "), { ok: true, normalized: V2 });
});

Deno.test("bad checksum, unknown word, wrong count", async () => {
  assertEquals(await checkMnemonic12(V1.replace(/about$/, "abandon")), { ok: false, code: "checksum" });
  assertEquals(await checkMnemonic12(V1.replace(/about$/, "bitcoinz")), { ok: false, code: "unknown_word" });
  assertEquals(await checkMnemonic12(V1 + " about"), { ok: false, code: "word_count" });
  assertEquals(await checkMnemonic12(""), { ok: false, code: "word_count" });
  assertEquals(normalizeMnemonic(" A  b "), "a b");
});
