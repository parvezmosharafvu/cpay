// BIP39 check for a pasted 12-word seed: every word on the English list
// and the 4-bit checksum correct. Pure; never logs. The same rules run in
// the browser (public/admin-wallets.js) before anything is sent.
import { BIP39_WORDS } from "./bip39-wordlist.ts";

const INDEX = new Map(BIP39_WORDS.map((w, i) => [w, i]));

export type SeedCheck =
  | { ok: true; normalized: string }
  | { ok: false; code: "word_count" | "unknown_word" | "checksum" };

// NFKD, lower case, single spaces. Returns words only (never echo them).
export function normalizeMnemonic(raw: string): string {
  return String(raw ?? "").normalize("NFKD").toLowerCase().trim().split(/\s+/).filter(Boolean).join(" ");
}

export async function checkMnemonic12(raw: string): Promise<SeedCheck> {
  const normalized = normalizeMnemonic(raw);
  const words = normalized ? normalized.split(" ") : [];
  if (words.length !== 12) return { ok: false, code: "word_count" };
  const idx: number[] = [];
  for (const w of words) {
    const i = INDEX.get(w);
    if (i === undefined) return { ok: false, code: "unknown_word" };
    idx.push(i);
  }
  // 12 words x 11 bits = 132 bits = 128 bits entropy + 4 bits checksum.
  let bits = "";
  for (const i of idx) bits += i.toString(2).padStart(11, "0");
  const entropy = new Uint8Array(16);
  for (let b = 0; b < 16; b++) entropy[b] = parseInt(bits.slice(b * 8, b * 8 + 8), 2);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", entropy));
  const want = hash[0] >> 4;
  const got = parseInt(bits.slice(128), 2);
  bits = "";
  entropy.fill(0);
  if (want !== got) return { ok: false, code: "checksum" };
  return { ok: true, normalized };
}
